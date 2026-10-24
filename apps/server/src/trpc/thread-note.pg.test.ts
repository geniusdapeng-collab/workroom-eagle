/** Real mounted tRPC, current DB authority, RLS and append-only gateway; no model or external connector. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";
import type { BusinessEvent } from "@workloom/shared";
import { closeAllPools } from "@workloom/db";
import { appRouter } from "./router.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.DATABASE_APP_URL) && Boolean(process.env.DATABASE_GATEWAY_URL);

describe.runIf(RUN_DB)("任务留言真实权限、追加回执与幂等（无模型）", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = randomUUID();
  const scope = { tenantId: `tenant-note-${suffix}`, workspaceId: `ws-note-${suffix}` };
  const sibling = { tenantId: scope.tenantId, workspaceId: `ws-note-sibling-${suffix}` };
  const foreign = { tenantId: `tenant-note-foreign-${suffix}`, workspaceId: `ws-note-foreign-${suffix}` };
  const identity: Identity = { kind: "member", memberId: `mem-note-${suffix}`, memberNo: "FIXTURE-NOTE-OWNER",
    name: "隔离留言成员", role: "owner", plan: "pro", ...scope };
  const callerFor = (claim: Identity | null) => appRouter.createCaller({ session: claim, identity: claim,
    partnerIdentity: null, headers: new Headers() });
  const caller = callerFor(identity);
  let seq = 0;
  let fetchGuard: ReturnType<typeof vi.spyOn>;
  async function thread(target = scope) {
    const id = `T-note-${suffix}-${++seq}`;
    await owner.query(`INSERT INTO threads(id,tenant_id,workspace_id,title,mode,status,created_by,progress_done,progress_total)
      VALUES($1,$2,$3,'隔离留言任务','quest','paused',$4,2,6)`, [id, target.tenantId, target.workspaceId, identity.memberNo]);
    return id;
  }
  async function notes(threadId: string) {
    return (await owner.query<{ event_id: string; hash: string; session_id: string; payload: BusinessEvent }>(
      `SELECT event_id,hash,session_id,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3
       AND payload#>>'{decision,action}'='thread.note' ORDER BY seq`, [scope.tenantId, scope.workspaceId, threadId])).rows;
  }
  beforeAll(async () => {
    await owner.query(`INSERT INTO tenants(id,name,plan) VALUES($1,'隔离留言租户','pro'),($2,'隔离外区租户','pro')`, [scope.tenantId, foreign.tenantId]);
    for (const target of [scope, sibling, foreign]) await owner.query(
      `INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'隔离留言工作区',$1,'general','operating')`, [target.workspaceId, target.tenantId]);
    await owner.query(`INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,'隔离留言成员','owner')`,
      [identity.memberId, scope.workspaceId, identity.memberNo]);
    fetchGuard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external I/O in thread note regression"));
  });
  afterAll(async () => { fetchGuard.mockRestore(); await closeAllPools(); await owner.end(); });

  it("真实挂载的接口只追加线程留言，回执与事件相同且任务不推进", async () => {
    const threadId = await thread();
    const before = (await owner.query(`SELECT * FROM threads WHERE id=$1`, [threadId])).rows[0];
    const result = await caller.threads.note({ threadId, text: "请保留原始统计口径，由顾问审阅。", idempotencyKey: randomUUID() });
    const events = await notes(threadId); expect(events).toHaveLength(1);
    expect(result).toMatchObject({ threadId, receipt: { eventId: events[0]!.event_id, hash: events[0]!.hash, synced: true } });
    expect(result.receipt.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(events[0]!.payload).toMatchObject({ who: { type: "human", id: identity.memberNo }, object: { type: "thread", id: threadId },
      decision: { action: "thread.note", after: { text: "请保留原始统计口径，由顾问审阅。" } }, receipt: { mode: "real", synced: true } });
    expect((await owner.query(`SELECT * FROM threads WHERE id=$1`, [threadId])).rows[0]).toEqual(before);
    expect((await owner.query(`SELECT payload#>>'{decision,action}' AS action FROM biz_events WHERE session_id=$1`, [threadId])).rows)
      .toEqual([{ action: "thread.note" }]);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("相同键重传和并发只写一次，回读原始回执", async () => {
    const threadId = await thread(); const input = { threadId, text: "同一条留言只应记录一次", idempotencyKey: randomUUID() };
    const results = await Promise.all([caller.threads.note(input), caller.threads.note(input)]);
    expect(results[1]).toEqual(results[0]); expect(await caller.threads.note(input)).toEqual(results[0]);
    expect(await notes(threadId)).toHaveLength(1);
  });
  it("同一键换正文或操作者冲突，不覆盖历史", async () => {
    const threadId = await thread(); const input = { threadId, text: "第一版真实留言", idempotencyKey: randomUUID() };
    await caller.threads.note(input);
    await expect(caller.threads.note({ ...input, text: "被更换的留言" })).rejects.toMatchObject({ code: "CONFLICT" });
    const other = { ...identity, memberId: `mem-note-other-${suffix}`, memberNo: "FIXTURE-NOTE-OTHER" };
    await owner.query(`INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,'隔离另一成员','owner')`, [other.memberId, scope.workspaceId, other.memberNo]);
    await expect(callerFor(other).threads.note(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await notes(threadId)).toHaveLength(1);
  });
  it("同键在其他线程和授权工作区独立使用，特殊字符原样保存但不执行", async () => {
    const idempotencyKey = randomUUID(); const text = "留言：引文「甲」\n含emoji🦅、引号\"与反斜杠\\、<script>只是文本</script>。";
    const firstThread = await thread(); const secondThread = await thread();
    const first = await caller.threads.note({ threadId: firstThread, text, idempotencyKey });
    const second = await caller.threads.note({ threadId: secondThread, text, idempotencyKey });
    expect(second.receipt.eventId).not.toBe(first.receipt.eventId);
    const foreignIdentity = { ...identity, ...foreign, memberId: `mem-note-foreign-${suffix}`, memberNo: "FIXTURE-NOTE-FOREIGN" };
    await owner.query(`INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$3,'隔离外区成员','owner')`,
      [foreignIdentity.memberId, foreign.workspaceId, foreignIdentity.memberNo]);
    const thirdThread = await thread(foreign);
    const third = await callerFor(foreignIdentity).threads.note({ threadId: thirdThread, text, idempotencyKey });
    expect(third.receipt.eventId).not.toBe(first.receipt.eventId);
    expect((await notes(firstThread))[0]!.payload.decision.after).toMatchObject({ text });
    expect(await notes(thirdThread)).toHaveLength(0);
    expect((await owner.query(`SELECT payload#>>'{decision,after,text}' AS text FROM biz_events
      WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=$3`, [foreign.tenantId, foreign.workspaceId, third.receipt.eventId])).rows).toEqual([{ text }]);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
  it("不存在、同租户其他工作区、其他租户任务均无追加", async () => {
    for (const threadId of ["T-note-nonexistent", await thread(sibling), await thread(foreign)]) {
      await expect(caller.threads.note({ threadId, text: "不应写入外区的留言", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await notes(threadId)).toHaveLength(0);
    }
    const wrongTenant = { ...identity, tenantId: foreign.tenantId };
    await expect(callerFor(wrongTenant).threads.note({ threadId: await thread(), text: "伪造租户声明的留言", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("未认证拒绝，实时readonly及workspace.write显式拒绝不能借旧owner令牌追加", async () => {
    const input = { threadId: await thread(), text: "验证真实成员写权限", idempotencyKey: randomUUID() };
    await expect(callerFor(null).threads.note(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    try {
      await owner.query(`UPDATE members SET role='readonly' WHERE id=$1`, [identity.memberId]);
      await expect(caller.threads.note(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await owner.query(`UPDATE members SET role='owner',permissions='{"deny":["workspace.write"]}' WHERE id=$1`, [identity.memberId]);
      await expect(caller.threads.note(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally { await owner.query(`UPDATE members SET role='owner',permissions='{}' WHERE id=$1`, [identity.memberId]); }
    expect(await notes(input.threadId)).toHaveLength(0);
  });
  it("空白、超长、无幂等键、未知字段和非法ID在入账前拒绝；500字边界可追加", async () => {
    const threadId = await thread(); const good = { threadId, text: "边".repeat(500), idempotencyKey: randomUUID() };
    for (const patch of [{ text: "" }, { text: "   " }, { text: "字".repeat(501) }, { idempotencyKey: "" },
      { idempotencyKey: undefined }, { threadId: "../foreign" }, { status: "completed" }, { tenantId: foreign.tenantId }]) {
      await expect(caller.threads.note({ ...good, ...patch } as typeof good)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await notes(threadId)).toHaveLength(0); await caller.threads.note(good); expect(await notes(threadId)).toHaveLength(1);
  });
  it("凭据拒绝且PII只以网关脱敏后的正文入账", async () => {
    const threadId = await thread(); const saved = process.env.DEEPSEEK_API_KEY;
    try {
      process.env.DEEPSEEK_API_KEY = "fixture-note-configured-secret";
      for (const text of [`留言 sk-${"fixture-not-a-real-key".repeat(2)}`, "留言 fixture-note-configured-secret", "留言 -----BEGIN PRIVATE KEY-----"]) {
        await expect(caller.threads.note({ threadId, text, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await notes(threadId)).toHaveLength(0);
      await caller.threads.note({ threadId, text: "请顾问核对联络方式 13800138000 与 contact@example.invalid 。", idempotencyKey: randomUUID() });
      const serialized = JSON.stringify((await notes(threadId))[0]!.payload);
      expect(serialized).not.toContain("13800138000"); expect(serialized).not.toContain("contact@example.invalid"); expect(serialized).toContain("[PII:");
    } finally { if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved; }
  });
});
