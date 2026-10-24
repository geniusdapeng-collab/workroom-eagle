import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeepSeekClient, DeepSeekCompletion } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { ConsultingTaskService, createConsultingIndustryThreadExecutor, type ConsultingTaskStore, type ConsultingTaskTransaction, type TaskThread,
  type TaskStoredEvent, type ConsultingExecutionDependencies } from "./task-execution.js";
import { PublicSourceVault } from "./public-sources.js";
import { ConsultingWorkflow, DraftVault, loadConsultingWorkforce, type Scope, type Workforce,
  type WorkflowStore, type StoreTransaction, type StoredEvent } from "./workflow.js";
import { ConsultingError, sha256 } from "./workflow-core.js";

const scope = { tenantId: "task-unit-tenant", workspaceId: "task-unit-workspace" };
const otherScope = { tenantId: "other-unit-tenant", workspaceId: "other-unit-workspace" };
const goal = "做一个温州地区制造业的分析报告";
let catalog: Workforce;
const dirs: string[] = [];
beforeAll(async () => { catalog = await loadConsultingWorkforce(); });
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class MemoryTasks implements ConsultingTaskStore {
  threads = new Map<string, TaskThread>();
  events = new Map<string, TaskStoredEvent[]>();
  private queues = new Map<string, Promise<void>>();
  private count = 0;
  loseReportAcknowledgement = false;
  key(sc: Scope, threadId: string) { return `${sc.tenantId}:${sc.workspaceId}:${threadId}`; }
  add(threadId: string) {
    this.threads.set(this.key(scope, threadId), { id: threadId, title: goal, status: "running", createdBy: "unit-owner", mode: "quest" });
  }
  async transaction<T>(sc: Scope, threadId: string, body: (tx: ConsultingTaskTransaction) => Promise<T>): Promise<T> {
    const key = this.key(sc, threadId); const preceding = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(key, preceding.then(() => pending)); await preceding;
    try {
      const current = this.threads.get(key); if (!current) throw new ConsultingError("NOT_FOUND", "单元工作区无此任务");
      const events = structuredClone(this.events.get(key) ?? []); const thread = structuredClone(current);
      const result = await body({ thread, events,
        append: async (action, data, actorId, receipt) => {
          const event = { eventId: `E-${++this.count}`, hash: sha256(JSON.stringify({ action, data, actorId, receipt })),
            at: "2026-10-24T01:00:00.000Z", action, data };
          events.push(event); return event;
        },
        project: async (projection) => { Object.assign(thread, projection); },
      });
      this.threads.set(key, thread); this.events.set(key, events);
      if (this.loseReportAcknowledgement && events.some((event) => event.action === "consulting.task.report.ready")) {
        this.loseReportAcknowledgement = false; throw new Error("unit durable report COMMIT acknowledgement lost");
      }
      return result;
    } finally { release(); }
  }
}

class MemoryWorkflows implements WorkflowStore {
  streams = new Map<string, StoredEvent[]>(); count = 0;
  constructor(private tasks: MemoryTasks) {}
  async transaction<T>(sc: Scope, stream: string, body: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    const key = `${sc.tenantId}:${sc.workspaceId}:${stream}`;
    const events = structuredClone(this.streams.get(key) ?? []);
    const result = await body({ events,
      append: async (input) => { const event = { eventId: `E-${1000 + ++this.count}`, hash: sha256(JSON.stringify(input)),
        at: "2026-10-24T01:00:00.000Z", action: input.action, data: input.data }; events.push(event); return event; },
      assertEmployee: async () => [],
      assertTaskControl: async (threadId: string, executionId?: string) => {
        const events = this.tasks.events.get(this.tasks.key(sc, threadId)) ?? [];
        const state = [...events].reverse().map((event) => event.data.state as { control?: string; execution?: { id: string } | null } | undefined).find(Boolean);
        if (state?.control === "human_required") throw new ConsultingError("TASK_HUMAN_REQUIRED", "任务已转人工");
        if (state?.control === "cancelled") throw new ConsultingError("TASK_CANCELLED", "任务已停止");
        if (!executionId) throw new ConsultingError("TASK_EXECUTION_REQUIRED", "仅父任务执行可推进");
        if (state?.execution?.id !== executionId) throw new ConsultingError("TASK_EXECUTION_CLAIM_LOST", "父任务执行认领不匹配");
      },
    });
    this.streams.set(key, events); return result;
  }
}

