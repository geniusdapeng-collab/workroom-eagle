/**
 * Real tRPC + isolated PostgreSQL/RLS regression for thread execution composition.
 * Only the model boundary and member authority use explicit fixtures. The bridge
 * module is loaded through the actual deployment seam; runtime, gateway, receipts,
 * plans and claims all execute production code. No supplier request is made.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";

const authority = vi.hoisted(() => vi.fn());
const model = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("../service/access-authority.js", async (original) => ({
  ...await original<typeof import("../service/access-authority.js")>(),
  currentMemberAuthority: authority,
}));
vi.mock("../service/llm.js", () => ({
  resetLlmAssembly: vi.fn(), llmCall: vi.fn(() => undefined),
  routedLlmCall: vi.fn((deps: { scene: string; taskContext?: unknown }) => {
    model.calls.push({ scene: deps.scene, taskContext: deps.taskContext });
    return async (prompt: string) => deps.scene === "intent-classify"
      ? JSON.stringify({ mode: prompt.slice(prompt.lastIndexOf("<user_input>")).includes("有多少") ? "ask"
        : prompt.slice(prompt.lastIndexOf("<user_input>")).includes("逐步") ? "agent" : "quest", rationale: "Explicit no-cost fixture" })
      : JSON.stringify([{ tool: "archive.read", action: "archive.read", objectType: "archive", params: { fixture: true }, label: "读取隔离档案" }]);
  }),
}));
import { closeAllPools, getAppPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { appRouter } from "./router.js";
import { resetToolExecutorCache } from "../runtime/tool-executor.js";
import { registerIndustryThreadExecutor, runQuestForThread } from "../runtime/thread-runner.js";
import { claimDispatchRequest, dispatchFingerprint, settleDispatchRequest } from "../runtime/thread-dispatch-request.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL)
  && Boolean(process.env.DATABASE_GATEWAY_URL);

describe.runIf(RUN_DB)("线程派单/重跑真实 PG 装配回归（无付费模型）", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID();
  const scope = { tenantId: `tenant-exec-${suffix}`, workspaceId: `ws-exec-${suffix}` };
  const foreign = { tenantId: `tenant-exec-other-${suffix}`, workspaceId: `ws-exec-other-${suffix}` };
  const identity: Identity = {
    kind: "member", memberId: `mem-exec-${suffix}`, memberNo: "FIXTURE-OWNER", name: "隔离执行夹具",
    role: "owner", plan: "pro", ...scope,
  };
  const caller = appRouter.createCaller({ session: identity, identity, partnerIdentity: null, headers: new Headers() });
  const fixtureDir = mkdtempSync(join(tmpdir(), "eagle-thread-execution-"));
  const bridgeFile = join(fixtureDir, "bridge.mjs");
  const callFile = join(fixtureDir, "calls.jsonl");
  let seq = 0;
  const calls = () => readFileSync(callFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  async function createThread(status = "queued", target = scope) {
    const id = `TX-${suffix}-${++seq}`;
    await owner.query(
      `INSERT INTO threads(id,tenant_id,workspace_id,title,mode,status,created_by,agent_id,plan,plan_version)
       VALUES($1,$2,$3,'读取隔离档案','quest',$4,'FIXTURE-OWNER',$5,$6,1)`,
      [id, target.tenantId, target.workspaceId, status, `agt-${target.workspaceId}`, JSON.stringify([
        { stepId: "s1", tool: "archive.read", action: "archive.read", objectType: "archive", params: { fixture: true }, label: "读取隔离档案" },
      ])],
    );
    return id;
  }
  beforeAll(async () => {
    authority.mockImplementation(async (current: Identity) => ({ identity: current, permissions: {} }));
    for (const target of [scope, foreign]) {
      await owner.query(`INSERT INTO tenants(id,name,plan) VALUES($1,'隔离执行租户','pro')`, [target.tenantId]);
      await owner.query(`INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'隔离执行工作区',$1,'general','operating')`, [target.workspaceId, target.tenantId]);
      await owner.query(`INSERT INTO profiles(workspace_id,tenant_id,industry,archive) VALUES($1,$2,'general','{"dataMode":"real","fixture":true}')`, [target.workspaceId, target.tenantId]);
      await owner.query(`INSERT INTO agents(id,workspace_id,preset_key,name,version,kind,meta) VALUES($1,$2,'fixture-worker','隔离档案员','v1','coordinator',$3)`,
        [`agt-${target.workspaceId}`, target.workspaceId, JSON.stringify({ tools: [{ name: "archive.read", access: "read", desc: "读取隔离档案" }] })]);
    }
    writeFileSync(bridgeFile, `import { appendFileSync } from 'node:fs';
export const TOOL_PATTERNS=['archive.read'];
export function createToolExecutorForScope(scope) { return async (name,params)=>{
 appendFileSync(${JSON.stringify(callFile)},JSON.stringify({scope,name,params})+'\\n');
 await new Promise(resolve=>setTimeout(resolve,80));
 return {result:{fixture:true},receipt:{mode:'real',synced:true,snapshot_uri:'fixture://isolated-archive',verified_at:new Date().toISOString()}};
}; }
`);
  });
  beforeEach(() => {
    process.env.LLM_PROVIDER = "mock";
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULE;
    process.env.WORKLOOM_TOOL_EXECUTOR_MODULES = bridgeFile;
    resetToolExecutorCache();
    registerIndustryThreadExecutor(null);
    writeFileSync(callFile, "");
    model.calls.length = 0;
  });
  afterAll(async () => {
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
    resetToolExecutorCache();
    await closeAllPools();
    await owner.end();
    rmSync(fixtureDir, { recursive: true, force: true });
    // Append-only database events intentionally remain in the isolated test DB.
  });

  it("立即派单使用部署桥，真实回执完成且只调用一次", async () => {
    const out = await caller.threads.dispatch({ title: "生成隔离档案分析", presetKey: "fixture-worker", runImmediately: true });
    expect(out).toMatchObject({ kind: "routed", status: "completed", stepsDone: 1, stepsTotal: 1 });
    expect(calls()).toHaveLength(1);
  });
  it("手动重跑使用相同部署桥，错误与计划信息可回读", async () => {
    const threadId = await createThread();
    expect(await caller.threads.run({ threadId })).toMatchObject({ status: "completed", stepsDone: 1 });
    expect(calls()).toHaveLength(1);
    expect(await caller.threads.get({ threadId })).toMatchObject({ error: null, plan_version: 1, executionSource: "generic" });
  });
  it("并发重跑原子认领，只有一个桥调用", async () => {
    const threadId = await createThread();
    const out = await Promise.all([caller.threads.run({ threadId }), caller.threads.run({ threadId })]);
    expect(out.some(item => item.status === "completed")).toBe(true);
    expect(calls()).toHaveLength(1);
  });
  it("无桥时保留未核实错误，重跑不重发未知动作", async () => {
    delete process.env.WORKLOOM_TOOL_EXECUTOR_MODULES;
    resetToolExecutorCache();
    const threadId = await createThread();
    expect(await caller.threads.run({ threadId })).toMatchObject({ status: "failed", unverified: ["s1"] });
    const thread = await caller.threads.get({ threadId });
    expect(thread?.error).toContain("未核实");
    expect(thread?.current_action).toBe("读取隔离档案");
    expect(await caller.threads.run({ threadId })).toMatchObject({ status: "failed", unverified: ["s1"] });
    expect(calls()).toHaveLength(0);
  });
  it("跨工作区读取为空、执行被拒且桥无调用", async () => {
    const threadId = await createThread("queued", foreign);
    expect(await caller.threads.get({ threadId })).toBeNull();
    await expect(caller.threads.run({ threadId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls()).toHaveLength(0);
  });
  it("ask入口保留即时事实应答，不误进入工具执行", async () => {
    const out = await caller.threads.dispatch({ title: "当前有多少进行中的任务？", presetKey: "fixture-worker", runImmediately: true });
    expect(out).toMatchObject({ kind: "routed", mode: "ask", status: "completed" });
    expect(out).toHaveProperty("answer");
    expect(calls()).toHaveLength(0);
  });
  it("agent即时入口保留每步人工确认，不提前执行部署桥", async () => {
    const out = await caller.threads.dispatch({ title: "逐步整理隔离档案", presetKey: "fixture-worker", runImmediately: true });
    expect(out).toMatchObject({ kind: "routed", mode: "agent", status: "pending_review", stepsDone: 0, stepsTotal: 1 });
    expect(out).toHaveProperty("pendingApprovalId");
    expect(calls()).toHaveLength(0);
  });
  it("同requestId重复提交返回同线程，不重复分类或执行", async () => {
    const input = { requestId: randomUUID(), title: "生成幂等隔离档案分析", presetKey: "fixture-worker", runImmediately: true };
    const first = await caller.threads.dispatch(input);
    const second = await caller.threads.dispatch(input);
    expect(first).toMatchObject({ kind: "routed", status: "completed" });
    expect(second).toMatchObject({ threadId: "threadId" in first ? first.threadId : undefined });
    expect(calls()).toHaveLength(1);
    expect(model.calls.filter(item => item.scene === "intent-classify")).toHaveLength(1);
    expect(model.calls.find(item => item.scene === "quest-plan")?.taskContext).toEqual({
      threadId: "threadId" in first ? first.threadId : undefined, requestId: input.requestId,
    });
  });
  it("同requestId并发提交至多一条线程，查询能恢复原结果", async () => {
    const input = { requestId: randomUUID(), title: "生成并发幂等档案分析", presetKey: "fixture-worker", runImmediately: true };
    const out = await Promise.all([caller.threads.dispatch(input), caller.threads.dispatch(input)]);
    expect(out.some(item => item.kind === "routed")).toBe(true);
    const recovered = await caller.threads.dispatchRequest({ requestId: input.requestId });
    expect(recovered).toMatchObject({ kind: "routed", status: "completed" });
    expect(calls()).toHaveLength(1);
    expect(model.calls.filter(item => item.scene === "intent-classify")).toHaveLength(1);
    const threadIds = out.filter(item => item.kind === "routed").map(item => "threadId" in item ? item.threadId : null);
    expect(new Set(threadIds).size).toBe(1);
  });
  it("同requestId更换目标拒绝，不能借原key发起新付费任务", async () => {
    const input = { requestId: randomUUID(), title: "生成绑定目标档案分析", presetKey: "fixture-worker", runImmediately: true };
    await caller.threads.dispatch(input);
    await expect(caller.threads.dispatch({ ...input, title: "另一个目标" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls()).toHaveLength(1);
    expect(model.calls.filter(item => item.scene === "intent-classify")).toHaveLength(1);
  });
  it("查询请求按当前scope隔离且未知key不创建任务", async () => {
    const requestId = randomUUID();
    expect(await caller.threads.dispatchRequest({ requestId })).toEqual({ kind: "not-found", requestId });
    const input = { requestId, title: "生成作用域档案分析", presetKey: "fixture-worker", runImmediately: true };
    await caller.threads.dispatch(input);
    const otherIdentity = { ...identity, ...foreign };
    const other = appRouter.createCaller({ session: otherIdentity, identity: otherIdentity, partnerIdentity: null, headers: new Headers() });
    expect(await other.threads.dispatchRequest({ requestId })).toEqual({ kind: "not-found", requestId });
  });
  it("持久claim无result时只读恢复为dispatching，不重新购买分类", async () => {
    const input = { requestId: randomUUID(), title: "生成响应未知隔离档案", presetKey: "fixture-worker", runImmediately: true };
    expect(await claimDispatchRequest(scope, identity.memberNo, input.requestId, dispatchFingerprint(input))).toEqual({ claimed: true });
    const reconnected = appRouter.createCaller({ session: identity, identity, partnerIdentity: null, headers: new Headers() });
    expect(await reconnected.threads.dispatch(input)).toEqual({ kind: "dispatching", requestId: input.requestId });
    expect(await reconnected.threads.dispatchRequest({ requestId: input.requestId })).toEqual({ kind: "dispatching", requestId: input.requestId });
    expect(model.calls).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });
  it("request.result缺失仍从已落thread.dispatch恢复原线程", async () => {
    const input = { requestId: randomUUID(), title: "生成建档后响应未知隔离档案", presetKey: "fixture-worker", runImmediately: false };
    await claimDispatchRequest(scope, identity.memberNo, input.requestId, dispatchFingerprint(input));
    const threadId = await createThread();
    const client = await getAppPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await gatewayAppendOnClient(client, { ...scope, actor: { id: identity.memberNo, type: "human" }, sessionId: threadId }, {
        who: { id: identity.memberNo, type: "human" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
        object: { type: "thread", id: threadId },
        decision: { action: "thread.dispatch", after: { execution_request_id: input.requestId, mode: "quest", via: "rule" } }, rule_impact: [],
      });
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect(await caller.threads.dispatchRequest({ requestId: input.requestId })).toMatchObject({ kind: "routed", threadId, status: "queued" });
    expect(await caller.threads.dispatch(input)).toMatchObject({ kind: "routed", threadId, status: "queued" });
    expect(model.calls).toHaveLength(0);
    expect(calls()).toHaveLength(0);
    // Close the fixture queue row without deleting its append-only history.
    await owner.query(`UPDATE threads SET status='cancelled' WHERE id=$1`, [threadId]);
  });
  it("非法requestId、未认证和只读成员在分类前拒绝", async () => {
    const input = { requestId: randomUUID(), title: "生成权限边界隔离档案", presetKey: "fixture-worker", runImmediately: true };
    await expect(caller.threads.dispatch({ ...input, requestId: "not-a-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const anonymous = appRouter.createCaller({ session: null, identity: null, partnerIdentity: null, headers: new Headers() });
    await expect(anonymous.threads.dispatch(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const readonly = { ...identity, role: "readonly" as const };
    const restricted = appRouter.createCaller({ session: readonly, identity: readonly, partnerIdentity: null, headers: new Headers() });
    await expect(restricted.threads.dispatch(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(model.calls).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });
  it("请求恢复以线程当前error覆盖旧失败快照，完成后不继续展示旧错误", async () => {
    const input = { requestId: randomUUID(), title: "生成恢复后的隔离档案", presetKey: "fixture-worker", runImmediately: false };
    await claimDispatchRequest(scope, identity.memberNo, input.requestId, dispatchFingerprint(input));
    const threadId = await createThread("failed");
    const client = await getAppPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await client.query(`UPDATE threads SET error='旧失败原因',current_action='原失败步骤' WHERE id=$1`, [threadId]);
      await gatewayAppendOnClient(client, { ...scope, actor: { id: identity.memberNo, type: "human" }, sessionId: threadId }, {
        who: { id: identity.memberNo, type: "human" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
        object: { type: "thread", id: threadId },
        decision: { action: "thread.dispatch", after: { execution_request_id: input.requestId, mode: "quest", via: "rule" } }, rule_impact: [],
      });
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect(await settleDispatchRequest(scope, identity.memberNo, input.requestId, {
      kind: "routed", mode: "quest", via: "rule", threadId, status: "failed", error: "旧失败原因", current_action: "原失败步骤",
    })).toMatchObject({ status: "failed", error: "旧失败原因" });
    await owner.query(`UPDATE threads SET status='completed',error=NULL,current_action='已核对',progress_done=1,progress_total=1 WHERE id=$1`, [threadId]);
    const recovered = await caller.threads.dispatchRequest({ requestId: input.requestId });
    expect(recovered).toMatchObject({ status: "completed", current_action: "已核对", stepsDone: 1, stepsTotal: 1 });
    expect("error" in recovered ? recovered.error : undefined).toBeUndefined();
    expect(calls()).toHaveLength(0); expect(model.calls).toHaveLength(0);
  });
  it.each(["obvious-token", "configured-key", "private-key", "bearer-token", "jwt-token", "configured-db-password"])("%s误粘到派单目标时在分类与业务持久化前拒绝", async kind => {
    const saved = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DATABASE_URL: process.env.DATABASE_URL };
    const secret = kind === "configured-key" ? "fixture-configured-credential-not-real"
      : kind === "private-key" ? "-----BEGIN RSA PRIVATE KEY-----\nfixture-not-real"
        : kind === "bearer-token" ? `bearer ${"fixture-not-real-".repeat(3)}`
          : kind === "jwt-token" ? `eyJ${"fixture_only".repeat(2)}.${"fixture_only".repeat(2)}.${"fixture_only".repeat(2)}`
            : kind === "configured-db-password" ? "fixture-db-password-not-real" : `sk-${"fixture-only-not-a-real-key".repeat(2)}`;
    if (kind === "configured-key") process.env.DEEPSEEK_API_KEY = secret;
    if (kind === "configured-db-password") {
      const url = new URL(saved.DATABASE_URL!); url.password = secret; process.env.DATABASE_URL = url.href;
    }
    const before = await owner.query(`SELECT (SELECT count(*)::int FROM threads WHERE workspace_id=$1) AS threads,
      (SELECT count(*)::int FROM biz_events WHERE workspace_id=$1) AS events`, [scope.workspaceId]);
    try {
      await expect(caller.threads.dispatch({ requestId: randomUUID(), title: `生成隔离档案分析 ${secret}`, presetKey: "fixture-worker", runImmediately: true }))
        .rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(model.calls).toHaveLength(0);
      expect(calls()).toHaveLength(0);
      const after = await owner.query(`SELECT (SELECT count(*)::int FROM threads WHERE workspace_id=$1) AS threads,
        (SELECT count(*)::int FROM biz_events WHERE workspace_id=$1) AS events`, [scope.workspaceId]);
      expect(after.rows).toEqual(before.rows);
    } finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  });
  it.each(["presetKey", "goalRef"])("%s含凭据时也在分类和日志输出前拒绝", async field => {
    const credential = `sk-${"fixture-only-not-a-real-key".repeat(2)}`;
    await expect(caller.threads.dispatch({ title: "生成隔离档案分析", presetKey: "fixture-worker", [field]: credential, runImmediately: true }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(model.calls).toHaveLength(0); expect(calls()).toHaveLength(0);
  });
  it("续跑与调度入口的目标凭据同样在认领/执行前拒绝", async () => {
    const threadId = await createThread();
    const goal = `读取隔离档案 sk-${"fixture-only-not-a-real-key".repeat(2)}`;
    await expect(caller.threads.run({ threadId, goal })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(runQuestForThread(scope, { threadId, goal })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls()).toHaveLength(0); expect(model.calls).toHaveLength(0);
    expect((await owner.query(`SELECT status FROM threads WHERE id=$1`, [threadId])).rows[0].status).toBe("queued");
  });
  it.each(["completed", "cancelled"])("%s终态不能再次进入桥执行", async status => {
    const threadId = await createThread(status);
    expect(await caller.threads.run({ threadId })).toMatchObject({ status });
    expect(calls()).toHaveLength(0);
  });
  it("runner核验tenant与workspace绑定，错误租户不能借workspace进入hook", async () => {
    const hook = vi.fn(async () => undefined);
    registerIndustryThreadExecutor(hook);
    const threadId = await createThread();
    await expect(runQuestForThread({ ...scope, tenantId: foreign.tenantId }, { threadId, goal: "读取隔离档案" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(hook).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(0);
  });
  it("未由调度器认领的queued行不能使用skipClaim绕过", async () => {
    const threadId = await createThread();
    await expect(runQuestForThread(scope, { threadId, goal: "读取隔离档案", skipClaim: true }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls()).toHaveLength(0);
  });
  it.each(["paused", "cancelled"] as const)("行业hook的%s控制态保留，来源和预算关联可回读", async status => {
    const input = { requestId: randomUUID(), title: "生成受控隔离档案", presetKey: "fixture-worker", runImmediately: false };
    const created = await caller.threads.dispatch(input);
    if (created.kind !== "routed") throw new Error("fixture dispatch not routed");
    const hook = vi.fn(async (ctx: Parameters<NonNullable<Parameters<typeof registerIndustryThreadExecutor>[0]>>[0]) => {
      expect(ctx.taskContext).toEqual({ threadId: created.threadId, requestId: input.requestId });
      expect(ctx.input.actorId).toBe(identity.memberNo);
      const client = await getAppPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
        await gatewayAppendOnClient(client, { ...scope, actor: { id: identity.memberNo, type: "human" }, sessionId: created.threadId }, {
          who: { id: identity.memberNo, type: "human" },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
          object: { type: "thread", id: created.threadId },
          decision: { action: "thread.execution.bound", after: { executionSource: "controlled-fixture" } }, rule_impact: [],
        });
        await client.query(`UPDATE threads SET status=$2,current_action='夹具已控制',updated_at=now() WHERE id=$1`, [created.threadId, status]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      return { threadId: created.threadId, status, stepsDone: 0, stepsTotal: 1, unverified: [], presetKey: ctx.presetKey, executionSource: "controlled-fixture" };
    });
    registerIndustryThreadExecutor(hook);
    expect(await caller.threads.run({ threadId: created.threadId })).toMatchObject({ status, executionSource: "controlled-fixture" });
    expect(await caller.threads.get({ threadId: created.threadId })).toMatchObject({ status, executionSource: "controlled-fixture", current_action: "夹具已控制" });
    expect(await caller.threads.dispatchRequest({ requestId: input.requestId })).toMatchObject({ status, executionSource: "controlled-fixture" });
    expect(await caller.threads.run({ threadId: created.threadId })).toMatchObject({ status, executionSource: "controlled-fixture" });
    expect(await caller.threads.get({ threadId: created.threadId })).toMatchObject({ status, current_action: "夹具已控制" });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(0);
  });
  it("未绑定行业控制的通用paused任务仍可按原有入口续跑", async () => {
    const threadId = await createThread("paused");
    expect(await caller.threads.run({ threadId })).toMatchObject({ status: "completed", executionSource: "generic" });
    expect(calls()).toHaveLength(1);
  });
  it("行业hook返回undefined才回通用工具，失败异常不悬空running", async () => {
    const threadId = await createThread();
    const hook = vi.fn(async () => undefined);
    registerIndustryThreadExecutor(hook);
    expect(await caller.threads.run({ threadId })).toMatchObject({ status: "completed", executionSource: "generic" });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(1);
    const failed = await createThread();
    registerIndustryThreadExecutor(async () => { throw new Error("fixture-private-adapter-internal"); });
    await expect(caller.threads.run({ threadId: failed })).rejects.toThrow("fixture-private-adapter-internal");
    const result = await caller.threads.get({ threadId: failed });
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("任务执行中断");
    expect(result?.error).not.toContain("fixture-private-adapter-internal");
  });
});
