import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeepSeekClient, DeepSeekCompletion } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { ConsultingWorkflow, DraftVault, loadConsultingWorkforce, type WorkflowStore, type StoreTransaction, type StoredEvent, type Scope, type Workforce } from "./workflow.js";
import { parsePlan, validateArtifact, validateSources, singleStep, sha256, sourceSchema } from "./workflow-core.js";
import { checkArtifact } from "../../../../../scripts/consulting-eval.mjs";

const scope = { tenantId: "fixture-tenant-a", workspaceId: "fixture-workspace-a" };
const otherScope = { tenantId: "fixture-tenant-b", workspaceId: "fixture-workspace-b" };
const sources = [{ id: "ledger", title: "明确标注的单元夹具", content: "本季收入100万元；回款80万元；客户要求核查20万元差额，不可假定全部逾期。" }];
const analysis = { summary: "客户资料显示收入与回款存在口径差异，须先核对期间与收款范围。",
  findings: [{ claim: "收入与回款不能直接等同于应收逾期。", evidence: [{ sourceId: "ledger", quote: "不可假定全部逾期" }], counterEvidence: "资料未提供期初应收、开票与银行流水。" }],
  recommendations: [{ action: "补齐同期间合同、开票与回款记录后逐笔核查。", basis: ["ledger"], owner: "财务负责人", verification: "每笔差额均可回溯合同与银行回单。" }], missingEvidence: ["同期间合同与银行流水"], humanReviewRequired: true as const };
let catalog: Workforce;
const dirs: string[] = [];
beforeAll(async () => { catalog = await loadConsultingWorkforce(); });
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class MemoryStore implements WorkflowStore {
  streams = new Map<string, StoredEvent[]>();
  private queues = new Map<string, Promise<void>>();
  count = 0;
  assertionError: Error | null = null;
  async transaction<T>(sc: Scope, stream: string, body: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    const key = `${sc.tenantId}:${sc.workspaceId}:${stream}`;
    const before = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const queue = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(key, before.then(() => queue));
    await before;
    const events = structuredClone(this.streams.get(key) ?? []);
    try {
      const value = await body({ events, append: async (input) => {
        const event = { eventId: `E-${++this.count}`, hash: sha256(JSON.stringify(input)), at: new Date().toISOString(), action: input.action, data: input.data };
        events.push(event); return event;
      }, assertEmployee: async () => { if (this.assertionError) throw this.assertionError; return []; } });
      this.streams.set(key, events); return value;
    } finally { release(); }
  }
}
function planned() {
  const keys = ["diagnosis-analyst", "finance-advisor", "strategy-counselor", "org-hr-counselor", "report-composer", "quality-officer"];
  return { rationale: "先核对财务资料，再从财务战略组织三面分析，组稿后由独立质检官反证。",
    steps: keys.map((key) => ({ employeeKey: key, skillId: catalog.employees.get(key)!.skills[0] ?? null, objective: `按${catalog.employees.get(key)!.name}职责形成有出处且待人审的分析素材。` })) };
}
function completion(text: string, index: number): DeepSeekCompletion {
  return { text, model: "deepseek-flash", requestedModel: "deepseek-flash", provider: "deepseek", requestId: `fixture-request-${index}`,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, finishReason: "stop", reservationId: `fixture-reservation-${index}`,
    modelMetadata: { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash-1017", contextWindow: 1048576, maxOutputTokens: 393216, verifiedAt: new Date().toISOString(),
      tokenizerProof: { source: "https://example.invalid/unit-fixture", artifactSha256: "0".repeat(64), reviewedOn: "2026-10-23", modelVersion: "fixture", algorithm: "unit fixture, no paid I/O", framingAllowance: 1024 } } };
}
async function fixture(custom?: (input: { system?: string; prompt: string }, index: number) => Promise<string>, dossierSources = sources) {
  const store = new MemoryStore();
  const base = await mkdtemp(join(tmpdir(), "eagle-workflow-unit-")); dirs.push(base);
  const prompts: Array<{ system?: string; prompt: string }> = [];
  const client = { complete: async (input: { system?: string; prompt: string }) => {
    prompts.push(input); const index = prompts.length;
    const text = custom ? await custom(input, index) : JSON.stringify(input.system?.includes("任务分解器") ? planned() : analysis);
    return completion(text, index);
  }, getBudget: () => ({ fixture: true, llmAttempts: prompts.length }) } as unknown as DeepSeekClient;
  const workflow = new ConsultingWorkflow({ store, workforce: async () => catalog, model: () => client,
    vault: new DraftVault(base), assertBundle: async () => undefined });
  await workflow.dossierPut(scope, "unit-owner", { enterpriseId: "unit-enterprise", sources: dossierSources, idempotencyKey: "unit-dossier-v1" });
  return { workflow, store, prompts, base, client };
}
const single = { enterpriseId: "unit-enterprise", goal: "分析收入与回款口径差异并提供核查清单", employeeKey: "finance-advisor", idempotencyKey: "single-unit-task-1" };
async function legacyRejected(f: Awaited<ReturnType<typeof fixture>>, raw: string, isolatedDiagnostic = false) {
  const run = await f.workflow.submit(scope, "unit-owner", single);
  const executionId = "11111111-1111-4111-8111-111111111111";
  const original = completion(raw, 1); const { text: _text, ...model } = original;
  const rejectedArtifactId = "22222222-2222-4222-8222-222222222222";
  const file = await new DraftVault(f.base).write(scope, run.id, "s1", isolatedDiagnostic ? rejectedArtifactId : executionId,
    `# 未通过校验的模型候选输出\n\n> 此件不是已交付产物；只供排障与人类复核。\n\n${raw}\n`);
  await f.store.transaction(scope, run.id, async (tx) => {
    await tx.append({ action: "consulting.step.started", actor: { id: "unit-owner", type: "human" },
      data: { stepId: "s1", executionId, requestKey: "original-unit-claim" } });
    await tx.append({ action: "consulting.run.failed", actor: { id: "unit-owner", type: "human" },
      data: { error: { code: "ARTIFACT_SCHEMA_INVALID", message: "persisted old-contract fixture" },
        failureEvidence: { phase: "analysis", model, responseBytes: Buffer.byteLength(raw), rejectedArtifact: file,
          ...(isolatedDiagnostic ? { stepId: "s1", executionId, rejectedArtifactId } : {}) } }, model: original });
  });
  return { run, file, model };
}
function lostCommitAcknowledgement(store: MemoryStore, action: string, readbackFails = false): WorkflowStore {
  let injected = false;
  return { async transaction<T>(sc: Scope, stream: string, body: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    if (injected && readbackFails) throw new Error("fixture readback unavailable after durable COMMIT");
    const before = [...store.streams.values()].flat().filter((event) => event.action === action).length;
    const result = await store.transaction(sc, stream, body);
    const after = [...store.streams.values()].flat().filter((event) => event.action === action).length;
    if (!injected && after > before) { injected = true; throw new Error("fixture durable COMMIT acknowledgement lost"); }
    return result;
  } };
}

