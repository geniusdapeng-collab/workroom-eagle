import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withWorkspace } from "@workloom/db";
import { executeOperatingBrief, OperatingService, type OperatingFactInput, type OperatingScope } from "./operating-service.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL);
const suffix = randomUUID();
const mainWorkspace = { tenantId: `tenant-operating-${suffix}`, workspaceId: `ws-operating-${suffix}` };
const otherWorkspace = { tenantId: mainWorkspace.tenantId, workspaceId: `ws-operating-peer-${suffix}` };
const otherTenant = { tenantId: `tenant-operating-peer-${suffix}`, workspaceId: `ws-operating-outside-${suffix}` };

describe.runIf(RUN_DB)("operating evidence on real PostgreSQL", () => {
  const ownerDb = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const appDb = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const service = new OperatingService(() => appDb);
  const manager = { ...mainWorkspace, memberId: `member-man-${suffix}`, manager: true };
  const staff = { ...mainWorkspace, memberId: `member-staff-${suffix}`, manager: false };
  const peer = { ...mainWorkspace, memberId: `member-peer-${suffix}`, manager: false };
  const outsider = { ...otherWorkspace, memberId: `member-out-${suffix}`, manager: true };
  const external = { ...otherTenant, memberId: `member-ext-${suffix}`, manager: true };

  beforeAll(async () => {
    for (const tenantId of [mainWorkspace.tenantId, otherTenant.tenantId]) {
      await ownerDb.query("INSERT INTO tenants(id,name,plan) VALUES($1,'隔离经营测试','pro')", [tenantId]);
    }
    for (const workspace of [mainWorkspace, otherWorkspace, otherTenant]) {
      await ownerDb.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry) VALUES($1,$2,'隔离经营测试',$1,'consulting')", [workspace.workspaceId, workspace.tenantId]);
    }
    for (const account of [manager, staff, peer, outsider, external]) {
      await ownerDb.query("INSERT INTO members(id,workspace_id,member_no,name,role) VALUES($1,$2,$1,'经营测试成员',$3)",
        [account.memberId, account.workspaceId, account.manager ? "owner" : "staff"]);
    }
  });
  afterAll(async () => { await Promise.all([ownerDb.end(), appDb.end()]); });

  const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const lead = (dealRef: string, extra: { ownerMemberId?: string; channel?: string } = {}): OperatingFactInput =>
    ({ kind: "lead", accountRef: `account-${dealRef}`, dealRef, occurredOn: day(-1), channel: "转介绍", qualified: true, sourceKind: "manual", ...extra });
  async function confirm(scope: OperatingScope, rows: OperatingFactInput[], idempotencyKey = randomUUID()) {
    const { previewDigest } = service.previewFacts(scope, { rows });
    return service.confirmFacts(scope, { rows, previewDigest, idempotencyKey });
  }

  it("rejects cross-workspace/cross-tenant/peer facts and records concurrent idempotent capture exactly once", async () => {
    const input = lead("isolation");
    const { previewDigest } = service.previewFacts(staff, { rows: [input] });
    await expect(service.confirmFacts(staff, { rows: [input], idempotencyKey: randomUUID(), previewDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "CONFLICT" });
    const command = { rows: [input], previewDigest, idempotencyKey: randomUUID() };
    const [left, right] = await Promise.all([service.confirmFacts(staff, command), service.confirmFacts(staff, command)]);
    expect(left).toEqual(right);
    const id = left.facts[0]!.id;
    expect(await service.listFacts(staff, { factIds: [id] })).toEqual([left.facts[0]]);
    for (const unauthorized of [peer, outsider, external]) expect(await service.listFacts(unauthorized, { factIds: [id] })).toEqual([]);
    await expect(confirm(peer, [input])).rejects.toMatchObject({ code: "CONFLICT" });
    const altered = { ...input, note: "确认进展" };
    const alteredDigest = service.previewFacts(staff, { rows: [altered] }).previewDigest;
    await expect(service.confirmFacts(staff, { ...command, rows: [altered], previewDigest: alteredDigest })).rejects.toMatchObject({ code: "CONFLICT" });
    const events = await withWorkspace(appDb, mainWorkspace, async (_db, client) => client.query(
      "SELECT event_id,hash FROM biz_events WHERE event_id=$1", [left.receipt.eventId]));
    expect(events.rows).toEqual([{ event_id: left.receipt.eventId, hash: left.receipt.hash }]);
    for (const target of [otherWorkspace, otherTenant]) {
      const hidden = await withWorkspace(appDb, target, async (_db, client) => client.query("SELECT 1 FROM eagle_business_facts WHERE id=$1", [id]));
      expect(hidden.rowCount).toBe(0);
    }
    await expect(withWorkspace(appDb, mainWorkspace, async (_db, client) => client.query(
      "UPDATE eagle_business_facts SET recorded_at=now() WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps original capture and replayable snapshot when the manager appends an external-source correction", async () => {
    const original: OperatingFactInput = { kind: "contract", accountRef: "account-history", dealRef: "history", occurredOn: day(-3),
      sourceKind: "crm", sourceRef: "contract-source-A", amountMinor: 1000, customerType: "unknown" };
    const imported = await confirm(manager, [original]);
    const originalId = imported.facts[0]!.id;
    const earlier = await service.buildBrief(manager, { businessDate: day(), idempotencyKey: randomUUID() });
    await expect(confirm(manager, [original])).rejects.toMatchObject({ code: "CONFLICT" });
    const correction: OperatingFactInput = { ...original, amountMinor: 500, customerType: "new", supersedesFactId: originalId };
    const revised = await confirm(manager, [correction]);
    const later = await service.buildBrief(manager, { businessDate: day(), idempotencyKey: randomUUID() });
    expect(earlier.metrics.growth.currentContractMinor - later.metrics.growth.currentContractMinor).toBe(500);
    expect(await service.getBrief(manager, { artifactId: earlier.artifactId })).toEqual(earlier);
    expect((await service.getBrief(manager, {}))?.artifactId).toBe(later.artifactId);
    expect((await service.listFacts(manager, { factIds: [originalId, revised.facts[0]!.id] })).map((fact) => fact.id).sort())
      .toEqual([originalId, revised.facts[0]!.id].sort());
    await expect(service.getBrief(staff, { artifactId: earlier.artifactId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.getBrief(outsider, { artifactId: earlier.artifactId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("separates assigned, reported, rejected, revised, and independently verified outcomes", async () => {
    const reference = { accountRef: "account-closure", dealRef: "closure", occurredOn: day(-1), sourceKind: "manual" as const };
    const { facts: [initial] } = await confirm(staff, [{ ...reference, kind: "commitment", state: "open", commitmentRef: "C-TEST", dueOn: day() }]);
    const brief = await service.buildBrief(manager, { businessDate: day(), idempotencyKey: randomUUID() });
    const insight = brief.insights.find((item) => item.evidenceFactIds.includes(initial!.id))!;
    expect(insight.kind).toBe("commitment");
    const command = { artifactId: brief.artifactId, insightId: insight.id, ownerMemberId: staff.memberId,
      dueAt: new Date(Date.now() + 3600000).toISOString(), acceptanceCondition: "客户确认了新交付日", idempotencyKey: randomUUID() };
    await expect(service.confirmAction(staff, command)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.confirmAction(manager, { ...command, ownerMemberId: outsider.memberId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const assignment = await service.confirmAction(manager, command);
    expect(assignment.action.acceptanceCondition).toBe(command.acceptanceCondition);
    expect(assignment.action.status).toBe("open");
    expect(await service.confirmAction(manager, command)).toEqual(assignment);
    expect(await service.listActions(peer, {})).toEqual([]);
    const baseOutcome = { actionId: assignment.action.id, description: "客户同意新交付日期", idempotencyKey: randomUUID() };
    await expect(service.recordActionOutcome(staff, { ...baseOutcome, evidenceFactIds: [initial!.id] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const unrelated = await confirm(staff, [lead("unrelated")]);
    await expect(service.recordActionOutcome(staff, { ...baseOutcome, evidenceFactIds: [unrelated.facts[0]!.id] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const evidence = await confirm(staff, [{ ...reference, occurredOn: day(), kind: "interaction", note: "客户指出交付日仍待确认" }]);
    expect(await service.listOutcomeEvidence(staff, { actionId: assignment.action.id })).toEqual(evidence.facts);
    await expect(service.listOutcomeEvidence(peer, { actionId: assignment.action.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.listOutcomeEvidence(manager, { actionId: assignment.action.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const reported = await service.recordActionOutcome(staff, { ...baseOutcome, evidenceFactIds: [evidence.facts[0]!.id] });
    expect(reported.action.status).toBe("reported");
    const decision = {
      actionId: assignment.action.id, outcomeId: reported.action.outcome!.id, accepted: false, reason: "客户尚未确认", idempotencyKey: randomUUID(),
    };
    await expect(service.verifyActionOutcome(staff, decision)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const corrected = await confirm(staff, [{ ...reference, occurredOn: day(), kind: "interaction",
      note: "更正原记录：客户明确不同意当前交付日期", supersedesFactId: evidence.facts[0]!.id }]);
    expect(await service.listOutcomeEvidence(staff, { actionId: assignment.action.id })).toEqual(corrected.facts);
    await expect(service.verifyActionOutcome(manager, { ...decision, accepted: true, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.verifyActionOutcome(manager, decision)).action.status).toBe("changes_requested");
    const second = await confirm(staff, [{ ...reference, occurredOn: day(), kind: "commitment", state: "delivered", commitmentRef: "C-TEST", dueOn: day() }]);
    const revised = await service.recordActionOutcome(staff, { ...baseOutcome, idempotencyKey: randomUUID(), evidenceFactIds: [second.facts[0]!.id] });
    await expect(service.verifyActionOutcome(manager, { ...decision, accepted: true, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    const verified = await service.verifyActionOutcome(manager, { ...decision, outcomeId: revised.action.outcome!.id, accepted: true,
      reason: "核对新增证据与验收条件一致", idempotencyKey: randomUUID() });
    expect(verified.action.status).toBe("verified");
    const stillOpen = await confirm(staff, [{ ...reference, kind: "commitment", state: "open", commitmentRef: "C-TEST-2", dueOn: day() }]);
    const next = await service.buildBrief(manager, { businessDate: day(), idempotencyKey: randomUUID() });
    const nextInsight = next.insights.find((item) => item.evidenceFactIds.includes(stillOpen.facts[0]!.id))!;
    const nextAction = await service.confirmAction(manager, { ...command, idempotencyKey: randomUUID(), artifactId: next.artifactId, insightId: nextInsight.id,
      dueAt: new Date(Date.now() + 7200000).toISOString() });
    expect((await service.listActions(staff, { limit: 1 }))[0]?.id).toBe(nextAction.action.id);
  });

  it("attests the engine artifact using the original task session and real event hash", async () => {
    const taskId = randomUUID();
    const request = { businessUnit: mainWorkspace.workspaceId, businessDate: day(), asOf: new Date(Date.now() - 1000).toISOString(), taskId };
    const run = () => withWorkspace(appDb, mainWorkspace, async (_db, client) => executeOperatingBrief(client, mainWorkspace, request));
    const receipt = await run();
    expect(await run()).toEqual(receipt);
    const item = await service.getBrief(manager, { artifactId: receipt.artifactId });
    const event = await withWorkspace(appDb, mainWorkspace, async (_db, client) => {
      const result = await client.query("SELECT hash,session_id,payload FROM biz_events WHERE event_id=$1", [receipt.eventId]);
      return result.rows[0];
    });
    expect(event).toMatchObject({ hash: receipt.hash, session_id: taskId, payload: {
      who: { type: "system", id: "system" }, object: { type: "operating_brief", id: receipt.artifactId },
      decision: { action: "eagle.operating.brief.ready", after: { taskId, artifactId: receipt.artifactId, contentHash: item?.contentHash } },
      receipt: { mode: "real", synced: true },
    } });
  });
});