function completion(text: string, index: number): DeepSeekCompletion {
  return { text, model: "deepseek-flash", requestedModel: "deepseek-flash", provider: "deepseek", requestId: `unit-provider-${index}`,
    reservationId: `unit-reservation-${index}`, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, finishReason: "stop",
    modelMetadata: { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash-1017", contextWindow: 1048576, maxOutputTokens: 393216,
      verifiedAt: "2026-10-24T01:00:00.000Z", tokenizerProof: { source: "https://example.invalid/unit-fixture", artifactSha256: "0".repeat(64),
        reviewedOn: "2026-10-24", modelVersion: "local unit fixture", algorithm: "no paid request", framingAllowance: 1024 } } };
}

async function fixture(threadId = "T-UNIT-REPORT") {
  const base = await mkdtemp(join(tmpdir(), "eagle-task-execution-unit-")); dirs.push(base);
  const store = new MemoryTasks(); store.add(threadId); const workflowStore = new MemoryWorkflows(store);
  const calls = { search: 0, fetch: 0, complete: 0 };
  const hooks: { afterFetch?: () => Promise<void>; afterModel?: (index: number) => Promise<void>; failModelAt?: number; bundleReady?: boolean } = {};
  const client = {
    search: async () => { calls.search++; return { results: [1, 2].map((i) => ({ title: `单元夹具官方资料${i}`,
      url: `https://unit${i}.wenzhou.gov.cn/research.html`, snippet: "这是单元夹具", summary: "不可作为真实温州经营数据", date: null, authority: 3 })),
      verified: true, provider: "deepseek", retrievedAt: "2026-10-24T01:00:00.000Z", reservationId: "unit-search-reservation" }; },
    fetchPage: async ({ url }: { url: string }) => {
      calls.fetch++; const result = { url, title: "明确标注的单元夹具来源", content: "本页为温州制造业公开研究的单元夹具，并非真实统计。\n\n本单元夹具2025年制造业增长8%，需求仍需核实；政策目标与历史完成值不可混用。",
        provider: "deepseek", retrievedAt: "2026-10-24T01:00:01.000Z", reservationId: `unit-fetch-reservation-${calls.fetch}` };
      await hooks.afterFetch?.(); return result;
    },
    complete: async (input: { system?: string; prompt: string }) => {
      const index = ++calls.complete;
      if (hooks.failModelAt === index) throw Object.assign(new Error("unit unknown provider result"), { code: "PROVIDER_NETWORK" });
      let answer: unknown;
      if (input.system?.includes("任务分解器")) {
        answer = { rationale: "单元夹具先核原文口径，再从行业、运营、战略分析，最后成稿与独立质检。",
          steps: ["diagnosis-analyst", "industry-veteran", "ops-lean-counselor", "strategy-counselor", "report-composer", "quality-officer"]
            .map((employeeKey) => ({ employeeKey, skillId: catalog.employees.get(employeeKey)!.skills[0] ?? null,
              objective: "仅依据冻结的公开来源夹具形成可审阅且有引用的研究素材" })) };
      } else {
        const start = input.prompt.indexOf("：", input.prompt.indexOf("原始授权资料")) + 1;
        const end = input.prompt.indexOf("\n全部前序", start);
        const sources = JSON.parse(input.prompt.slice(start, end)) as Array<{ id: string; content: string }>;
        answer = { summary: `第${index - 1}步单元夹具研究：公开资料只证明已披露的口径，不能推定企业盈利。`,
          findings: [{ claim: "单元夹具仅提供行业层面的公开线索，不能推出企业个体经营结果。",
            evidence: [{ sourceId: sources[0]!.id, quote: sources[0]!.content.slice(0, 35) }], counterEvidence: "单元夹具没有企业级订单、成本和现金流水。" }],
          recommendations: [{ action: "人类顾问复核原文口径与报告期间后，再形成客户适用建议。", basis: [sources[0]!.id], owner: "人类顾问",
            verification: "来源、报告期间、推断与缺失证据均能逐项回溯。" }], missingEvidence: ["企业级经营资料"], humanReviewRequired: true };
      }
      await hooks.afterModel?.(index); return completion(JSON.stringify(answer), index);
    },
    getBudget: () => ({ schemaVersion: "eagle.deepseek-budget/v1", frozen: false, llmAttempts: calls.complete }),
  } as unknown as DeepSeekClient;
  const contexts: Array<{ scope: Scope; threadId: string; requestId?: string }> = [];
  const context = (input: { scope: Scope; threadId: string; requestId?: string }) => { contexts.push(input); return {
    client, taskIdentity: `unit:${input.requestId ?? input.threadId}`, budgetFile: join(base, "unit-budget-not-created.json"),
  }; };
  const dependencies: ConsultingExecutionDependencies = { store, vault: new PublicSourceVault(join(base, "public")), context,
    activeBundle: async () => hooks.bundleReady !== false,
    workflow: ({ client: currentClient }, parentThreadId, parentExecutionId) => new ConsultingWorkflow({ store: workflowStore, workforce: async () => catalog,
      model: () => currentClient, vault: new DraftVault(join(base, "workflow")), assertBundle: async () => undefined, parentThreadId, parentExecutionId }),
  };
  const service = new ConsultingTaskService(dependencies);
  const input = { threadId, goal, actorId: "unit-owner", presetKey: "chief-of-staff", requestId: "11111111-1111-4111-8111-111111111111" };
  return { base, store, workflowStore, client, service, calls, input, hooks, contexts,
    handler: createConsultingIndustryThreadExecutor(dependencies) };
}

