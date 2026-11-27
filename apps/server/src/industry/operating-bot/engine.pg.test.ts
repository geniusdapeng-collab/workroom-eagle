/** Lease/concurrency/RLS and native brief artifact checks against the existing isolated PG suite. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { executeOperatingBrief } from "../business/operating-service.js";
import { OperatingBot, type OperatingBotActor, type OperatingBotScope } from "./engine.js";

const runDb = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL);
const baseTime = "2026-01-05T00:00:00.000Z";

describe.runIf(runDb)("Eagle Operating BOT on PostgreSQL", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  afterAll(async () => { await Promise.all([owner.end(), app.end()]); });

  async function fixture(sameTenant?: string) {
    const suffix = randomUUID();
    const scope = { tenantId: sameTenant ?? `tenant-bot-${suffix}`, workspaceId: `ws-bot-${suffix}` };
    const actor = { memberId: `owner-bot-${suffix}`, memberNo: "BOT-OWNER" };
    const manager = { memberId: `manager-bot-${suffix}`, memberNo: "BOT-MANAGER" };
    if (!sameTenant) await owner.query("INSERT INTO tenants(id,name) VALUES($1,'隔离BOT测试')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'隔离BOT测试',$1,'consulting')",
      [scope.workspaceId, scope.tenantId]);
    await Promise.all([makeMember(scope, actor, "owner"), makeMember(scope, manager, "manager")]);
    let now = new Date(baseTime);
    // The core tests isolate the SQL path. The normal worker binds/verifies
    // the actual active Bundle; a separate integration smoke uses that path.
    const createEngine = () => new OperatingBot({ pool: () => app, now: () => now, assertWorkspace: async () => undefined });
    const bot = createEngine();
    return { scope, actor, manager, bot, createEngine, setNow: (value: string) => { now = new Date(value); } };
  }

  async function makeMember(scope: OperatingBotScope, actor: OperatingBotActor, role: string) {
    await owner.query("INSERT INTO members(id,workspace_id,member_no,name,role,status) VALUES($1,$2,$3,$3,$4,'active')",
      [actor.memberId, scope.workspaceId, actor.memberNo, role]);
  }

  function newMandate(scope: OperatingBotScope) {
    return { businessUnit: scope.workspaceId, expiresAt: "2026-01-08T01:00:00.000Z",
      maxRuns: 3, maxRuntimeSeconds: 10, idempotencyKey: "mandate-test-stable-key" };
  }

  it("idempotently accepts a bounded mandate and a manual task, then settles one immutable artifact across two workers", async () => {
    const { scope, actor, manager, bot, createEngine } = await fixture();
    await expect(bot.createMandate(scope, manager, newMandate(scope))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const original = newMandate(scope);
    const mandates = await Promise.all([bot.createMandate(scope, actor, original), createEngine().createMandate(scope, actor, original)]);
    expect(mandates[0]).toEqual(mandates[1]);
    await expect(bot.createMandate(scope, actor, { ...original, maxRuns: 2 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const request = { mandateId: mandates[0].id, businessDate: "2026-01-05", idempotencyKey: "manual-task-stable-key" };
    const [accepted, repeated] = await Promise.all([bot.enqueueManual(scope, manager, request), createEngine().enqueueManual(scope, manager, request)]);
    expect(repeated).toEqual(accepted);
    await expect(bot.enqueueManual(scope, manager, { ...request, businessDate: "2026-01-04" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(accepted).toMatchObject({ status: "queued", result: null, attempts: 0, trigger: "manual" });
    const [left, right] = await Promise.all([bot.runOnce(scope, executeOperatingBrief), createEngine().runOnce(scope, executeOperatingBrief)]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    const completed = await bot.getTask(scope, accepted.id);
    expect(completed).toMatchObject({ status: "succeeded", attempts: 1,
      result: { artifactId: expect.any(String), eventId: expect.any(String), hash: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    const rows = await owner.query("SELECT id FROM eagle_business_briefs WHERE workspace_id=$1", [scope.workspaceId]);
    expect(rows.rows).toEqual([{ id: completed.result!.artifactId }]);
    const page = await bot.listEvents(scope, { taskId: completed.id, limit: 2 });
    expect(page.events.map((event) => event.action)).toEqual(["eagle.bot.task.accepted", "eagle.bot.task.started"]);
    const final = await bot.listEvents(scope, { taskId: completed.id, after: page.nextCursor });
    expect(final.events).toMatchObject([{ action: "eagle.bot.task.succeeded", eventId: completed.receipt.eventId, hash: completed.receipt.hash }]);
    await expect(bot.listEvents(scope, { taskId: completed.id, after: "not-a-cursor" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(bot.listEvents(scope, { taskId: completed.id, after: "9223372036854775808" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await bot.listMandates(scope))[0]?.usedRuns).toBe(1);
  });

  it("preserves each due window and catches up after process restarts without running overdue or duplicate windows", async () => {
    const { scope, actor, bot, createEngine, setNow } = await fixture();
    const mandate = await bot.createMandate(scope, actor, { ...newMandate(scope), dailyAt: "08:30" });
    expect(mandate.nextDueAt).toBe("2026-01-05T00:30:00.000Z");
    expect(await bot.scheduleDue(scope)).toBe(0);
    setNow("2026-01-06T01:00:00.000Z");

    expect((await Promise.all([bot.scheduleDue(scope), createEngine().scheduleDue(scope)])).reduce((a, b) => a + b)).toBe(1);
    expect(await createEngine().scheduleDue(scope)).toBe(1);
    expect(await bot.scheduleDue(scope)).toBe(0);
    const completed = await createEngine().runOnce(scope, executeOperatingBrief);
    expect(completed).toMatchObject({ scheduledAt: "2026-01-06T00:30:00.000Z", asOf: "2026-01-06T00:30:00.000Z", status: "succeeded" });
    const tasks = await bot.listTasks(scope);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.businessDate === "2026-01-05")).toMatchObject({ status: "failed", errorCode: "DEADLINE_EXCEEDED", attempts: 0 });
    expect((await bot.listMandates(scope))[0]).toMatchObject({ usedRuns: 2, nextDueAt: "2026-01-07T00:30:00.000Z" });
  });

  it("recovers an expired durable lease and consumes only one signed run", async () => {
    const { scope, actor, bot, createEngine, setNow } = await fixture();
    const mandate = await bot.createMandate(scope, actor, { ...newMandate(scope), maxRuns: 1 });
    const task = await bot.enqueueManual(scope, actor, { mandateId: mandate.id, businessDate: "2026-01-05", idempotencyKey: "manual-lease-crash" });
    const abandoned = await bot["claim"](scope);
    expect(abandoned).toMatchObject({ id: task.id, attempts: 1, status: "running" });
    expect(await createEngine().runOnce(scope, executeOperatingBrief)).toBeNull();
    setNow("2026-01-05T00:00:16.000Z");
    const completed = await createEngine().runOnce(scope, executeOperatingBrief);
    expect(completed).toMatchObject({ id: task.id, attempts: 2, status: "succeeded" });
    const attempts = await owner.query("SELECT status,lease_token FROM eagle_bot_attempts WHERE task_id=$1 ORDER BY attempt_no", [task.id]);
    expect(attempts.rows.map((attempt) => attempt.status)).toEqual(["expired", "succeeded"]);
    expect(new Set(attempts.rows.map((attempt) => attempt.lease_token)).size).toBe(2);
    expect((await bot.listMandates(scope))[0]?.usedRuns).toBe(1);
    await expect(bot.enqueueManual(scope, actor, { mandateId: mandate.id, businessDate: "2026-01-05", idempotencyKey: "manual-cap-exhausted" }))
      .rejects.toMatchObject({ code: "MANDATE_EXHAUSTED" });
  });

  it("revokes or cancels pending tasks, checks the current issuer authority, and refuses cross-scope reads", async () => {
    const { scope, actor, manager, bot } = await fixture();
    const sibling = await fixture(scope.tenantId);
    const other = await fixture();
    const mandate = await bot.createMandate(scope, actor, newMandate(scope));
    const request = { mandateId: mandate.id, businessDate: "2026-01-05", idempotencyKey: "manual-stopsafe-01" };
    const queued = await bot.enqueueManual(scope, actor, request);
    for (const target of [sibling.scope, other.scope]) {
      expect(await bot.listTasks(target)).toEqual([]);
      expect(await bot.listMandates(target)).toEqual([]);
      await expect(bot.getTask(target, queued.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(bot.listEvents(target, { taskId: queued.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const bypassRlsFixture = new OperatingBot({ pool: () => owner, assertWorkspace: async () => undefined });
    expect(await bypassRlsFixture.listTasks(other.scope)).toEqual([]);
    expect(await bypassRlsFixture.listMandates(other.scope)).toEqual([]);
    await expect(bypassRlsFixture.getTask(other.scope, queued.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(bot.revokeMandate(scope, manager, mandate.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cancelled = await bot.cancelTask(scope, manager, queued.id);
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "CANCELLED", attempts: 0 });
    expect(await bot.cancelTask(scope, manager, queued.id)).toEqual(cancelled);

    const task = await bot.enqueueManual(scope, manager, { ...request, idempotencyKey: "manual-before-revoke" });
    const revoked = await bot.revokeMandate(scope, actor, mandate.id);
    expect(await bot.revokeMandate(scope, actor, mandate.id)).toEqual(revoked);
    expect((await bot.runOnce(scope, executeOperatingBrief))).toMatchObject({ id: task.id, status: "failed", errorCode: "MANDATE_INACTIVE", attempts: 0 });
    await expect(bot.enqueueManual(scope, manager, { ...request, idempotencyKey: "manual-after-revoke" })).rejects.toMatchObject({ code: "MANDATE_INACTIVE" });

    const next = await bot.createMandate(scope, actor, { ...newMandate(scope), idempotencyKey: "new-delegation-after-stop" });
    const second = await bot.enqueueManual(scope, manager, { ...request, mandateId: next.id, idempotencyKey: "manual-before-issuer-revoked" });
    await owner.query("UPDATE members SET permissions='{\"deny\":[\"workspace.configure\"]}' WHERE id=$1", [actor.memberId]);
    expect(await bot.runOnce(scope, executeOperatingBrief)).toMatchObject({ id: second.id, status: "failed", errorCode: "MANDATE_INACTIVE", attempts: 0 });
    await expect(bot.createMandate(scope, actor, { ...newMandate(scope), idempotencyKey: "new-delegation-revoked-config" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await owner.query("UPDATE members SET permissions='{\"deny\":[\"workspace.write\"]}' WHERE id=$1", [manager.memberId]);
    await expect(bot.enqueueManual(scope, manager, { ...request, mandateId: next.id, idempotencyKey: "manual-disallowed-write" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rolls back native proof that does not belong to the returned artifact and retries known transient SQL errors", async () => {
    const { scope, actor, bot, setNow } = await fixture();
    const mandate = await bot.createMandate(scope, actor, newMandate(scope));
    const request = { mandateId: mandate.id, businessDate: "2026-01-05", idempotencyKey: "manual-proof-mismatch" };
    const task = await bot.enqueueManual(scope, actor, request);
    const mismatch = await bot.runOnce(scope, async (...args) => {
      const result = await executeOperatingBrief(...args);
      return { ...result, artifactId: randomUUID() };
    });
    expect(mismatch).toMatchObject({ id: task.id, status: "failed", attempts: 1, result: null, errorCode: "EXECUTION_FAILED" });
    expect((await owner.query("SELECT id FROM eagle_business_briefs WHERE workspace_id=$1", [scope.workspaceId])).rowCount).toBe(0);
    expect((await owner.query("SELECT 1 FROM biz_events WHERE session_id=$1 AND payload#>>'{object,type}'='operating_brief'", [task.id])).rowCount).toBe(0);

    const retryTask = await bot.enqueueManual(scope, actor, { ...request, idempotencyKey: "manual-proof-retry" });
    const restart = await bot.runOnce(scope, async () => { throw Object.assign(new Error("temporary SQL error"), { code: "40001" }); });
    expect(restart).toMatchObject({ id: retryTask.id, status: "queued", attempts: 1 });
    expect(await bot.runOnce(scope, executeOperatingBrief)).toBeNull();
    setNow("2026-01-05T00:00:02.000Z");
    expect(await bot.runOnce(scope, executeOperatingBrief)).toMatchObject({ id: retryTask.id, status: "succeeded", attempts: 2 });
  });

  it("reports scoped worker presence and expires freshness without affecting task history", async () => {
    const { scope, bot, setNow } = await fixture();
    const other = await fixture();
    expect(await bot.getWorkerStatus(scope)).toEqual({ state: "never", lastSeenAt: null, lastSuccessfulTickAt: null });
    await bot.markWorkerPresence(scope, true);
    setNow("2026-01-05T00:00:10.000Z");
    await bot.markWorkerPresence(scope, false);
    expect(await bot.getWorkerStatus(scope)).toEqual({ state: "online", lastSeenAt: "2026-01-05T00:00:10.000Z", lastSuccessfulTickAt: baseTime });
    expect((await bot.getWorkerStatus(other.scope)).state).toBe("never");
    setNow("2026-01-05T00:00:41.000Z");
    expect((await bot.getWorkerStatus(scope)).state).toBe("stale");
  });

  it("rejects a matching receipt if the native artifact does not exist", async () => {
    const { scope, actor, bot } = await fixture();
    const mandate = await bot.createMandate(scope, actor, newMandate(scope));
    const task = await bot.enqueueManual(scope, actor, { mandateId: mandate.id, businessDate: "2026-01-05", idempotencyKey: "manual-event-only" });
    const artifactId = randomUUID();
    const attempt = await bot.runOnce(scope, async (client, current, args) => {
      const created = await gatewayAppendOnClient(client, { ...current, actor: { type: "system", id: "system" }, sessionId: args.taskId }, {
        who: { type: "system", id: "system" },
        context: { tenant_id: current.tenantId, workspace_id: current.workspaceId, time: args.asOf },
        object: { type: "operating_brief", id: artifactId },
        decision: { action: "eagle.operating.brief.ready", after: { taskId: args.taskId, artifactId, contentHash: "a".repeat(64) } },
        rule_impact: [],
        receipt: { mode: "real", synced: true, verified_at: args.asOf },
      });
      return { artifactId, eventId: created.eventId, hash: created.hash };
    });
    expect(attempt).toMatchObject({ id: task.id, status: "failed", attempts: 1, result: null, errorCode: "EXECUTION_FAILED" });
    expect((await owner.query("SELECT 1 FROM biz_events WHERE session_id=$1 AND payload#>>'{object,type}'='operating_brief'", [task.id])).rowCount).toBe(0);
  });

  it("lists every open task ahead of independently bounded history and preserves a daily occurrence at queue capacity", async () => {
    const { scope, actor, bot, setNow } = await fixture();
    const mandate = await bot.createMandate(scope, actor, { ...newMandate(scope), maxRuns: 90, dailyAt: "08:30" });
    const enqueue = (index: number) => bot.enqueueManual(scope, actor, {
      mandateId: mandate.id, businessDate: "2026-01-05", idempotencyKey: `queue-capacity-${index}`,
    });
    const open = [];
    for (let index = 0; index < 40; index++) open.push(await enqueue(index));
    await expect(enqueue(40)).rejects.toMatchObject({ code: "QUEUE_FULL" });
    setNow("2026-01-05T00:30:01.000Z");
    expect(await bot.scheduleDue(scope)).toBe(0);
    expect((await bot.listMandates(scope))[0]?.nextDueAt).toBe("2026-01-05T00:30:00.000Z");
    await bot.cancelTask(scope, actor, open[0]!.id);
    expect(await bot.scheduleDue(scope)).toBe(1);
    const displayed = await bot.listTasks(scope, { limit: 1 });
    expect(displayed).toHaveLength(41);
    expect(displayed.slice(0, 40).every((task) => task.status === "queued")).toBe(true);
    expect(displayed[40]).toMatchObject({ id: open[0]!.id, status: "cancelled" });
  });

  it("requires the verified active bundle and completes a task in a separate worker with no HTTP or browser process", async () => {
    const { scope, actor } = await fixture();
    const bot = new OperatingBot({ pool: () => app });
    const request = {
      ...newMandate(scope), expiresAt: new Date(Date.now() + 600_000).toISOString(), maxRuntimeSeconds: 15,
    };
    await expect(bot.createMandate(scope, actor, request)).rejects.toMatchObject({ code: "BUNDLE_NOT_READY" });
    const installId = `bi-bot-${randomUUID()}`;
    await owner.query("UPDATE workspaces SET bundle_id='consulting' WHERE id=$1", [scope.workspaceId]);
    await owner.query("INSERT INTO bundle_installs (id,workspace_id,bundle_id) VALUES($1,$2,'consulting')", [installId, scope.workspaceId]);
    const mandate = await bot.createMandate(scope, actor, request);
    const task = await bot.enqueueManual(scope, actor, { mandateId: mandate.id, businessDate: "2026-01-05", idempotencyKey: "manual-subprocess-native" });
    await owner.query("UPDATE bundle_installs SET status='uninstalled' WHERE id=$1", [installId]);
    await expect(bot.runOnce(scope, executeOperatingBrief)).rejects.toMatchObject({ code: "BUNDLE_NOT_READY" });
    expect((await bot.getTask(scope, task.id)).status).toBe("queued");
    await owner.query("UPDATE bundle_installs SET status='active' WHERE id=$1", [installId]);

    const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const worker = spawn(process.execPath, ["--import", "tsx", workerPath], {
      env: { ...process.env, WORKLOOM_BOT_TENANT_ID: scope.tenantId, WORKLOOM_BOT_WORKSPACE_ID: scope.workspaceId, WORKLOOM_BOT_POLL_MS: "250" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      worker.once("close", resolve);
      worker.once("error", reject);
    });
    try {
      const until = Date.now() + 10_000;
      let observed = await bot.getTask(scope, task.id);
      while (["queued", "running"].includes(observed.status) && worker.exitCode === null && Date.now() < until) {
        await delay(100);
        observed = await bot.getTask(scope, task.id);
      }
      expect(observed).toMatchObject({ status: "succeeded", attempts: 1, result: { artifactId: expect.any(String) } });
      let state = await bot.getWorkerStatus(scope);
      while (!state.lastSuccessfulTickAt && worker.exitCode === null && Date.now() < until) {
        await delay(100);
        state = await bot.getWorkerStatus(scope);
      }
      expect(state).toMatchObject({ state: "online", lastSuccessfulTickAt: expect.any(String) });
    } finally {
      if (worker.exitCode === null) worker.kill("SIGTERM");
      const kill = setTimeout(() => worker.kill("SIGKILL"), 3_000);
      try { await closed; } finally { clearTimeout(kill); }
    }
  }, 15_000);
});