describe("consulting workflow state and evidence boundaries (unit fixtures, no production claims)", () => {
  it("loads actual 22 published presets and 199 complete skill assets", () => {
    expect(catalog.employees.size).toBe(22); expect(catalog.skills.size).toBe(199);
    for (const employee of catalog.employees.values()) for (const id of employee.skills) expect(catalog.skills.has(id)).toBe(true);
  });
  it("runs the assigned full skill, writes an artifact, reads the exact bytes and returns a receipt", async () => {
    const f = await fixture(); const queued = await f.workflow.submit(scope, "unit-owner", single);
    expect(queued.status).toBe("queued"); expect(f.prompts).toHaveLength(0);
    const done = await f.workflow.advance(scope, "unit-owner", { runId: queued.id, idempotencyKey: "single-step-request" });
    expect(done.status).toBe("draft_ready"); expect(done.humanReviewRequired).toBe(true);
    expect(f.prompts[0]!.prompt).toContain(catalog.skills.get("fin-statement-analysis"));
    const artifact = await f.workflow.artifact(scope, done.id, "s1");
    expect(sha256(artifact.content)).toBe(artifact.sha256); expect(artifact.bytes).toBe(Buffer.byteLength(artifact.content));
    expect(artifact.receipt.synced).toBe(true); expect(artifact.content).toContain("内部咨询草稿");
    expect(artifact.content.startsWith("# 财务资本顾问 · 内部咨询草稿\n\n> ")).toBe(true);
    expect(artifact.content).toContain("\n\n## 发现、依据与反证\n\n");
    expect(artifact.content).not.toContain("\\n");
  });
  it("shows only exact captured source content to analysis, preserves frozen dossier identity and accounts for the actual prompt bytes", async () => {
    const captured = JSON.parse(await readFile(new URL("../../../../../acceptance/consulting/regressions/public-source-citation-escaping.json", import.meta.url), "utf8"));
    const originalSources = JSON.stringify(captured.sources);
    const source = captured.sources.find((item: { id: string }) => item.id === "PUBLIC_2")!;
    const quote = source.content.slice(0, 70);
    expect(quote).toContain("\\");
    const control = { summary: "明确标注的离线控制，只验证逐字引用与资料可见边界，不是真实行业结论。",
      findings: [{ claim: "本夹具只验证来源正文的逐字引用，不对制造业经营状况下结论。", evidence: [{ sourceId: source.id, quote }], counterEvidence: "仅为离线控制，不能当作实际报告或岗位能力证明。" }],
      recommendations: [{ action: "保留原始失败产物和原文回执供人类排障复核。", basis: [source.id], owner: "夹具审查者", verification: "原始文件及资料散列和字节均保持不变。" }],
      missingEvidence: [], humanReviewRequired: true };
    const f = await fixture(async () => JSON.stringify(control), captured.sources);
    const queued = await f.workflow.submit(scope, "unit-owner", { ...single, goal: captured.goal, employeeKey: "diagnosis-analyst" });
    const done = await f.workflow.advance(scope, "unit-owner", { runId: queued.id, idempotencyKey: "captured-exact-content-control" });
    expect(done.status).toBe("draft_ready"); expect(f.prompts).toHaveLength(1);
    const actual = f.prompts[0]!;
    const serializedSources = /原始授权资料[^\n]*?：(\[.*\])\n全部前序产物全文/u.exec(actual.prompt)?.[1];
    expect(serializedSources).toBeDefined();
    const visible = JSON.parse(serializedSources!);
    expect(visible).toEqual(captured.sources.map(({ id, content }: { id: string; content: string }) => ({ id, content })));
    expect(visible.every((item: Record<string, unknown>) => !Object.hasOwn(item, "title"))).toBe(true);
    expect(actual.system).toContain("quote只能来自同一sourceId的content");
    expect(actual.system).toContain("包括Markdown反斜杠在内逐字复制");
    expect(actual.system).toContain("title、搜索摘要和未选入的全文不是可引用正文");
    expect(actual.system).toContain("缺少正文证据时列入missingEvidence");
    expect(actual.system).toContain("数量、排序、负责人、验收、回退、人审和格式");
    expect(actual.system).toContain("无法满足的要求必须列入missingEvidence，不得暗示已完成");
    expect(actual.system).toContain("收益必须使用基线与试点的差值");
    expect(actual.system).toContain("工时与金额必须分开");
    expect(done.sources).toEqual(captured.sources); expect(done.sourceDigest).toBe(captured.sourceDigest);
    expect(JSON.stringify(captured.sources)).toBe(originalSources);
    for (const proof of captured.sourceProvenance) {
      const content = done.sources.find((item) => item.id === proof.id)!.content;
      expect(sha256(content)).toBe(proof.excerptSha256); expect(Buffer.byteLength(content)).toBe(proof.excerptBytes);
    }
    expect(done.completed[0]!.inputDisclosure).toMatchObject({ systemAndPromptUtf8Bytes: Buffer.byteLength(actual.system! + actual.prompt), inputSha256: sha256(`${actual.system}\0${actual.prompt}`) });
  });
  it("retains the original captured public response as evidence mismatch and cannot revalidate or repurchase it", async () => {
    const captured = JSON.parse(await readFile(new URL("../../../../../acceptance/consulting/regressions/public-source-citation-escaping.json", import.meta.url), "utf8"));
    expect(sha256(captured.rawResponse)).toBe(captured.rawResponseSha256);
    const f = await fixture(async () => captured.rawResponse, captured.sources);
    const run = await f.workflow.submit(scope, "unit-owner", { ...single, goal: captured.goal, employeeKey: "diagnosis-analyst" });
    const blocked = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "original-public-evidence-failure" });
    expect(blocked.status).toBe("blocked"); expect(blocked.error?.code).toBe("EVIDENCE_MISMATCH"); expect(blocked.completed).toHaveLength(0);
    expect(await readFile(blocked.failureEvidence!.rejectedArtifact!.path, "utf8")).toContain(captured.rawResponse);
    await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "another-key-cannot-repurchase" });
    await expect(f.workflow.revalidate(scope, "unit-owner", { runId: run.id, idempotencyKey: "cannot-accept-title-or-unescaped-quote" })).rejects.toMatchObject({ code: "REVALIDATION_NOT_ALLOWED" });
    expect(f.prompts).toHaveLength(1); expect(sha256(captured.rawResponse)).toBe(captured.rawResponseSha256);
  });
  it.each([0, 1, 2, 3, 4])("keeps captured headline or unescaped evidence quote %i outside the exact-content whitelist", async (index) => {
    const captured = JSON.parse(await readFile(new URL("../../../../../acceptance/consulting/regressions/public-source-citation-escaping.json", import.meta.url), "utf8"));
    const original = JSON.parse(captured.rawResponse);
    const evidence = original.findings.flatMap((item: { evidence: Array<{ sourceId: string; quote: string }> }) => item.evidence)[index];
    const candidate = { ...original, findings: [{ ...original.findings[0], evidence: [evidence] }] };
    expect(() => validateArtifact(JSON.stringify(candidate), captured.sources)).toThrow(/产物引用不在本任务档案原文中/);
  });
  it("limits planner instructions to responsibilities and acceptance while retaining original quantities, periods and human review constraints", async () => {
    const f = await fixture(); const goal = "审视未来30天收入120万元与现金安全目标，保留人类顾问最终审阅。";
    const run = await f.workflow.submit(scope, "unit-owner", { ...single, goal, employeeKey: undefined });
    expect(run.status).toBe("queued"); expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.prompt).toContain(`目标：${goal}`);
    expect(f.prompts[0]!.system).toContain("不计算、不写派生数值");
    expect(f.prompts[0]!.system).toContain("原目标中的数量、周期和人审约束必须逐项保留");
    expect(f.prompts[0]!.system).toContain("资料数字和前序意见均须独立核对");
  });
  it("a lost completion COMMIT acknowledgement reads back the original receipt without overwriting accepted Markdown or appending failure", async () => {
    const f = await fixture(); const queued = await f.workflow.submit(scope, "unit-owner", single);
    const workflow = new ConsultingWorkflow({ store: lostCommitAcknowledgement(f.store, "consulting.analysis.read"), workforce: async () => catalog,
      model: () => f.client, vault: new DraftVault(f.base), assertBundle: async () => undefined });
    const done = await workflow.advance(scope, "unit-owner", { runId: queued.id, idempotencyKey: "lost-completion-ack" });
    expect(done.status).toBe("draft_ready"); expect(f.prompts).toHaveLength(1);
    expect([...f.store.streams.values()].flat().filter((event) => event.action === "consulting.run.failed")).toHaveLength(0);
    expect(sha256(await readFile(done.completed[0]!.file.path, "utf8"))).toBe(done.completed[0]!.file.sha256);
    expect(await readFile(done.completed[0]!.file.path, "utf8")).not.toContain("未通过校验的模型候选输出");
  });
  it("if COMMIT readback is unavailable it reports uncertainty and preserves the durable completed file and single paid call", async () => {
    const f = await fixture(); const queued = await f.workflow.submit(scope, "unit-owner", single);
    const workflow = new ConsultingWorkflow({ store: lostCommitAcknowledgement(f.store, "consulting.analysis.read", true), workforce: async () => catalog,
      model: () => f.client, vault: new DraftVault(f.base), assertBundle: async () => undefined });
    await expect(workflow.advance(scope, "unit-owner", { runId: queued.id, idempotencyKey: "lost-ack-unreadable" })).rejects.toMatchObject({ code: "COMMIT_STATUS_UNKNOWN" });
    const durable = await f.workflow.get(scope, queued.id);
    expect(durable.status).toBe("draft_ready"); expect(f.prompts).toHaveLength(1);
    expect(sha256(await readFile(durable.completed[0]!.file.path, "utf8"))).toBe(durable.completed[0]!.file.sha256);
    expect([...f.store.streams.values()].flat().some((event) => event.action === "consulting.run.failed")).toBe(false);
  });
  it("a lost planner COMMIT acknowledgement keeps the original six-step plan without a failed duplicate usage event", async () => {
    const f = await fixture(); const workflow = new ConsultingWorkflow({ store: lostCommitAcknowledgement(f.store, "consulting.run.planned"), workforce: async () => catalog,
      model: () => f.client, vault: new DraftVault(f.base), assertBundle: async () => undefined });
    const run = await workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    expect(run.status).toBe("queued"); expect(run.steps).toHaveLength(6); expect(f.prompts).toHaveLength(1);
    expect([...f.store.streams.values()].flat().some((event) => event.action === "consulting.run.failed")).toBe(false);
  });
  it("artifact publication never replaces an existing final filename", async () => {
    const f = await fixture(); const queued = await f.workflow.submit(scope, "unit-owner", single);
    const done = await f.workflow.advance(scope, "unit-owner", { runId: queued.id, idempotencyKey: "immutable-final-filename" });
    const original = done.completed[0]!;
    await expect(new DraftVault(f.base).write(scope, done.id, "s1", original.executionId, "attempted replacement")).rejects.toMatchObject({ code: "EEXIST" });
    expect(sha256(await readFile(original.file.path, "utf8"))).toBe(original.file.sha256);
  });
  it("persists model-generated six-role planning and rejects missing/reordered mandatory gates", async () => {
    const f = await fixture(); const run = await f.workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    expect(run.steps).toHaveLength(6); expect(run.planModel?.requestId).toBe("fixture-request-1"); expect(run.planReceipt?.synced).toBe(true);
    expect(run.steps.map((s) => s.dependsOn)).toEqual([[], ["s1"], ["s2"], ["s3"], ["s4"], ["s5"]]);
    const invalid = planned(); invalid.steps[5]!.employeeKey = "chief-of-staff";
    expect(() => parsePlan(JSON.stringify(invalid), catalog.employees)).toThrow(/质检官/);
  });
  it("all six steps require actual predecessor files and carry their hashes; repeated calls never charge twice", async () => {
    const f = await fixture(); let run = await f.workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    for (let i = 1; i <= 6; i++) {
      const request = { runId: run.id, idempotencyKey: `ordered-step-${i}` };
      run = await f.workflow.advance(scope, "unit-owner", request);
      expect(run.completed).toHaveLength(i); expect(run.completed[i - 1]!.priorArtifactHashes).toHaveLength(i - 1);
      await f.workflow.advance(scope, "unit-owner", request);
      expect(f.prompts).toHaveLength(i + 1);
    }
    expect(run.status).toBe("draft_ready"); expect(run.completed[5]!.model.requestId).toBe("fixture-request-7");
  });
  it("supplies every earlier complete artifact to report and red-team steps rather than receipt indexes alone", async () => {
    const f = await fixture(async (input, index) => JSON.stringify(input.system?.includes("任务分解器") ? planned()
      : { ...analysis, summary: `前序步骤${index - 1}的完整独特正文-${"完整上下文".repeat(35)}` }));
    let run = await f.workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    for (let i = 1; i <= 6; i++) {
      const before = [...run.completed];
      run = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: `full-upstream-${i}` });
      expect(run.status).not.toBe("blocked");
      for (const prior of before) expect(f.prompts.at(-1)!.prompt).toContain(JSON.stringify(prior.artifact));
    }
    expect(run.status).toBe("draft_ready");
    expect(f.prompts.at(-1)!.prompt).toContain("全部前序产物全文");
    expect(run.completed.at(-1)!.inputDisclosure).toMatchObject({ mode: "all-prior-structured-artifacts-full", completePriorStepIds: ["s1", "s2", "s3", "s4", "s5"] });
    expect(run.completed.at(-1)!.inputDisclosure!.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.completed.at(-1)!.inputDisclosure!.systemAndPromptUtf8Bytes).toBeLessThanOrEqual(64000);
  });
  it("rejects the captured actual client finance arithmetic error without another provider call", async () => {
    const captured = JSON.parse(await readFile(new URL("../../../../../acceptance/consulting/regressions/client-complex-finance.json", import.meta.url), "utf8"));
    expect(captured.artifact.findings[2].claim).toContain("毛利率75%");
    expect(() => validateArtifact(JSON.stringify(captured.artifact), captured.sources)).toThrow(/算术|ARITHMETIC/);
  });
  it("blocks the captured invalid finance response while retaining raw bytes and paid receipt without a retry", async () => {
    const captured = JSON.parse(await readFile(new URL("../../../../../acceptance/consulting/regressions/client-complex-finance.json", import.meta.url), "utf8"));
    const f = await fixture(async () => JSON.stringify(captured.artifact), captured.sources);
    const run = await f.workflow.submit(scope, "unit-owner", single);
    const blocked = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "captured-wrong-math" });
    expect(blocked.status).toBe("blocked"); expect(blocked.error?.code).toBe("ARITHMETIC_MISMATCH");
    expect(blocked.completed).toHaveLength(0); expect(blocked.failureEvidence?.model?.requestId).toBe("fixture-request-1");
    const diagnostic = await readFile(blocked.failureEvidence!.rejectedArtifact!.path, "utf8");
    expect(diagnostic).toContain(JSON.stringify(captured.artifact));
    expect(sha256(diagnostic)).toBe(blocked.failureEvidence!.rejectedArtifact!.sha256);
    await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "no-repurchase-with-new-key" });
    await expect(f.workflow.revalidate(scope, "unit-owner", { runId: run.id, idempotencyKey: "cannot-promote-wrong-math" })).rejects.toMatchObject({ code: "REVALIDATION_NOT_ALLOWED" });
    expect(f.prompts).toHaveLength(1);
  });
  it("accepts a separately corrected arithmetic regression copy while leaving the captured paid answer unchanged", async () => {
    const text = await readFile(new URL("../../../../../acceptance/consulting/regressions/client-complex-finance.json", import.meta.url), "utf8");
    const captured = JSON.parse(text);
    const corrected = JSON.stringify(captured.artifact).replaceAll("毛利率75%", "毛利率25%").replaceAll("月毛利减22.5万", "月毛利减7.5万");
    expect(validateArtifact(corrected, captured.sources).findings[2]!.claim).toContain("毛利率25%");
    expect(JSON.parse(text).artifact.findings[2].claim).toContain("毛利率75%");
  });
  it("preflights the cumulative upper bound of every earlier full artifact rather than one predecessor", async () => {
    const f = await fixture();
    const expanded = { ...catalog, skills: new Map(catalog.skills) };
    expanded.skills.set("red-team-review", "完整方法".repeat(1800));
    const workflow = new ConsultingWorkflow({ store: f.store, workforce: async () => expanded, model: () => f.client,
      vault: new DraftVault(f.base), assertBundle: async () => undefined });
    const blocked = await workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    expect(blocked.status).toBe("blocked"); expect(blocked.error?.code).toBe("CONTEXT_TOO_LARGE");
    expect(blocked.completed).toHaveLength(0); expect(f.prompts).toHaveLength(1);
  });
  it("pauses between steps, restores checkpoints in a new service instance and does not re-plan", async () => {
    const f = await fixture(); const initial = await f.workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    await f.workflow.advance(scope, "unit-owner", { runId: initial.id, idempotencyKey: "first-step-for-pause" });
    await f.workflow.pauseOrResume(scope, "unit-owner", { runId: initial.id, idempotencyKey: "pause-step-boundary" }, true);
    await expect(f.workflow.advance(scope, "unit-owner", { runId: initial.id, idempotencyKey: "cannot-jump-paused" })).rejects.toMatchObject({ code: "RUN_NOT_READY" });
    const restarted = new ConsultingWorkflow({ store: f.store, workforce: async () => catalog, model: () => f.client,
      vault: new DraftVault(f.base), assertBundle: async () => undefined });
    await restarted.pauseOrResume(scope, "unit-owner", { runId: initial.id, idempotencyKey: "resume-step-boundary" }, false);
    const after = await restarted.get(scope, initial.id);
    expect(after.completed).toHaveLength(1); expect(after.status).toBe("queued"); expect(f.prompts).toHaveLength(2);
  });
  it("serializes concurrent advance claims before paid I/O", async () => {
    let resolveModel!: (text: string) => void;
    const started = new Promise<void>((resolve) => { resolveModel = () => resolve(); });
    let finish!: (text: string) => void;
    const f = await fixture(async () => { resolveModel(""); return new Promise<string>((resolve) => { finish = resolve; }); });
    const run = await f.workflow.submit(scope, "unit-owner", single);
    const one = f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "concurrent-first" });
    await started;
    const two = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "concurrent-second" });
    expect(two.status).toBe("running"); expect(f.prompts).toHaveLength(1);
    finish(JSON.stringify(analysis)); await one;
  });
  it("keeps tenant/workspace boundaries in dossier and run identity", async () => {
    const f = await fixture(); const run = await f.workflow.submit(scope, "unit-owner", single);
    await expect(f.workflow.dossierGet(otherScope, "unit-enterprise")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.workflow.get(otherScope, run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("idempotency conflicts preserve the original dossier and task", async () => {
    const f = await fixture(); const run = await f.workflow.submit(scope, "unit-owner", single);
    await expect(f.workflow.submit(scope, "unit-owner", { ...single, goal: "改为完全不同的任务目标" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(f.workflow.dossierPut(scope, "unit-owner", { enterpriseId: "unit-enterprise", sources: [{ ...sources[0]!, content: "不同资料" }], idempotencyKey: "unit-dossier-v1" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await f.workflow.get(scope, run.id)).goal).toBe(single.goal);
  });
  it("rejects cross-employee skills and fabricated evidence before recording successful completion", async () => {
    expect(() => singleStep(catalog.employees.get("finance-advisor")!, "red-team-review")).toThrow(/未绑定/);
    expect(() => validateArtifact(JSON.stringify({ ...analysis, findings: [{ ...analysis.findings[0], evidence: [{ sourceId: "ledger", quote: "不存在的引文" }] }] }), sources)).toThrow(/伪造/);
    const f = await fixture(async () => JSON.stringify({ ...analysis, humanReviewRequired: false }));
    const run = await f.workflow.submit(scope, "unit-owner", single);
    const blocked = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "invalid-artifact-request" });
    expect(blocked.status).toBe("blocked"); expect(blocked.completed).toHaveLength(0); expect(blocked.error?.code).toBe("ARTIFACT_SCHEMA_INVALID");
    expect(blocked.failureEvidence?.model?.requestId).toBe("fixture-request-1");
    expect(blocked.failureEvidence?.rejectedArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("accepts five to eight real source IDs as a recommendation basis and rejects every unknown source", () => {
    const authorized = Array.from({ length: 8 }, (_, index) => ({ ...sources[0]!, id: index ? `source-${index}` : "ledger" }));
    for (const count of [5, 8]) {
      const candidate = { ...analysis, recommendations: [{ ...analysis.recommendations[0], basis: authorized.slice(0, count).map((source) => source.id) }] };
      expect(validateArtifact(JSON.stringify(candidate), authorized).recommendations[0]!.basis).toHaveLength(count);
      candidate.recommendations[0]!.basis[0] = "fabricated-source";
      expect(() => validateArtifact(JSON.stringify(candidate), authorized)).toThrow(/未知资料/);
    }
  });
  it("a provider failure leaves a blocked receipt and cannot be silently retried with another key", async () => {
    const f = await fixture(async () => { throw Object.assign(new Error("fixture transport failure"), { code: "PROVIDER_NETWORK" }); });
    const run = await f.workflow.submit(scope, "unit-owner", single);
    const blocked = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "unknown-result-once" });
    expect(blocked.status).toBe("blocked"); expect(blocked.error?.code).toBe("PROVIDER_NETWORK");
    const same = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "different-key-not-retry" });
    expect(same.status).toBe("blocked"); expect(f.prompts).toHaveLength(1);
  });
  it("rejects source overflows and duplicate source IDs without silently clipping", () => {
    expect(() => validateSources([sources[0]!, sources[0]!])).toThrow(/不重复/);
    expect(() => validateSources([{ id: "huge", title: "夹具", content: "大".repeat(1500) }])).toThrow(/4000/);
  });
  it("refuses obvious and currently configured credentials before storing sources or goals", async () => {
    const f = await fixture(); const before = f.store.count;
    const fake = `sk-${"x".repeat(32)}`;
    expect(sourceSchema.safeParse({ ...sources[0]!, content: fake }).success).toBe(false);
    await expect(f.workflow.dossierPut(scope, "unit-owner", { enterpriseId: "secret-fixture", sources: [{ ...sources[0]!, title: fake }], idempotencyKey: "secret-dossier-unit" })).rejects.toMatchObject({ code: "SECRET_IN_INPUT" });
    await expect(f.workflow.submit(scope, "unit-owner", { ...single, goal: `请检查凭据${fake}` })).rejects.toMatchObject({ code: "SECRET_IN_INPUT" });
    const old = process.env.WORKLOOM_DESKTOP_SESSION_SECRET;
    try {
      process.env.WORKLOOM_DESKTOP_SESSION_SECRET = "configured-fake-desktop-secret-for-unit";
      await expect(f.workflow.submit(scope, "unit-owner", { ...single, goal: process.env.WORKLOOM_DESKTOP_SESSION_SECRET })).rejects.toMatchObject({ code: "SECRET_IN_INPUT" });
    } finally {
      if (old === undefined) delete process.env.WORKLOOM_DESKTOP_SESSION_SECRET; else process.env.WORKLOOM_DESKTOP_SESSION_SECRET = old;
    }
    expect(f.store.count).toBe(before); expect(f.prompts).toHaveLength(0);
    expect(JSON.stringify([...f.store.streams.values()])).not.toContain(fake);
  });
  it.each([false, true])("revalidates the stored original legacy/isolated response (%s), preserving failure and provider identity without model I/O or double usage", async (isolatedDiagnostic) => {
    const f = await fixture(); const raw = JSON.stringify({ ...analysis, findings: [{ ...analysis.findings[0], evidence: Array.from({ length: 4 }, () => analysis.findings[0]!.evidence[0]) }] });
    const legacy = await legacyRejected(f, raw, isolatedDiagnostic); const before = f.store.count;
    const input = { runId: legacy.run.id, idempotencyKey: "revalidate-original-unit" };
    const [one, two] = await Promise.all([f.workflow.revalidate(scope, "unit-owner", input), f.workflow.revalidate(scope, "unit-owner", input)]);
    expect(one.status).toBe("draft_ready"); expect(two.status).toBe("draft_ready"); expect(one.error).toBeNull();
    expect(one.completed[0]!.artifact.findings[0]!.evidence).toHaveLength(4);
    expect(one.completed[0]!.model).toEqual(legacy.model); expect(f.prompts).toHaveLength(0); expect(f.store.count).toBe(before + 2);
    const events = [...f.store.streams.values()].flat();
    expect(events.filter((event) => event.action === "consulting.run.failed")).toHaveLength(1);
    expect(events.find((event) => event.action === "consulting.step.revalidated")!.data.reusedFrom).toMatchObject({ rejectedArtifactSha256: legacy.file.sha256, requestId: legacy.model.requestId });
    expect(one.failureEvidence?.rejectedArtifact?.sha256).toBe(legacy.file.sha256);
    expect(sha256(await readFile(legacy.file.path, "utf8"))).toBe(legacy.file.sha256);
  });
  it("revalidation refuses changed files, invalid original output, cross-scope and missing paid evidence without a completion event", async () => {
    const f = await fixture(); const legacy = await legacyRejected(f, JSON.stringify({ ...analysis, humanReviewRequired: false }));
    const before = f.store.count; const input = { runId: legacy.run.id, idempotencyKey: "cannot-promote-bad-output" };
    await expect(f.workflow.revalidate(scope, "unit-owner", input)).rejects.toMatchObject({ code: "ARTIFACT_SCHEMA_INVALID" });
    await expect(f.workflow.revalidate(otherScope, "unit-owner", input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await writeFile(legacy.file.path, "tampered original response");
    await expect(f.workflow.revalidate(scope, "unit-owner", input)).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
    expect(f.store.count).toBe(before); expect(f.prompts).toHaveLength(0);
    const g = await fixture(async () => { throw Object.assign(new Error("fixture timeout"), { code: "PROVIDER_NETWORK" }); });
    const run = await g.workflow.submit(scope, "unit-owner", single);
    await g.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "unknown-call-fixture" });
    await expect(g.workflow.revalidate(scope, "unit-owner", { runId: run.id, idempotencyKey: "no-invented-response" })).rejects.toMatchObject({ code: "REVALIDATION_NOT_ALLOWED" });
    expect(g.prompts).toHaveLength(1);
  });
  it("revalidation fails closed for altered provider metadata, byte counts, active claims and employee permission", async () => {
    const f = await fixture(); const legacy = await legacyRejected(f, JSON.stringify(analysis));
    const events = [...f.store.streams.values()].find((list) => list.some((event) => event.action === "consulting.run.failed"))!;
    const failure = events.find((event) => event.action === "consulting.run.failed")!;
    const evidence = failure.data.failureEvidence as { model: { requestId: string }; responseBytes: number };
    const input = { runId: legacy.run.id, idempotencyKey: "negative-revalidation-unit" }; const count = f.store.count;
    const requestId = evidence.model.requestId; evidence.model.requestId = "";
    await expect(f.workflow.revalidate(scope, "unit-owner", input)).rejects.toMatchObject({ code: "REVALIDATION_EVIDENCE_INVALID" });
    evidence.model.requestId = requestId; evidence.responseBytes += 1;
    await expect(f.workflow.revalidate(scope, "unit-owner", input)).rejects.toMatchObject({ code: "REVALIDATION_EVIDENCE_INVALID" });
    evidence.responseBytes -= 1;
    const started = events.find((event) => event.action === "consulting.step.started")!; started.data.stepId = "s6";
    await expect(f.workflow.revalidate(scope, "unit-owner", input)).rejects.toMatchObject({ code: "DEPENDENCY_MISSING" });
    started.data.stepId = "s1"; f.store.assertionError = new Error("fixture employee is no longer authorized");
    await expect(f.workflow.revalidate(scope, "unit-owner", input)).rejects.toThrow(/no longer authorized/);
    expect(f.store.count).toBe(count); expect(f.prompts).toHaveLength(0);
    expect((await f.workflow.get(scope, legacy.run.id)).status).toBe("blocked");
  });
  it("detects file tampering instead of claiming a previously generated task was delivered", async () => {
    const f = await fixture(); const run = await f.workflow.submit(scope, "unit-owner", single);
    const done = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "file-integrity-case" });
    await writeFile(done.completed[0]!.file.path, "tampered fixture");
    await expect(f.workflow.get(scope, run.id)).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
  });
  it("refuses unknown employees and missing enterprise materials before model I/O", async () => {
    const f = await fixture();
    await expect(f.workflow.submit(scope, "unit-owner", { ...single, employeeKey: "not-published" })).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    await expect(f.workflow.submit(scope, "unit-owner", { ...single, enterpriseId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.prompts).toHaveLength(0);
  });
  it("preflights all 22 evaluation goals and the complete six-stage context bound without paid I/O", async () => {
    const matrix = JSON.parse(await readFile(new URL("../../../../../acceptance/consulting/tasks.json", import.meta.url), "utf8"));
    const f = await fixture(undefined, matrix.sources);
    for (const task of matrix.singleTasks) {
      const run = await f.workflow.submit(scope, "unit-owner", { enterpriseId: "unit-enterprise", goal: task.goal,
        employeeKey: task.employeeKey, idempotencyKey: `context-${task.id}` });
      expect(run.status, task.employeeKey).toBe("queued");
    }
    expect(f.prompts).toHaveLength(0);
    const complex = await f.workflow.submit(scope, "unit-owner", { enterpriseId: "unit-enterprise", goal: matrix.complexTask.goal, idempotencyKey: "context-complex-unit" });
    expect(complex.status, JSON.stringify(complex.error)).toBe("queued");
    expect(f.prompts).toHaveLength(1); // A local fixture planner response, no network or provider.
  });
  it("the actual single-employee service result satisfies the independent evaluator contract", async () => {
    const f = await fixture(); const run = await f.workflow.submit(scope, "unit-owner", single);
    const done = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: "eval-contract-single" });
    const file = await f.workflow.artifact(scope, run.id, "s1");
    expect(checkArtifact(done, { employeeKey: "finance-advisor", expectAny: [] }, [file])).toMatchObject({ stateAndReceiptPassed: true, artifactCount: 1 });
  });
  it("the actual six-stage service result satisfies the independent evaluator contract", async () => {
    const f = await fixture(); let run = await f.workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    for (let i = 1; i <= 6; i++) run = await f.workflow.advance(scope, "unit-owner", { runId: run.id, idempotencyKey: `eval-contract-complex-${i}` });
    const files = await Promise.all(run.steps.map((step) => f.workflow.artifact(scope, run.id, step.id)));
    expect(checkArtifact(run, { stepCount: 6, requiredFirst: "diagnosis-analyst", requiredPenultimate: "report-composer", requiredLast: "quality-officer", expectAny: [] }, files))
      .toMatchObject({ stateAndReceiptPassed: true, artifactCount: 6 });
  });
  it("a rejected paid planner response preserves phase, actual bytes and isolated diagnostic file without a fake plan", async () => {
    const f = await fixture(async () => JSON.stringify({ rationale: "too few stages in this fixture", steps: [] }));
    const run = await f.workflow.submit(scope, "unit-owner", { ...single, employeeKey: undefined });
    expect(run.status).toBe("blocked"); expect(run.error?.code).toBe("PLAN_SCHEMA_INVALID");
    expect(run.steps).toHaveLength(0); expect(run.completed).toHaveLength(0);
    expect(run.failureEvidence?.phase).toBe("planning");
    expect(run.failureEvidence?.responseBytes).toBeGreaterThan(0);
    const diagnostic = await readFile(run.failureEvidence!.rejectedArtifact!.path, "utf8");
    expect(diagnostic).toContain("此件不是已交付产物"); expect(sha256(diagnostic)).toBe(run.failureEvidence!.rejectedArtifact!.sha256);
  });
});