describe("consulting native task execution (local real workflow and file fixtures; no production provider)", () => {
  it("does not reclassify legacy generic threads or bypass explicit agent-mode step confirmation", async () => {
    const f = await fixture("T-UNIT-LEGACY");
    const handler = createConsultingIndustryThreadExecutor({ store: f.store, activeBundle: async () => true,
      vault: new PublicSourceVault(join(f.base, "mode-fixture")),
      context: () => ({ client: f.client, taskIdentity: "mode-unit-fixture", budgetFile: join(f.base, "not-created.json") }),
      workflow: ({ client }, parentThreadId, parentExecutionId) => new ConsultingWorkflow({ store: f.workflowStore, workforce: async () => catalog,
        model: () => client, vault: new DraftVault(join(f.base, "workflow")), assertBundle: async () => undefined, parentThreadId, parentExecutionId }),
    });
    const legacy = await handler({ scope, input: { threadId: f.input.threadId, goal, actorId: "unit-owner", mode: "quest" },
      presetKey: "chief-of-staff", taskContext: { threadId: f.input.threadId } });
    expect(legacy).toBeUndefined();
    const agent = await handler({ scope, input: { threadId: f.input.threadId, goal, actorId: "unit-owner", mode: "agent" },
      presetKey: "chief-of-staff", taskContext: { threadId: f.input.threadId, requestId: f.input.requestId } });
    expect(agent).toBeUndefined(); expect(f.calls).toEqual({ search: 0, fetch: 0, complete: 0 });
  });
  it("uses one stable context for source collection and all six roles, publishes a real file receipt and reads the complete draft", async () => {
    const f = await fixture(); const result = await f.service.execute(scope, f.input);
    expect(result).toMatchObject({ status: "completed", stepsDone: 6, stepsTotal: 6, executionSource: "consulting-report", unverified: [] });
    expect(f.calls).toEqual({ search: 1, fetch: 2, complete: 7 });
    expect(f.contexts.every((context) => context.threadId === f.input.threadId && context.requestId === f.input.requestId)).toBe(true);
    const view = await f.service.view(scope, f.input.threadId);
    expect(view.status).toBe("draft_ready"); expect(view.humanReviewRequired).toBe(true); expect(view.sources).toHaveLength(2);
    expect(view.finalArtifact).toMatchObject({ kind: "report", synced: true }); expect(view.lastReceipt?.synced).toBe(true);
    const report = await f.service.report(scope, f.input.threadId);
    expect(sha256(report.content)).toBe(report.sha256); expect(Buffer.byteLength(report.content)).toBe(report.bytes);
    expect(report.receipt.eventId).toBe(view.finalArtifact!.eventId); expect(report.receipt.synced).toBe(true);
    expect(report.content).toContain("待人类顾问审阅"); expect(report.content).toContain("公开来源与采集范围");
    expect(report.content).toContain("独立质检"); expect(report.content).toContain("unit1.wenzhou.gov.cn");
    expect(report.content).toContain("第6步单元夹具研究");
    expect([...f.store.events.values()].flat().some((event) => event.action === "thread.execution.bound" && event.data.executionSource === "consulting-report")).toBe(true);
  });

  it("reopening the task and reading/downloading its report does not infer or search again", async () => {
    const f = await fixture("T-UNIT-REPEAT"); await f.service.execute(scope, f.input);
    const first = await f.service.report(scope, f.input.threadId); const counts = { ...f.calls };
    await f.service.execute(scope, f.input); await f.service.view(scope, f.input.threadId);
    const next = await f.service.report(scope, f.input.threadId);
    expect(next).toEqual(first); expect(f.calls).toEqual(counts);
  });

  it("persists handoff before another source call; resume uses the same source/run identities and preserves the action receipt", async () => {
    const f = await fixture("T-UNIT-HANDOFF"); let handed = false;
    f.hooks.afterFetch = async () => {
      if (handed) return; handed = true;
      const first = await f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "handoff", idempotencyKey: "unit-handoff-once", reason: "单元夹具转人工" });
      const repeat = await f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "handoff", idempotencyKey: "unit-handoff-once", reason: "单元夹具转人工" });
      expect(first.actionReceipt).toEqual(repeat.actionReceipt); expect(first.actionReceipt?.synced).toBe(true);
    };
    expect((await f.service.execute(scope, f.input)).status).toBe("paused");
    expect(f.calls).toEqual({ search: 1, fetch: 1, complete: 0 });
    const paused = await f.service.view(scope, f.input.threadId);
    expect(paused.status).toBe("human_required"); expect(paused.availableActions.resume.enabled).toBe(true);
    const resumed = await f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "resume", idempotencyKey: "unit-resume-once" });
    expect(resumed.actionReceipt?.synced).toBe(true);
    expect((await f.service.execute(scope, f.input)).status).toBe("completed");
    expect(f.calls).toEqual({ search: 1, fetch: 2, complete: 7 });
  });

  it("stopping during a paid-step fixture keeps that original receipt and prohibits every later step including direct advance", async () => {
    const f = await fixture("T-UNIT-STOP");
    f.hooks.afterModel = async (index) => { if (index === 2) await f.service.action(scope, "unit-owner", {
      threadId: f.input.threadId, action: "cancel", idempotencyKey: "unit-stop-once", reason: "单元夹具停止后续执行" }); };
    expect((await f.service.execute(scope, f.input)).status).toBe("cancelled");
    expect(f.calls.complete).toBe(2);
    const stopped = await f.service.view(scope, f.input.threadId);
    expect(stopped.status).toBe("cancelled"); expect(stopped.finalArtifact).toBeNull(); expect(stopped.stepsDone).toBe(1);
    expect(stopped.availableActions.resume.enabled).toBe(false);
    const direct = new ConsultingWorkflow({ store: f.workflowStore, workforce: async () => catalog, model: () => f.client,
      vault: new DraftVault(join(f.base, "workflow")), assertBundle: async () => undefined });
    await expect(direct.advance(scope, "unit-owner", { runId: stopped.runId!, idempotencyKey: "attempted-direct-stop-bypass" })).rejects.toMatchObject({ code: "TASK_CANCELLED" });
    await f.service.execute(scope, f.input); expect(f.calls.complete).toBe(2);
  });

  it("an opaque provider failure stays blocked and is not repurchased through a different control key", async () => {
    const f = await fixture("T-UNIT-UNKNOWN"); f.hooks.failModelAt = 3;
    expect((await f.service.execute(scope, f.input)).status).toBe("failed");
    const blocked = await f.service.view(scope, f.input.threadId);
    expect(blocked.status).toBe("blocked"); expect(blocked.error?.code).toBe("PROVIDER_NETWORK");
    expect(blocked.finalArtifact).toBeNull(); expect(blocked.availableActions.resume.enabled).toBe(false);
    await f.service.execute(scope, f.input); expect(f.calls.complete).toBe(3);
    await expect(f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "resume", idempotencyKey: "cannot-buy-another-answer" }))
      .rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
  });

  it("empty sources, private dossiers and external-send instructions cannot become fake completed reports", async () => {
    const f = await fixture("T-UNIT-EMPTY"); f.client.search = async () => ({ results: [], verified: false, provider: "deepseek", retrievedAt: "2026-10-24T01:00:00Z", reservationId: "unit-empty" });
    expect((await f.service.execute(scope, f.input)).status).toBe("failed"); expect(f.calls.complete).toBe(0);
    expect((await f.service.view(scope, f.input.threadId)).error?.code).toBe("PUBLIC_SOURCES_MISSING");
    await expect(f.service.report(scope, f.input.threadId)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    const privateJob = await fixture("T-UNIT-PRIVATE");
    const blocked = await privateJob.service.execute(scope, { ...privateJob.input, goal: "根据客户内部报表做一份分析报告并发送给客户" });
    expect(blocked.status).toBe("failed"); expect(privateJob.calls).toEqual({ search: 0, fetch: 0, complete: 0 });
    expect((await privateJob.service.view(scope, privateJob.input.threadId)).availableActions.handoff.enabled).toBe(true);
  });

  it("tenant isolation, task-input drift and action-idempotency conflicts fail without another inference", async () => {
    const f = await fixture("T-UNIT-SCOPE"); await f.service.execute(scope, f.input); const calls = { ...f.calls };
    await expect(f.service.view(otherScope, f.input.threadId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.service.report(otherScope, f.input.threadId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.service.execute(scope, { ...f.input, goal: "改成另一个地区的新行业分析报告" })).rejects.toMatchObject({ code: "TASK_INPUT_DRIFT" });
    await f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "handoff", idempotencyKey: "same-control-key", reason: "先请人复核" });
    await expect(f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "cancel", idempotencyKey: "same-control-key", reason: "不同动作" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" }); expect(f.calls).toEqual(calls);
  });

  it("report hash failure does not turn a previously completed thread into verified download success", async () => {
    const f = await fixture("T-UNIT-TAMPER"); await f.service.execute(scope, f.input);
    const event = [...f.store.events.values()].flat().find((item) => item.action === "consulting.task.report.ready")!;
    const file = event.data.file as { path: string }; await writeFile(file.path, "unit tampered report");
    await expect(f.service.report(scope, f.input.threadId)).rejects.toMatchObject({ code: "PUBLIC_SOURCE_HASH_MISMATCH" });
  });

  it("lost report COMMIT acknowledgement reads the durable report without generating another answer", async () => {
    const f = await fixture("T-UNIT-ACK"); f.store.loseReportAcknowledgement = true;
    expect((await f.service.execute(scope, f.input)).status).toBe("completed");
    expect((await f.service.report(scope, f.input.threadId)).receipt.synced).toBe(true); expect(f.calls.complete).toBe(7);
    expect([...f.store.events.values()].flat().filter((event) => event.action === "consulting.task.report.ready")).toHaveLength(1);
  });
  it.each(["source", "analysis"] as const)("%s in flight cannot be resumed or reentered before the original receipt settles", async phase => {
    const f = await fixture(`T-UNIT-INFLIGHT-${phase}`);
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    if (phase === "source") f.hooks.afterFetch = async () => { if (f.calls.fetch === 1) { entered(); await paused; } };
    else f.hooks.afterModel = async index => { if (index === 2) { entered(); await paused; } };
    const original = f.service.execute(scope, f.input); await waiting;
    try {
      const counts = { ...f.calls };
      expect((await f.service.execute(scope, f.input)).status).toBe("running"); expect(f.calls).toEqual(counts);
      if (phase === "analysis") {
        const current = await f.service.view(scope, f.input.threadId);
        const direct = new ConsultingWorkflow({ store: f.workflowStore, workforce: async () => catalog, model: () => f.client,
          vault: new DraftVault(join(f.base, "workflow")), assertBundle: async () => undefined });
        await expect(direct.advance(scope, "unit-owner", { runId: current.runId!, idempotencyKey: "cannot-race-parent-execution" }))
          .rejects.toMatchObject({ code: "TASK_EXECUTION_REQUIRED" });
        await expect(direct.pauseOrResume(scope, "unit-owner", { runId: current.runId!, idempotencyKey: "cannot-pause-parent-behind-task" }, true))
          .rejects.toMatchObject({ code: "TASK_EXECUTION_REQUIRED" });
      }
      await f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "handoff", idempotencyKey: "inflight-handoff" });
      expect((await f.service.view(scope, f.input.threadId)).availableActions.resume.enabled).toBe(false);
      await expect(f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "resume", idempotencyKey: "premature-resume" }))
        .rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
      expect((await f.service.execute(scope, f.input)).status).toBe("paused"); expect(f.calls).toEqual(counts);
    } finally { release(); await original; }
    expect((await f.service.view(scope, f.input.threadId)).availableActions.resume.enabled).toBe(true);
    await f.service.action(scope, "unit-owner", { threadId: f.input.threadId, action: "resume", idempotencyKey: "settled-resume" });
    expect((await f.service.execute(scope, f.input)).status).toBe("completed"); expect(f.calls).toEqual({ search: 1, fetch: 2, complete: 7 });
  });
  it.each(["source", "planning"] as const)("a bundle change during %s settles only the original call and keeps the industry binding", async phase => {
    const f = await fixture(`T-UNIT-BUNDLE-${phase}`);
    if (phase === "source") f.hooks.afterFetch = async () => { if (f.calls.fetch === 1) f.hooks.bundleReady = false; };
    else f.hooks.afterModel = async index => { if (index === 1) f.hooks.bundleReady = false; };
    expect((await f.service.execute(scope, f.input)).status).toBe("failed");
    const view = await f.service.view(scope, f.input.threadId);
    expect(view.error?.code).toBe("BUNDLE_NOT_READY"); expect(view.finalArtifact).toBeNull();
    expect(f.calls).toEqual(phase === "source" ? { search: 1, fetch: 1, complete: 0 } : { search: 1, fetch: 2, complete: 1 });
    const repeat = await f.handler({ scope, input: { ...f.input, mode: "quest" }, presetKey: f.input.presetKey,
      taskContext: { threadId: f.input.threadId, requestId: f.input.requestId } });
    expect(repeat).toMatchObject({ status: "failed", executionSource: "consulting-report" });
  });
  it("a finished industry report stays readable after a bundle change while an unbound nonconsulting task stays generic", async () => {
    const f = await fixture("T-UNIT-BUNDLE-HISTORY"); await f.service.execute(scope, f.input); f.hooks.bundleReady = false;
    const previous = { ...f.calls };
    expect(await f.handler({ scope, input: { ...f.input, mode: "quest" }, presetKey: f.input.presetKey,
      taskContext: { threadId: f.input.threadId, requestId: f.input.requestId } })).toMatchObject({ status: "completed", executionSource: "consulting-report" });
    expect((await f.service.report(scope, f.input.threadId)).receipt.synced).toBe(true); expect(f.calls).toEqual(previous);
    const other = await fixture("T-UNIT-BUNDLE-UNBOUND"); other.hooks.bundleReady = false;
    expect(await other.handler({ scope, input: { ...other.input, mode: "quest" }, presetKey: other.input.presetKey,
      taskContext: { threadId: other.input.threadId, requestId: other.input.requestId } })).toBeUndefined();
    expect(other.calls).toEqual({ search: 0, fetch: 0, complete: 0 });
  });
});
