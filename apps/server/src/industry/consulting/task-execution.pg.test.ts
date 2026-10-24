/** Production task/workflow stores and gateway against isolated PostgreSQL/RLS; only provider answers are free fixtures. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools, withWorkspace } from "@workloom/db";
import type { Identity } from "@workloom/base/tenancy";
import type { DeepSeekClient, DeepSeekCompletion } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { getConsultingExecutionContext } from "./execution-context.js";
import { ConsultingTaskService, PgConsultingTaskStore, createConsultingIndustryThreadExecutor, type ConsultingExecutionDependencies } from "./task-execution.js";
import { ConsultingWorkflow, DraftVault, PgWorkflowStore, loadConsultingWorkforce, type Scope, type Workforce } from "./workflow.js";
import { ConsultingError, sha256 } from "./workflow-core.js";
import { currentMemberAuthority } from "../../service/access-authority.js";
import { consultingRouter } from "./router.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.DATABASE_APP_URL) && Boolean(process.env.DATABASE_GATEWAY_URL);
const goal = "做一个温州地区制造业的分析报告";
describe.runIf(RUN_DB)("consulting native report: real isolated PG/RLS, control and immutable files (free provider fixtures)", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const suffix = randomUUID();
  const scope = { tenantId: `tenant-report-${suffix}`, workspaceId: `ws-report-${suffix}` };
  const other = { tenantId: `tenant-report-other-${suffix}`, workspaceId: `ws-report-other-${suffix}` };
  const previousSupportDir = process.env.WORKLOOM_SUPPORT_DIR;
  const identity = (target = scope): Identity => ({ kind: "member", memberId: `member-${target.workspaceId}`,
    memberNo: "FIXTURE-OWNER", name: "隔离报告成员", role: "owner", plan: "pro", ...target });
  const caller = (claim: Identity | null) => consultingRouter.createCaller({ session: claim, identity: claim, partnerIdentity: null, headers: new Headers() });
  let directory: string; let catalog: Workforce; let sequence = 0;
  const thread = async (target: Scope = scope) => {
    const id = `T-PG-${suffix}-${++sequence}`;
    await owner.query(`INSERT INTO threads(id,tenant_id,workspace_id,title,mode,status,created_by)
      VALUES($1,$2,$3,$4,'quest','running','FIXTURE-OWNER')`, [id, target.tenantId, target.workspaceId, goal]);
    return id;
  };
  const rows = async (threadId: string, target = scope) => withWorkspace(app, target, async (_db, connection) =>
    (await connection.query(`SELECT event_id,hash,session_id,payload FROM biz_events
      WHERE tenant_id=$1 AND workspace_id=$2 AND (session_id=$3 OR payload#>>'{decision,after,parentThreadId}'=$3)
      ORDER BY seq`, [scope.tenantId, scope.workspaceId, threadId])).rows);
  const projection = async (threadId: string) => withWorkspace(app, scope, async (_db, connection) =>
    (await connection.query(`SELECT status,current_action,error,progress_done,progress_total,plan,plan_version FROM threads WHERE id=$1`, [threadId])).rows[0]);
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "eagle-report-pg-")); process.env.WORKLOOM_SUPPORT_DIR = directory;
    catalog = await loadConsultingWorkforce();
    for (const target of [scope, other]) {
      await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'隔离公开报告夹具','pro')", [target.tenantId]);
      await owner.query(`INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage)
        VALUES($1,$2,'隔离公开报告夹具',$1,'consulting','operating')`, [target.workspaceId, target.tenantId]);
      await owner.query(`INSERT INTO profiles(workspace_id,tenant_id,industry,archive)
        VALUES($1,$2,'consulting','{"dataMode":"real","fixture":true}')`, [target.workspaceId, target.tenantId]);
      await owner.query(`INSERT INTO members(id,workspace_id,member_no,name,role,status)
        VALUES($1,$2,'FIXTURE-OWNER','隔离报告成员','owner','active')`, [identity(target).memberId, target.workspaceId]);
      for (const employee of catalog.employees.values()) {
        await owner.query(`INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,readonly,fence_bindings,skills,status,meta)
          VALUES($1,$2,$3,$4,'v1.0','coordinator',$5,$6,$7,'ready',$8)`,
        [`fixture-${target.workspaceId}-${employee.key}`, target.workspaceId, employee.key, employee.name, employee.readonly,
          JSON.stringify(employee.fenceBindings), JSON.stringify(employee.skills), JSON.stringify({ prompt: { role: employee.role }, fixture: true })]);
      }
      for (const [skill, body] of catalog.skills) {
        const skillId = `fixture-${suffix}-${skill}`;
        await owner.query(`INSERT INTO skills(id,level,bundle,name,body,desensitized)
          VALUES($1,'industry','consulting',$2,$3,true) ON CONFLICT(id) DO NOTHING`, [skillId, skill, body]);
        await owner.query(`INSERT INTO skill_installs(skill_id,workspace_id,installed_by) VALUES($1,$2,'FIXTURE-OWNER')`, [skillId, target.workspaceId]);
      }
    }
  }, 30000);
  afterAll(async () => {
    if (previousSupportDir === undefined) delete process.env.WORKLOOM_SUPPORT_DIR; else process.env.WORKLOOM_SUPPORT_DIR = previousSupportDir;
    await closeAllPools(); await Promise.all([owner.end(), app.end()]);
    if (directory) await rm(directory, { recursive: true, force: true });
    // Append-only evidence and its random, fixture-labelled scopes intentionally remain in the isolated test database.
  });
  const completion = (text: string, requestId: string): DeepSeekCompletion => ({
    text, model: "deepseek-flash", requestedModel: "deepseek-flash", provider: "deepseek", requestId,
    reservationId: `fixture-reservation-${requestId}`, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    modelMetadata: { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash-1017", contextWindow: 1048576, maxOutputTokens: 393216,
      verifiedAt: "2026-10-24T01:00:00.000Z", tokenizerProof: { source: "local free fixture", artifactSha256: "a".repeat(64),
        reviewedOn: "2026-10-24", modelVersion: "local free fixture", algorithm: "no supplier request", framingAllowance: 1024 } },
  });
  async function fixture(taskStore?: PgConsultingTaskStore) {
    const threadId = await thread(); const requestId = randomUUID();
    const calls = { search: 0, fetch: 0, complete: 0 };
    const hooks: { afterFetch?: () => Promise<void>; afterModel?: (index: number) => Promise<void>; failModelAt?: number; bundleReady?: boolean } = {};
    const client = {
      search: async () => { calls.search++; return { provider: "deepseek", retrievedAt: "2026-10-24T01:00:00Z",
        reservationId: `fixture-search-${threadId}`, verified: true,
        results: [1, 2].map(index => ({ title: `隔离公开资料夹具${index}`, url: `https://fixture${index}.wenzhou.gov.cn/research.html`,
          snippet: "PG隔离夹具", summary: "非实际温州经营数据", date: null, authority: 3 })) }; },
      fetchPage: async ({ url }: { url: string }) => { calls.fetch++;
        const result = { url, title: "PG隔离公开研究夹具", provider: "deepseek", retrievedAt: "2026-10-24T01:00:01Z",
          reservationId: `fixture-fetch-${threadId}-${calls.fetch}`,
          content: "温州制造业公开研究PG隔离夹具，非真实统计资料。\n\n本夹具2025年制造业增长8%，需求尚未核实；下一年的政策目标不能作为已经完成的历史事实。" };
        await hooks.afterFetch?.(); return result;
      },
      complete: async (input: { system?: string; prompt: string }) => {
        const index = ++calls.complete;
        if (hooks.failModelAt === index) throw Object.assign(new Error("PG fixture unknown provider result"), { code: "PROVIDER_NETWORK" });
        const answer = input.system?.includes("任务分解器") ? {
          rationale: "隔离夹具从原文口径、行业、运营、战略依次分析，再汇编报告与独立质检。",
          steps: ["diagnosis-analyst", "industry-veteran", "ops-lean-counselor", "strategy-counselor", "report-composer", "quality-officer"]
            .map(employeeKey => ({ employeeKey, skillId: catalog.employees.get(employeeKey)!.skills[0] ?? null,
              objective: "依据已冻结的公开研究夹具形成有准确引用且可供人类复核的分析稿" })),
        } : (() => {
          const start = input.prompt.indexOf("：", input.prompt.indexOf("原始授权资料")) + 1;
          const sources = JSON.parse(input.prompt.slice(start, input.prompt.indexOf("\n全部前序", start))) as Array<{ id: string; content: string }>;
          return { summary: `PG隔离夹具第${index - 1}步：公开行业线索不等于客户个体经营结论。`,
            findings: [{ claim: "当前资料仅提供行业公开线索，需要核对报告期间与统计范围。",
              evidence: [{ sourceId: sources[0]!.id, quote: sources[0]!.content.slice(0, 35) }], counterEvidence: "未取得企业经营流水与订单成本原件。" }],
            recommendations: [{ action: "由人类顾问逐项核对来源、口径和推断后再用于客户讨论。", basis: [sources[0]!.id], owner: "人类顾问",
              verification: "原始正文、摘录范围、报告期间与推断均可逐项回溯。" }], missingEvidence: ["企业个体经营证据"], humanReviewRequired: true };
        })();
        await hooks.afterModel?.(index); return completion(JSON.stringify(answer), `fixture-model-${threadId}-${index}`);
      },
      getBudget: () => ({ schemaVersion: "eagle.deepseek-budget/v1", frozen: false, llmAttempts: calls.complete }),
    } as unknown as DeepSeekClient;
    const draftVault = new DraftVault(join(directory, "workflow"));
    const workflowStore = new PgWorkflowStore(() => app);
    const context = (input: { scope: Scope; threadId: string; requestId?: string }) => getConsultingExecutionContext({ ...input,
      supportDir: directory, clientFactory: () => client });
    const dependencies: ConsultingExecutionDependencies = { store: taskStore ?? new PgConsultingTaskStore(() => app), context, activeBundle: async () => hooks.bundleReady !== false,
      workflow: ({ client: scopedClient }, parentThreadId, parentExecutionId) => new ConsultingWorkflow({ store: workflowStore, vault: draftVault,
        workforce: async () => catalog, model: () => scopedClient, assertBundle: async () => undefined,
        parentThreadId, parentExecutionId, sourceTrust: "public-source-excerpts-unverified" }),
    };
    const service = new ConsultingTaskService(dependencies);
    const direct = new ConsultingWorkflow({ store: workflowStore, vault: draftVault, workforce: async () => catalog,
      model: () => client, assertBundle: async () => undefined });
    return { service, reopen: () => new ConsultingTaskService(dependencies), direct, calls, hooks,
      handler: createConsultingIndustryThreadExecutor(dependencies),
      inactiveHandler: createConsultingIndustryThreadExecutor({ ...dependencies, activeBundle: async () => false }),
      input: { threadId, goal, actorId: "FIXTURE-OWNER", presetKey: "chief-of-staff", requestId } };
  }
  // Read-only cases share an independently initialized completed report. This
  // helper also works with `-t`: no test depends on an earlier test having run.
  // Mutating/tamper/control cases always allocate their own task.
  let readonlyFixture: ReturnType<typeof fixture> | undefined;
  const completedFixture = () => readonlyFixture ??= fixture().then(async f => {
    expect(await f.service.execute(scope, f.input)).toMatchObject({ status: "completed", stepsDone: 6, stepsTotal: 6 });
    return f;
  });

  it("authorizes a ready public researcher against the actual workspace-scoped agents schema", async () => {
    const threadId = await thread(); const store = new PgConsultingTaskStore(() => app);
    await expect(store.transaction(scope, threadId, tx => tx.assertPublicRead!())).resolves.toEqual([]);
  });
  it("publishes a hash-checked report and real gateway receipt with the thread projection in the same PG store", async () => {
    const f = await completedFixture();
    expect(f.calls).toEqual({ search: 1, fetch: 2, complete: 7 });
    const view = await f.service.view(scope, f.input.threadId); const report = await f.service.report(scope, f.input.threadId);
    expect(view).toMatchObject({ status: "draft_ready", humanReviewRequired: true, finalArtifact: { kind: "report", synced: true } });
    expect(view.sources).toHaveLength(2); expect(report.sha256).toBe(sha256(report.content));
    expect(report.bytes).toBe(Buffer.byteLength(report.content)); expect(report.receipt.eventId).toBe(view.finalArtifact!.eventId);
    expect(await projection(f.input.threadId)).toMatchObject({ status: "completed", error: null, progress_done: 6, progress_total: 6, plan_version: 1 });
    const events = await rows(f.input.threadId);
    expect(events.filter(event => event.payload.decision.action === "consulting.task.report.ready")).toHaveLength(1);
    expect(events.find(event => event.event_id === report.receipt.eventId)).toMatchObject({ hash: report.receipt.hash,
      payload: { receipt: { mode: "real", synced: true } } });
    const counts = { ...f.calls }; await f.service.execute(scope, f.input); await f.service.report(scope, f.input.threadId);
    expect(f.calls).toEqual(counts);
  });
  it("RLS hides the report, actions and parent run from foreign workspace or mismatched tenant", async () => {
    const f = await completedFixture();
    for (const target of [other, { tenantId: other.tenantId, workspaceId: scope.workspaceId }]) {
      await expect(f.service.view(target, f.input.threadId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(f.service.report(target, f.input.threadId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(f.service.action(target, "FIXTURE-OWNER", { threadId: f.input.threadId, action: "cancel", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // Existing DB RLS is workspace-scoped; the service adds the tenant predicate.
    // A deliberately mismatched tenant + original workspace is a service-negative fixture,
    // not a claim that an authenticated member can select arbitrary GUCs from RPC input.
    expect(await rows(f.input.threadId, other)).toEqual([]);
  });
  it.each(["handoff", "cancel"] as const)("%s during an analysis keeps its original receipt and raw advance/resume/revalidate cannot bypass parent control", async action => {
    const f = await fixture(); const key = randomUUID();
    f.hooks.afterModel = async index => { if (index === 2) await f.service.action(scope, "FIXTURE-OWNER", {
      threadId: f.input.threadId, action, idempotencyKey: key, reason: "PG夹具暂停后续模型步骤" }); };
    const expected = action === "cancel" ? "cancelled" : "paused";
    expect((await f.service.execute(scope, f.input)).status).toBe(expected);
    expect(f.calls.complete).toBe(2); const view = await f.service.view(scope, f.input.threadId);
    expect(view.stepsDone).toBe(1); expect(await projection(f.input.threadId)).toMatchObject({ status: expected, progress_done: 1 });
    const code = action === "cancel" ? "TASK_CANCELLED" : "TASK_HUMAN_REQUIRED";
    await expect(f.direct.advance(scope, "FIXTURE-OWNER", { runId: view.runId!, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code });
    await expect(f.direct.pauseOrResume(scope, "FIXTURE-OWNER", { runId: view.runId!, idempotencyKey: randomUUID() }, false)).rejects.toMatchObject({ code });
    await expect(f.direct.revalidate(scope, "FIXTURE-OWNER", { runId: view.runId!, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code });
    await f.service.execute(scope, f.input); expect(f.calls.complete).toBe(2);
    const replay = await f.service.action(scope, "FIXTURE-OWNER", { threadId: f.input.threadId, action, idempotencyKey: key, reason: "PG夹具暂停后续模型步骤" });
    expect(replay.actionReceipt?.synced).toBe(true);
    await expect(f.service.report(scope, f.input.threadId)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
  });
  it("rolls event and thread projection back together when the transaction body fails", async () => {
    const threadId = await thread(); const store = new PgConsultingTaskStore(() => app);
    await expect(store.transaction(scope, threadId, async tx => {
      await tx.append("consulting.task.rollback.fixture", { fixture: true }, { id: "FIXTURE-OWNER", type: "human" }, true);
      await tx.project({ status: "failed", currentAction: "回滚夹具", error: "must rollback", progressDone: 0, progressTotal: 6 });
      throw new ConsultingError("FIXTURE_ROLLBACK", "explicit fixture rollback");
    })).rejects.toMatchObject({ code: "FIXTURE_ROLLBACK" });
    expect(await rows(threadId)).toEqual([]); expect(await projection(threadId)).toMatchObject({ status: "running", error: null });
  });
  it("a disabled researcher is rejected before source I/O and cannot yield a report", async () => {
    const f = await fixture();
    await owner.query(`UPDATE agents SET status='disabled' WHERE workspace_id=$1 AND preset_key='intel-researcher'`, [scope.workspaceId]);
    try {
      expect((await f.service.execute(scope, f.input)).status).toBe("failed");
      expect((await f.service.view(scope, f.input.threadId)).error?.code).toBe("PUBLIC_RESEARCHER_NOT_READY");
      expect(f.calls).toEqual({ search: 0, fetch: 0, complete: 0 });
      await expect(f.service.report(scope, f.input.threadId)).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    } finally { await owner.query(`UPDATE agents SET status='ready' WHERE workspace_id=$1 AND preset_key='intel-researcher'`, [scope.workspaceId]); }
  });
  it("app role cannot bypass the gateway with direct event INSERT", async () => {
    expect((await app.query("SELECT current_user AS role")).rows[0]?.role).toBe("workloom_app");
    await expect(withWorkspace(app, scope, async (_db, connection) => connection.query(`INSERT INTO biz_events(event_id,tenant_id,workspace_id,payload,prev_hash,hash)
      VALUES($1,$2,$3,'{}','GENESIS','fixture')`, [`FORBIDDEN-${suffix}`, scope.tenantId, scope.workspaceId]))).rejects.toMatchObject({ code: "42501" });
  });
  it("a researcher skill declared on the agent but uninstalled from the workspace does not authorize public I/O", async () => {
    const threadId = await thread(); const store = new PgConsultingTaskStore(() => app);
    const skillId = `fixture-${suffix}-pre-meeting-brief`;
    await owner.query("DELETE FROM skill_installs WHERE skill_id=$1 AND workspace_id=$2", [skillId, scope.workspaceId]);
    try {
      await expect(store.transaction(scope, threadId, tx => tx.assertPublicRead!())).rejects.toMatchObject({ code: "PUBLIC_RESEARCHER_NOT_READY" });
    } finally { await owner.query("INSERT INTO skill_installs(skill_id,workspace_id,installed_by) VALUES($1,$2,'FIXTURE-OWNER')", [skillId, scope.workspaceId]); }
  });
  it("an active public-research fence blocks before any source or model request", async () => {
    const f = await fixture(); const ruleId = `fixture-web-block-${suffix}`;
    await owner.query(`INSERT INTO fence_rules(id,rule_id,version,workspace_id,name,level,match_spec,action,is_baseline,status,created_by)
      VALUES($1,$1,'fixture',$2,'隔离公开采集阻断夹具','block',$3,'{"result":"block"}',false,'active','FIXTURE-OWNER')`,
    [ruleId, scope.workspaceId, JSON.stringify({ object_types: ["enterprise"], actions: ["web.research"], when: "true" })]);
    try {
      expect((await f.service.execute(scope, f.input)).status).toBe("failed");
      expect((await f.service.view(scope, f.input.threadId)).error?.code).toBe("FENCE_BLOCKED");
      expect(f.calls).toEqual({ search: 0, fetch: 0, complete: 0 });
    } finally { await owner.query("UPDATE fence_rules SET status='rolled_back' WHERE id=$1", [ruleId]); }
  });
  it("a provider of unknown outcome stays blocked across task replay, handoff/resume and raw workflow entry", async () => {
    const f = await fixture(); f.hooks.failModelAt = 3;
    expect((await f.service.execute(scope, f.input)).status).toBe("failed");
    const view = await f.service.view(scope, f.input.threadId);
    expect(view).toMatchObject({ status: "blocked", error: { code: "PROVIDER_NETWORK" }, finalArtifact: null });
    await f.service.execute(scope, f.input); expect(f.calls.complete).toBe(3);
    await f.service.action(scope, "FIXTURE-OWNER", { threadId: f.input.threadId, action: "handoff", idempotencyKey: randomUUID() });
    await expect(f.service.action(scope, "FIXTURE-OWNER", { threadId: f.input.threadId, action: "resume", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
    await expect(f.direct.advance(scope, "FIXTURE-OWNER", { runId: view.runId!, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "TASK_HUMAN_REQUIRED" });
    expect(f.calls.complete).toBe(3);
  });
  it("a lost report COMMIT acknowledgement is recovered from actual PG without another report or model purchase", async () => {
    let loseOnce = true;
    const uncertainPool = { connect: async () => {
      const connection = await app.connect(); let completed = false;
      return new Proxy(connection, { get(target, key) {
        if (key === "query") return async (...args: Parameters<typeof connection.query>) => {
          const output = await (connection.query as (...values: unknown[]) => Promise<unknown>)(...args);
          if (typeof args[0] === "string" && args[0].startsWith("UPDATE threads SET status=")
            && Array.isArray(args[1]) && args[1][3] === "completed") completed = true;
          if (args[0] === "COMMIT" && completed && loseOnce) { loseOnce = false; throw new Error("FIXTURE_REPORT_COMMIT_ACK_LOST"); }
          return output;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    } } as pg.Pool;
    const f = await fixture(new PgConsultingTaskStore(() => uncertainPool));
    expect((await f.service.execute(scope, f.input)).status).toBe("completed"); expect(loseOnce).toBe(false);
    expect(f.calls).toEqual({ search: 1, fetch: 2, complete: 7 });
    expect((await f.service.report(scope, f.input.threadId)).receipt.synced).toBe(true);
    expect((await rows(f.input.threadId)).filter(event => event.payload.decision.action === "consulting.task.report.ready")).toHaveLength(1);
    await f.service.execute(scope, f.input); expect(f.calls.complete).toBe(7);
  });
  it("real member authority rejects forged tenant/workspace relationships and tRPC enforces current role and controlled report inputs", async () => {
    const f = await completedFixture(); const counts = { ...f.calls };
    expect((await currentMemberAuthority(identity())).identity).toMatchObject(scope);
    const mismatched = { ...identity(), tenantId: other.tenantId };
    await expect(currentMemberAuthority(mismatched)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(caller(mismatched).taskView({ threadId: f.input.threadId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(null).taskReport({ threadId: f.input.threadId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(identity(other)).taskView({ threadId: f.input.threadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(identity(other)).taskReport({ threadId: f.input.threadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(identity(other)).taskAction({ threadId: f.input.threadId, action: "cancel", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const report = await caller(identity()).taskReport({ threadId: f.input.threadId });
    expect(report.sha256).toBe(sha256(report.content)); expect(report.receipt.synced).toBe(true);
    await expect(caller(identity()).taskReport({ threadId: f.input.threadId, path: "/etc/passwd" } as { threadId: string }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await owner.query("UPDATE members SET role='readonly' WHERE id=$1", [identity().memberId]);
    try {
      // Even a claim still carrying owner is reduced to the current database role.
      await expect(caller(identity()).taskAction({ threadId: f.input.threadId, action: "cancel", idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally { await owner.query("UPDATE members SET role='owner' WHERE id=$1", [identity().memberId]); }
    expect(f.calls).toEqual(counts);
  });
  it.each(["source", "analysis"] as const)("%s in flight holds a durable task claim across service instances until the original result settles", async phase => {
    const f = await fixture(); let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    if (phase === "source") f.hooks.afterFetch = async () => { if (f.calls.fetch === 1) { entered(); await pending; } };
    else f.hooks.afterModel = async index => { if (index === 2) { entered(); await pending; } };
    const original = f.service.execute(scope, f.input); await waiting;
    try {
      const counts = { ...f.calls };
      expect((await f.reopen().execute(scope, f.input)).status).toBe("running"); expect(f.calls).toEqual(counts);
      if (phase === "analysis") {
        const view = await f.service.view(scope, f.input.threadId);
        await expect(f.direct.advance(scope, "FIXTURE-OWNER", { runId: view.runId!, idempotencyKey: randomUUID() }))
          .rejects.toMatchObject({ code: "TASK_EXECUTION_REQUIRED" });
        await expect(f.direct.pauseOrResume(scope, "FIXTURE-OWNER", { runId: view.runId!, idempotencyKey: randomUUID() }, true))
          .rejects.toMatchObject({ code: "TASK_EXECUTION_REQUIRED" });
      }
      await f.service.action(scope, "FIXTURE-OWNER", { threadId: f.input.threadId, action: "handoff", idempotencyKey: randomUUID() });
      expect(await projection(f.input.threadId)).toMatchObject({ status: "paused" });
      expect((await f.service.view(scope, f.input.threadId)).status).toBe("human_required");
      expect((await f.reopen().view(scope, f.input.threadId)).availableActions.resume.enabled).toBe(false);
      await expect(f.reopen().action(scope, "FIXTURE-OWNER", { threadId: f.input.threadId, action: "resume", idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
      expect((await f.reopen().execute(scope, f.input)).status).toBe("paused"); expect(f.calls).toEqual(counts);
    } finally { release(); await original; }
    expect((await f.service.view(scope, f.input.threadId)).availableActions.resume.enabled).toBe(true);
    await f.service.action(scope, "FIXTURE-OWNER", { threadId: f.input.threadId, action: "resume", idempotencyKey: randomUUID() });
    expect(await projection(f.input.threadId)).toMatchObject({ status: "queued" });
    const binding = (await rows(f.input.threadId)).find(event => event.payload.decision.action === "thread.execution.bound")!;
    expect(binding.payload.decision.after.state).toMatchObject({ goal, actorId: "FIXTURE-OWNER", requestId: f.input.requestId });
    expect((await f.reopen().execute(scope, f.input)).status).toBe("completed");
    expect(f.calls).toEqual({ search: 1, fetch: 2, complete: 7 });
    expect((await rows(f.input.threadId)).filter(event => event.payload.decision.action === "consulting.task.report.ready")).toHaveLength(1);
  }, 60000);
  it("a corrupted completed report cannot be downloaded or displayed as verified", async () => {
    const ready = await fixture(); await ready.service.execute(scope, ready.input);
    const event = (await rows(ready.input.threadId)).find(event => event.payload.decision.action === "consulting.task.report.ready")!;
    await writeFile(event.payload.decision.after.file.path, "PG fixture changed the report bytes");
    await expect(ready.service.report(scope, ready.input.threadId)).rejects.toMatchObject({ code: "PUBLIC_SOURCE_HASH_MISMATCH" });
    await expect(ready.service.view(scope, ready.input.threadId)).rejects.toMatchObject({ code: "PUBLIC_SOURCE_HASH_MISMATCH" });
  });
  it.each(["source", "planning"] as const)("a bundle change during %s settles its original PG receipt and blocks before the next paid operation", async phase => {
    const f = await fixture();
    if (phase === "source") f.hooks.afterFetch = async () => { if (f.calls.fetch === 1) f.hooks.bundleReady = false; };
    else f.hooks.afterModel = async index => { if (index === 1) f.hooks.bundleReady = false; };
    expect((await f.service.execute(scope, f.input)).status).toBe("failed");
    const view = await f.service.view(scope, f.input.threadId);
    expect(view).toMatchObject({ status: "blocked", error: { code: "BUNDLE_NOT_READY" }, finalArtifact: null });
    const counts = phase === "source" ? { search: 1, fetch: 1, complete: 0 } : { search: 1, fetch: 2, complete: 1 };
    expect(f.calls).toEqual(counts);
    expect(await f.handler({ scope, input: { ...f.input, mode: "quest" }, presetKey: f.input.presetKey,
      taskContext: { threadId: f.input.threadId, requestId: f.input.requestId } })).toMatchObject({ status: "failed", executionSource: "consulting-report" });
    expect(f.calls).toEqual(counts); expect(await projection(f.input.threadId)).toMatchObject({ status: "failed" });
    const events = await rows(f.input.threadId);
    expect(events.some(event => event.payload.decision.action === "consulting.public-source.fetch")).toBe(true);
  });
  it("historical reports remain readable after a bundle change and unbound nonconsulting work does not enter the industry executor", async () => {
    const completed = await completedFixture(); const counts = { ...completed.calls };
    expect(await completed.inactiveHandler({ scope, input: { ...completed.input, mode: "quest" }, presetKey: completed.input.presetKey,
      taskContext: { threadId: completed.input.threadId, requestId: completed.input.requestId } }))
      .toMatchObject({ status: "completed", executionSource: "consulting-report" });
    expect((await completed.service.report(scope, completed.input.threadId)).receipt.synced).toBe(true);
    expect(completed.calls).toEqual(counts);
    const unbound = await fixture(); unbound.hooks.bundleReady = false;
    expect(await unbound.handler({ scope, input: { ...unbound.input, mode: "quest" }, presetKey: unbound.input.presetKey,
      taskContext: { threadId: unbound.input.threadId, requestId: unbound.input.requestId } })).toBeUndefined();
    expect(unbound.calls).toEqual({ search: 0, fetch: 0, complete: 0 });
  });
});
