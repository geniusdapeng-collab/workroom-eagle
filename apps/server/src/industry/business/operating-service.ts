import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient, type ActorInfo } from "@workloom/base/workdata";
import { canonical, sha256 } from "../consulting/workflow-core.js";
import { composeOperatingBrief, type OperatingAnalysis } from "./operating-brief.js";
import { businessDateInput, cleanOperatingText, confirmFactsInput, dateTimeInput, normalizeCapture, operatingFactInput,
  operatingKey, OperatingError, previewFactsInput, referenceInput, type OperatingFact } from "./operating-facts.js";

export { confirmFactsInput, operatingFactInput, OperatingError, previewFactsInput } from "./operating-facts.js";
export type { NormalizedFact, OperatingFact, OperatingFactInput } from "./operating-facts.js";
export type { OperatingAnalysis, OperatingInsight } from "./operating-brief.js";

export type WorkspaceScope = { tenantId: string; workspaceId: string };
export type OperatingScope = WorkspaceScope & { memberId: string; manager: boolean };
export type OperatingReceipt = { eventId: string; hash: string; synced: true };
type QueryClient = pg.PoolClient;
type Infer<S extends z.ZodType> = z.output<S>;

const uuid = z.string().uuid();
const insightId = z.string().regex(/^[a-f0-9]{24}$/u);
const limits = z.number().int().min(1).max(200).default(50);
const kinds = ["lead", "interaction", "opportunity", "contract", "invoice", "payment", "delivery_cost", "deal_outcome", "commitment"] as const;
const businessUnit = (scope: WorkspaceScope) => scope.workspaceId;
export const listFactsInput = z.object({ ownerMemberId: referenceInput.optional(), limit: limits.optional(),
  kind: z.enum(kinds).optional(), before: uuid.optional(), factIds: z.array(uuid).min(1).max(200).optional(),
}).strict();
export const buildBriefInput = z.object({ businessDate: businessDateInput, asOf: dateTimeInput.optional(), idempotencyKey: operatingKey }).strict();
export const getBriefInput = z.object({ artifactId: uuid.optional() }).strict();
export const reviewInput = z.object({ businessDate: businessDateInput, days: z.union([z.literal(7), z.literal(30)]),
  kind: z.enum(["growth", "leakage", "competition", "channel", "commitment"]).optional(),
}).strict();
export const confirmActionInput = z.object({ artifactId: uuid, insightId, ownerMemberId: referenceInput,
  dueAt: dateTimeInput, acceptanceCondition: z.string().trim().min(1).max(600).optional(), idempotencyKey: operatingKey }).strict();
export const listActionsInput = z.object({ ownerMemberId: referenceInput.optional(), limit: limits.optional() }).strict();
export const listOutcomeEvidenceInput = z.object({ actionId: uuid }).strict();
export const recordActionOutcomeInput = z.object({ actionId: uuid, description: z.string().trim().min(1).max(600),
  evidenceFactIds: z.array(uuid).min(1).max(30), idempotencyKey: operatingKey }).strict();
export const verifyActionOutcomeInput = z.object({ actionId: uuid, outcomeId: uuid, accepted: z.boolean(),
  reason: z.string().trim().min(1).max(600), idempotencyKey: operatingKey }).strict();

interface FactRecord {
  id: string;
  owner_member_id: string;
  recorded_at: Date;
  payload: OperatingFact;
  event_id: string;
  event_hash: string;
}
interface BriefPayload extends OperatingAnalysis {
  schemaVersion: "eagle.operating-brief/v1";
  businessUnit: string;
  businessDate: string;
  asOf: string;
}
interface BriefRow {
  id: string;
  business_date: string;
  as_of: Date;
  payload: BriefPayload;
  content_hash: string;
  event_id: string;
  event_hash: string;
}
export type OperatingBrief = BriefPayload & { artifactId: string; contentHash: string; receipt: OperatingReceipt };

interface ActionRow {
  id: string; artifact_id: string; insight_id: string; owner_member_id: string; confirmed_by: string;
  due_at: Date; created_at: Date; title: string; description: string; acceptance_condition: string; event_id: string; event_hash: string;
}
interface OutcomePayload { description: string; evidenceFactIds: string[] }
interface VerificationPayload { accepted: boolean; reason: string }
interface ActionEventRow<P> {
  id: string; actor_id: string; created_at: Date; payload: P;
  event_id: string; event_hash: string;
}
export interface OperatingAction {
  id: string; artifactId: string; insightId: string; ownerMemberId: string; dueAt: string; title: string; description: string; acceptanceCondition: string; createdAt: string;
  status: "open" | "reported" | "verified" | "changes_requested";
  outcome: null | (OutcomePayload & { id: string; reportedAt: string; reporterMemberId: string; receipt: OperatingReceipt });
  verification: null | (VerificationPayload & { verifiedAt: string; verifierMemberId: string; receipt: OperatingReceipt });
  receipt: OperatingReceipt;
}
const scoped = (scope: WorkspaceScope) => [scope.tenantId, scope.workspaceId] as const;
const receiptOf = (row: { event_id: string; event_hash: string }): OperatingReceipt => ({ eventId: row.event_id, hash: row.event_hash, synced: true });
const factOf = (row: FactRecord) => ({ ...row.payload, id: row.id, ownerMemberId: row.owner_member_id,
  recordedAt: row.recorded_at.toISOString(), receipt: receiptOf(row) });
function briefOf(row: BriefRow): OperatingBrief {
  if (sha256(canonical(row.payload)) !== row.content_hash) throw new OperatingError("CONFLICT", "简报内容与原有快照摘要不匹配");
  return { ...row.payload, artifactId: row.id, contentHash: row.content_hash, receipt: receiptOf(row) };
}
const actionOf = (row: ActionRow, outcome: ActionEventRow<OutcomePayload> | null, verified: ActionEventRow<VerificationPayload> | null): OperatingAction => ({
  id: row.id, artifactId: row.artifact_id, insightId: row.insight_id, ownerMemberId: row.owner_member_id,
  dueAt: row.due_at.toISOString(), createdAt: row.created_at.toISOString(), title: row.title, description: row.description, acceptanceCondition: row.acceptance_condition,
  status: verified ? verified.payload.accepted ? "verified" : "changes_requested" : outcome ? "reported" : "open",
  outcome: outcome ? { ...outcome.payload, id: outcome.id, reportedAt: outcome.created_at.toISOString(), reporterMemberId: outcome.actor_id, receipt: receiptOf(outcome) } : null,
  verification: verified ? { ...verified.payload, verifiedAt: verified.created_at.toISOString(), verifierMemberId: verified.actor_id, receipt: receiptOf(verified) } : null,
  receipt: receiptOf(row),
});
const businessActions = {
  facts: "eagle.operating.facts.confirmed", brief: "eagle.operating.brief.ready", action: "eagle.operating.action.confirmed",
  outcome: "eagle.operating.action.outcome_recorded", verification: "eagle.operating.action.outcome_verified",
} as const;
type BusinessAction = typeof businessActions[keyof typeof businessActions];
function actorOf(scope: OperatingScope): ActorInfo { return { type: "human", id: scope.memberId }; }

function ensureManager(scope: OperatingScope): void {
  if (!scope.manager) throw new OperatingError("FORBIDDEN", "此操作需要当前工作区的负责人或主管权限");
}
async function lock(client: QueryClient, scope: WorkspaceScope, key: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [canonical(["eagle-business", ...scoped(scope), key])]);
}
async function checkedMember(client: QueryClient, scope: WorkspaceScope, memberId: string) {
  const result = await client.query<{ role: string }>(
    `SELECT m.role FROM members m JOIN workspaces w ON w.id=m.workspace_id
     WHERE w.tenant_id=$1 AND w.id=$2 AND m.id=$3 AND m.status='active' AND m.member_no<>'GUEST'`,
    [...scoped(scope), memberId]);
  if (!result.rows[0]) throw new OperatingError("FORBIDDEN", "当前工作区没有该有效成员");
  return result.rows[0].role;
}
async function requireAssignee(client: QueryClient, scope: WorkspaceScope, memberId: string) {
  if (!["owner", "manager", "staff"].includes(await checkedMember(client, scope, memberId))) {
    throw new OperatingError("FORBIDDEN", "行动或经营事实只能分配给可参与经营的成员");
  }
}
async function nowOf(client: QueryClient): Promise<string> {
  const result = await client.query<{ time: Date }>("SELECT clock_timestamp() AS time");
  return result.rows[0]!.time.toISOString();
}
async function appendReceipt(client: QueryClient, scope: WorkspaceScope, actor: ActorInfo, action: BusinessAction,
  id: string, time: string, data: Record<string, unknown>, sessionId?: string): Promise<OperatingReceipt> {
  const result = await gatewayAppendOnClient(client, { ...scope, actor, ...(sessionId ? { sessionId } : {}) }, {
    who: { type: actor.type, id: actor.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time, channel: "eagle-operating" },
    object: { type: action === businessActions.brief ? "operating_brief" : action === businessActions.facts ? "operating_fact_batch" : "operating_action", id },
    decision: { action, after: data, basis: ["本工作区已授权、可回读的经营记录与人工确认"] },
    rule_impact: [],
    receipt: { synced: true, mode: "real", verified_at: time, snapshot_uri: `workloom://eagle-operating/${id}` },
  });
  return { eventId: result.eventId, hash: result.hash, synced: true };
}

async function readBrief(client: QueryClient, scope: WorkspaceScope, artifactId?: string): Promise<OperatingBrief | null> {
  const result = await client.query<BriefRow>(
    `SELECT * FROM eagle_business_briefs WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR id=$3)
      ORDER BY business_date DESC, as_of DESC, created_at DESC, id DESC LIMIT 1`,
    [...scoped(scope), artifactId ?? null]);
  return result.rows[0] ? briefOf(result.rows[0]) : null;
}

async function storeBrief(client: QueryClient, scope: WorkspaceScope, request: { businessUnit: string; businessDate: string; asOf: string; sourceRunKey: string; taskId?: string }, actor: ActorInfo) {
  if (request.businessUnit !== businessUnit(scope)) throw new OperatingError("FORBIDDEN", "指定经营单元与当前工作区不一致");
  if (!businessDateInput.safeParse(request.businessDate).success || !dateTimeInput.safeParse(request.asOf).success) {
    throw new OperatingError("BAD_REQUEST", "经营日期或观察时点无效");
  }
  const asOf = new Date(request.asOf).toISOString();
  const createdAt = await nowOf(client);
  if (asOf > createdAt) throw new OperatingError("BAD_REQUEST", "观察时点尚未到达");
  await lock(client, scope, `brief:${request.sourceRunKey}`);
  const prior = await client.query<BriefRow>("SELECT * FROM eagle_business_briefs WHERE tenant_id=$1 AND workspace_id=$2 AND source_run_key=$3",
    [...scoped(scope), request.sourceRunKey]);
  if (prior.rows[0]) {
    const old = briefOf(prior.rows[0]);
    if (old.asOf !== asOf || old.businessDate !== request.businessDate) throw new OperatingError("CONFLICT", "原分析任务的快照参数已变化");
    return old;
  }
  await lock(client, scope, "facts");
  const result = await client.query<FactRecord>(
    `SELECT * FROM eagle_business_facts
       WHERE tenant_id=$1 AND workspace_id=$2 AND occurred_on<=$3::date AND recorded_at<=$4::timestamptz
       ORDER BY occurred_on, recorded_at, id LIMIT 10001`,
    [...scoped(scope), request.businessDate, asOf]);
  if (result.rows.length > 10000) throw new OperatingError("UNPROCESSABLE_CONTENT", "试点分析容量为每工作区 10000 条事实，请核定数据范围");
  const analysis = composeOperatingBrief(result.rows.map(factOf), request.businessDate, asOf);
  const data: BriefPayload = { schemaVersion: "eagle.operating-brief/v1", businessUnit: request.businessUnit, businessDate: request.businessDate, asOf, ...analysis };
  const id = randomUUID();
  const contentHash = sha256(canonical(data));
  const receipt = await appendReceipt(client, scope, actor, businessActions.brief, id, createdAt,
    { artifactId: id, businessDate: request.businessDate, asOf, contentHash, facts: data.metrics.coverage.factCount, insights: data.totalInsightCount,
      ...(request.taskId ? { taskId: request.taskId } : {}) }, request.taskId);
  await client.query(
    `INSERT INTO eagle_business_briefs
       (tenant_id,workspace_id,id,source_run_key,business_date,as_of,created_at,payload,content_hash,event_id,event_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [...scoped(scope), id, request.sourceRunKey, request.businessDate, asOf, createdAt, JSON.stringify(data), contentHash, receipt.eventId, receipt.hash]);
  return { ...data, artifactId: id, contentHash, receipt };
}

/** The engine owns the mandate and transaction. This operation only builds an internal snapshot. */
export async function executeOperatingBrief(client: QueryClient, scope: WorkspaceScope,
  request: { businessUnit: string; businessDate: string; asOf: string; taskId: string }): Promise<{ artifactId: string; eventId: string; hash: string }> {
  const result = await storeBrief(client, scope, { ...request, sourceRunKey: `bot:${request.taskId}` }, { type: "system", id: "system" });
  return { artifactId: result.artifactId, eventId: result.receipt.eventId, hash: result.receipt.hash };
}

async function actionHistory(client: QueryClient, scope: WorkspaceScope, action: ActionRow): Promise<OperatingAction> {
  const rows = await client.query<ActionEventRow<OutcomePayload | VerificationPayload> & { kind: "outcome" | "verification"; outcome_id: string | null }>(
    `SELECT * FROM eagle_business_action_events WHERE tenant_id=$1 AND workspace_id=$2 AND action_id=$3
      ORDER BY created_at DESC,id DESC`, [...scoped(scope), action.id]);
  const outcome = rows.rows.find((row) => row.kind === "outcome");
  const verification = outcome && rows.rows.find((row) => row.kind === "verification" && row.outcome_id === outcome.id);
  return actionOf(action, (outcome as ActionEventRow<OutcomePayload> | undefined) ?? null,
    (verification as ActionEventRow<VerificationPayload> | undefined) ?? null);
}

async function requireAction(client: QueryClient, scope: OperatingScope, actionId: string): Promise<ActionRow> {
  const result = await client.query<ActionRow>(
    `SELECT * FROM eagle_business_actions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
      AND ($4::text IS NULL OR owner_member_id=$4)`, [...scoped(scope), actionId, scope.manager ? null : scope.memberId]);
  if (!result.rows[0]) throw new OperatingError("NOT_FOUND", "该行动不存在或无法访问");
  return result.rows[0];
}

/** Resolve the original action's business objects and subsequent owner evidence with one policy. */
async function eligibleOutcomeFacts(client: QueryClient, scope: WorkspaceScope, action: ActionRow, factIds?: string[]) {
  const brief = await readBrief(client, scope, action.artifact_id);
  const insight = brief?.insights.find((item) => item.id === action.insight_id);
  if (!insight) throw new OperatingError("CONFLICT", "原行动建议无法回读");
  const anchors = await client.query<FactRecord>(
    "SELECT * FROM eagle_business_facts WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])",
    [...scoped(scope), insight.evidenceFactIds]);
  if (!anchors.rows.length || anchors.rows.length !== insight.evidenceFactIds.length) throw new OperatingError("CONFLICT", "原行动依据无法完整回读");
  const subjects = new Map(anchors.rows.map(({ payload }) => [canonical([payload.accountRef, payload.dealRef]),
    { account_ref: payload.accountRef, deal_ref: payload.dealRef }]));
  const result = await client.query<FactRecord>(
    `SELECT f.* FROM eagle_business_facts f
      JOIN biz_events capture ON capture.event_id=f.event_id AND capture.tenant_id=f.tenant_id AND capture.workspace_id=f.workspace_id
      JOIN biz_events assignment ON assignment.event_id=$4 AND assignment.tenant_id=f.tenant_id AND assignment.workspace_id=f.workspace_id
      JOIN jsonb_to_recordset($5::jsonb) AS subject(account_ref text, deal_ref text) ON f.payload->>'accountRef'=subject.account_ref AND f.payload->>'dealRef'=subject.deal_ref
      WHERE f.tenant_id=$1 AND f.workspace_id=$2 AND f.owner_member_id=$3
        AND capture.seq>assignment.seq AND ($6::uuid[] IS NULL OR f.id=ANY($6))
        AND NOT EXISTS (
          SELECT 1 FROM eagle_business_facts newer
            WHERE newer.tenant_id=f.tenant_id AND newer.workspace_id=f.workspace_id AND newer.supersedes_fact_id=f.id
        )
      ORDER BY capture.seq DESC,f.id LIMIT 30`,
    [...scoped(scope), action.owner_member_id, action.event_id, JSON.stringify([...subjects.values()]), factIds ?? null]);
  return result.rows.map(factOf);
}

export class OperatingService {
  constructor(private readonly pool: () => pg.Pool = getAppPool) {}

  private async transaction<T>(scope: OperatingScope, body: (client: QueryClient, role: string) => Promise<T>): Promise<T> {
    const client = await this.pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)", [...scoped(scope)]);
      const role = await checkedMember(client, scope, scope.memberId);
      if (scope.manager && !["owner", "manager"].includes(role)) throw new OperatingError("FORBIDDEN", "主管权限已经变化");
      const result = await body(client, role);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "经营事务回滚结果未知"); }
      throw error;
    } finally { client.release(); }
  }

  private async once<T extends object>(scope: OperatingScope, operation: string, key: string, fingerprint: unknown, body: (client: QueryClient) => Promise<T>): Promise<T> {
    return this.transaction(scope, async (client, role) => {
      if (!["owner", "manager", "staff"].includes(role)) throw new OperatingError("FORBIDDEN", "当前成员无经营写入权限");
      const requestKey = sha256(key);
      const digest = sha256(canonical(fingerprint));
      await lock(client, scope, canonical([scope.memberId, operation, requestKey]));
      const existing = await client.query<{ fingerprint: string; result: T }>(
        `SELECT fingerprint,result FROM eagle_business_requests
          WHERE tenant_id=$1 AND workspace_id=$2 AND actor_id=$3 AND operation=$4 AND request_key=$5`,
        [...scoped(scope), scope.memberId, operation, requestKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== digest) throw new OperatingError("CONFLICT", "同一请求键不能提交不同经营内容");
        return existing.rows[0].result;
      }
      const result = await body(client);
      await client.query(
        `INSERT INTO eagle_business_requests(tenant_id,workspace_id,actor_id,operation,request_key,fingerprint,result)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [...scoped(scope), scope.memberId, operation, requestKey, digest, JSON.stringify(result)]);
      return result;
    });
  }

  previewFacts(scope: OperatingScope, input: Infer<typeof previewFactsInput>) {
    return normalizeCapture(previewFactsInput.parse(input), scope);
  }

  async confirmFacts(scope: OperatingScope, input: Infer<typeof confirmFactsInput>) {
    const checked = confirmFactsInput.parse(input);
    const preview = normalizeCapture(checked, scope);
    if (preview.previewDigest !== checked.previewDigest) throw new OperatingError("CONFLICT", "记录已变化，请重新预览再确认");
    return this.once(scope, "confirm-facts", checked.idempotencyKey, preview.previewDigest, async (client) => {
      await lock(client, scope, "facts");
      const time = await nowOf(client);
      const batchId = randomUUID();
      const owners = [...new Set(preview.rows.map((row) => row.ownerMemberId))];
      for (const owner of owners) await requireAssignee(client, scope, owner);
      const facts = preview.rows.map((row) => ({ ...row, id: randomUUID(), recordedAt: time }));
      for (const fact of facts) {
        const association = await client.query(
          `SELECT 1 FROM eagle_business_facts WHERE tenant_id=$1 AND workspace_id=$2 AND payload->>'dealRef'=$3
            AND (payload->>'accountRef'<>$4 OR ($5::text IS NOT NULL AND owner_member_id<>$5)) LIMIT 1`,
          [...scoped(scope), fact.dealRef, fact.accountRef, scope.manager ? null : scope.memberId]);
        if (association.rowCount) throw new OperatingError("CONFLICT", "经营对象已归属于其他主体或负责人");
        if (fact.supersedesFactId) {
          const prior = await client.query<FactRecord>(
            `SELECT f.* FROM eagle_business_facts f WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
             AND NOT EXISTS (SELECT 1 FROM eagle_business_facts n WHERE n.tenant_id=f.tenant_id AND n.workspace_id=f.workspace_id AND n.supersedes_fact_id=f.id)`,
            [...scoped(scope), fact.supersedesFactId]);
          const old = prior.rows[0] ? factOf(prior.rows[0]) : null;
          if (!old || old.ownerMemberId !== fact.ownerMemberId || old.kind !== fact.kind || old.accountRef !== fact.accountRef
            || old.dealRef !== fact.dealRef || old.occurredOn !== fact.occurredOn || old.sourceKind !== fact.sourceKind
            || (old.kind === "invoice" && fact.kind === "invoice" && old.invoiceRef !== fact.invoiceRef)
            || (old.kind === "commitment" && fact.kind === "commitment" && old.commitmentRef !== fact.commitmentRef)) {
            throw new OperatingError("CONFLICT", "更正必须关联同一主体、日期与类型下的有效记录");
          }
        }
        if (fact.sourceRef !== undefined) {
          const duplicates = await client.query(
            `SELECT 1 FROM eagle_business_facts f WHERE tenant_id=$1 AND workspace_id=$2 AND kind=$3 AND source_kind=$4 AND source_ref=$5
               AND ($6::uuid IS NULL OR id<>$6)
               AND NOT EXISTS (SELECT 1 FROM eagle_business_facts n WHERE n.tenant_id=f.tenant_id AND n.workspace_id=f.workspace_id AND n.supersedes_fact_id=f.id) LIMIT 1`,
            [...scoped(scope), fact.kind, fact.sourceKind, fact.sourceRef, fact.supersedesFactId ?? null]);
          if (duplicates.rowCount) throw new OperatingError("CONFLICT", "来源记录已存在，请使用原请求或正式更正");
        }
        if (fact.kind === "invoice" && !fact.supersedesFactId) {
          const duplicates = await client.query(
            `SELECT 1 FROM eagle_business_facts WHERE tenant_id=$1 AND workspace_id=$2 AND kind='invoice' AND payload->>'invoiceRef'=$3 LIMIT 1`,
            [...scoped(scope), fact.invoiceRef]);
          if (duplicates.rowCount) throw new OperatingError("CONFLICT", "应收编号已存在，请用正式更正");
        }
      }
      const receipt = await appendReceipt(client, scope, actorOf(scope), businessActions.facts, batchId, time,
        { batchId, count: facts.length, factIds: facts.map((fact) => fact.id), previewDigest: preview.previewDigest });
      for (const fact of facts) {
        await client.query(
          `INSERT INTO eagle_business_facts
            (tenant_id,workspace_id,id,owner_member_id,recorded_by,kind,occurred_on,recorded_at,source_kind,source_ref,supersedes_fact_id,payload,event_id,event_hash)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [...scoped(scope), fact.id, fact.ownerMemberId, scope.memberId, fact.kind, fact.occurredOn, fact.recordedAt,
            fact.sourceKind, fact.sourceRef ?? null, fact.supersedesFactId ?? null, JSON.stringify(fact), receipt.eventId, receipt.hash]);
      }
      return { facts: facts.map((fact) => ({ ...fact, receipt })), receipt };
    });
  }

  async listFacts(scope: OperatingScope, input: Infer<typeof listFactsInput>) {
    const checked = listFactsInput.parse(input);
    const owner = scope.manager ? checked.ownerMemberId ?? null : scope.memberId;
    if (!scope.manager && checked.ownerMemberId && checked.ownerMemberId !== scope.memberId) return [];
    return this.transaction(scope, async (client) => {
      const result = await client.query<FactRecord>(
        `SELECT * FROM eagle_business_facts f WHERE tenant_id=$1 AND workspace_id=$2
          AND ($3::text IS NULL OR owner_member_id=$3) AND ($4::text IS NULL OR kind=$4)
          AND ($5::uuid[] IS NULL OR id=ANY($5))
          AND ($6::uuid IS NULL OR (recorded_at,id)<(SELECT c.recorded_at,c.id FROM eagle_business_facts c
           WHERE c.tenant_id=f.tenant_id AND c.workspace_id=f.workspace_id AND c.id=$6 AND ($3::text IS NULL OR c.owner_member_id=$3)))
          ORDER BY recorded_at DESC,id DESC LIMIT $7`,
        [...scoped(scope), owner, checked.kind ?? null, checked.factIds ?? null, checked.before ?? null, checked.limit ?? checked.factIds?.length ?? 50]);
      return result.rows.map(factOf);
    });
  }

  async buildBrief(scope: OperatingScope, input: Infer<typeof buildBriefInput>) {
    ensureManager(scope);
    const checked = buildBriefInput.parse(input);
    return this.once(scope, "build-brief", checked.idempotencyKey, [checked.businessDate, checked.asOf ?? null], async (client) => {
      const asOf = checked.asOf ?? await nowOf(client);
      return storeBrief(client, scope, { businessUnit: businessUnit(scope), businessDate: checked.businessDate, asOf,
        sourceRunKey: `manual:${sha256(canonical([scope.memberId, checked.idempotencyKey]))}` }, actorOf(scope));
    });
  }
  async getBrief(scope: OperatingScope, input: Infer<typeof getBriefInput>) {
    ensureManager(scope);
    const checked = getBriefInput.parse(input);
    return this.transaction(scope, async (client) => {
      const brief = await readBrief(client, scope, checked.artifactId);
      if (!brief && checked.artifactId) throw new OperatingError("NOT_FOUND", "该经营简报不存在或无法访问");
      return brief;
    });
  }
  async review(scope: OperatingScope, input: Infer<typeof reviewInput>) {
    ensureManager(scope);
    const checked = reviewInput.parse(input);
    return this.transaction(scope, async (client) => {
      const result = await client.query<BriefRow>(
        `SELECT DISTINCT ON (business_date) * FROM eagle_business_briefs
          WHERE tenant_id=$1 AND workspace_id=$2 AND business_date BETWEEN ($3::date - ($4::int - 1)) AND $3::date
          ORDER BY business_date DESC,as_of DESC,created_at DESC,id DESC`, [...scoped(scope), checked.businessDate, checked.days]);
      return {
        businessDate: checked.businessDate, days: checked.days, availableDays: result.rows.length,
        briefs: result.rows.map((row) => {
          const brief = briefOf(row);
          return { brief, matchingInsightIds: brief.insights.filter((item) => !checked.kind || item.kind === checked.kind).map((item) => item.id) };
        }),
      };
    });
  }

  async listActions(scope: OperatingScope, input: Infer<typeof listActionsInput>) {
    const checked = listActionsInput.parse(input);
    if (!scope.manager && checked.ownerMemberId && checked.ownerMemberId !== scope.memberId) return [];
    return this.transaction(scope, async (client) => {
      const result = await client.query<ActionRow>(
        `SELECT a.* FROM eagle_business_actions a
          LEFT JOIN LATERAL (
            SELECT e.id FROM eagle_business_action_events e
             WHERE e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.action_id=a.id AND e.kind='outcome'
             ORDER BY e.created_at DESC,e.id DESC LIMIT 1
          ) latest ON true
          LEFT JOIN eagle_business_action_events verification ON verification.tenant_id=a.tenant_id
             AND verification.workspace_id=a.workspace_id AND verification.action_id=a.id AND verification.outcome_id=latest.id
          WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND ($3::text IS NULL OR a.owner_member_id=$3)
          ORDER BY COALESCE((verification.payload->>'accepted')::boolean, false),a.due_at,a.id LIMIT $4`, [...scoped(scope), scope.manager ? checked.ownerMemberId ?? null : scope.memberId, checked.limit ?? 50]);
      const actions: OperatingAction[] = [];
      for (const row of result.rows) actions.push(await actionHistory(client, scope, row));
      return actions;
    });
  }

  async confirmAction(scope: OperatingScope, input: Infer<typeof confirmActionInput>) {
    ensureManager(scope);
    const { idempotencyKey, ...checked } = confirmActionInput.parse(input);
    const dueAt = new Date(checked.dueAt).toISOString();
    const requestedCondition = checked.acceptanceCondition ? cleanOperatingText(checked.acceptanceCondition) : null;
    return this.once(scope, "confirm-action", idempotencyKey, { ...checked, dueAt, acceptanceCondition: requestedCondition }, async (client) => {
      await lock(client, scope, `insight:${checked.insightId}`);
      const brief = await readBrief(client, scope, checked.artifactId);
      const insight = brief?.insights.find((item) => item.id === checked.insightId);
      if (!insight) throw new OperatingError("NOT_FOUND", "该行动建议不存在或无法访问");
      await requireAssignee(client, scope, checked.ownerMemberId);
      const time = await nowOf(client);
      if (dueAt <= time) throw new OperatingError("BAD_REQUEST", "行动截止时间必须晚于确认时间");
      const candidates = await client.query<ActionRow>(
        `SELECT * FROM eagle_business_actions WHERE tenant_id=$1 AND workspace_id=$2 AND insight_id=$3
          ORDER BY created_at DESC,id DESC`, [...scoped(scope), checked.insightId]);
      if (candidates.rows.some((row) => row.artifact_id === checked.artifactId)) throw new OperatingError("CONFLICT", "当前简报的该条建议已确认");
      for (const previous of candidates.rows) {
        if ((await actionHistory(client, scope, previous)).status !== "verified") throw new OperatingError("CONFLICT", "该经营信号已有待处理的行动");
      }
      const id = randomUUID();
      const acceptanceCondition = requestedCondition ?? "负责人回填该经营对象的新增事实，由另一位主管核对建议、证据与执行结果是否一致。";
      const receipt = await appendReceipt(client, scope, actorOf(scope), businessActions.action, id, time,
        { artifactId: checked.artifactId, insightId: insight.id, ownerMemberId: checked.ownerMemberId, dueAt, acceptanceCondition, evidenceFactIds: insight.evidenceFactIds });
      const inserted = await client.query<ActionRow>(
        `INSERT INTO eagle_business_actions
          (tenant_id,workspace_id,id,artifact_id,insight_id,owner_member_id,confirmed_by,due_at,created_at,title,description,acceptance_condition,event_id,event_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [...scoped(scope), id, checked.artifactId, insight.id, checked.ownerMemberId, scope.memberId, dueAt, time,
          insight.title, insight.action, acceptanceCondition, receipt.eventId, receipt.hash]);
      return { action: actionOf(inserted.rows[0]!, null, null), receipt };
    });
  }

  async listOutcomeEvidence(scope: OperatingScope, input: Infer<typeof listOutcomeEvidenceInput>) {
    const checked = listOutcomeEvidenceInput.parse(input);
    return this.transaction(scope, async (client) => {
      const row = await requireAction(client, scope, checked.actionId);
      if (row.owner_member_id !== scope.memberId) throw new OperatingError("FORBIDDEN", "只有行动负责人可以读取可回填的执行证据");
      return eligibleOutcomeFacts(client, scope, row);
    });
  }

  async recordActionOutcome(scope: OperatingScope, input: Infer<typeof recordActionOutcomeInput>) {
    const { idempotencyKey, ...checked } = recordActionOutcomeInput.parse(input);
    const description = cleanOperatingText(checked.description);
    const evidenceFactIds = [...new Set(checked.evidenceFactIds)].sort();
    return this.once(scope, "record-outcome", idempotencyKey, { ...checked, description, evidenceFactIds }, async (client) => {
      await lock(client, scope, `action:${checked.actionId}`);
      const row = await requireAction(client, scope, checked.actionId);
      if (row.owner_member_id !== scope.memberId) throw new OperatingError("FORBIDDEN", "只有行动负责人可以报告执行结果");
      const state = await actionHistory(client, scope, row);
      if (state.status !== "open" && state.status !== "changes_requested") throw new OperatingError("CONFLICT", "已有结果待复核或已经验证");
      const eligible = await eligibleOutcomeFacts(client, scope, row, evidenceFactIds);
      if (eligible.length !== evidenceFactIds.length) throw new OperatingError("BAD_REQUEST", "执行结果须引用行动确认后为同一经营对象新增的本人有效证据");
      const id = randomUUID();
      const time = await nowOf(client);
      const receipt = await appendReceipt(client, scope, actorOf(scope), businessActions.outcome, checked.actionId, time, { outcomeId: id, evidenceFactIds });
      await client.query(
        `INSERT INTO eagle_business_action_events(tenant_id,workspace_id,id,action_id,kind,actor_id,created_at,payload,event_id,event_hash)
          VALUES($1,$2,$3,$4,'outcome',$5,$6,$7,$8,$9)`,
        [...scoped(scope), id, checked.actionId, scope.memberId, time, JSON.stringify({ description, evidenceFactIds }), receipt.eventId, receipt.hash]);
      return { action: await actionHistory(client, scope, row), receipt };
    });
  }

  async verifyActionOutcome(scope: OperatingScope, input: Infer<typeof verifyActionOutcomeInput>) {
    ensureManager(scope);
    const { idempotencyKey, ...checked } = verifyActionOutcomeInput.parse(input);
    const reason = cleanOperatingText(checked.reason);
    return this.once(scope, "verify-outcome", idempotencyKey, { ...checked, reason }, async (client) => {
      await lock(client, scope, `action:${checked.actionId}`);
      const row = await requireAction(client, scope, checked.actionId);
      const state = await actionHistory(client, scope, row);
      if (state.status !== "reported" || !state.outcome || state.outcome.id !== checked.outcomeId) {
        throw new OperatingError("CONFLICT", "只能复核该行动尚未裁决的最新执行报告");
      }
      if (state.outcome.reporterMemberId === scope.memberId) throw new OperatingError("FORBIDDEN", "本人执行结果须由另一位主管复核");
      if (checked.accepted) {
        // Serialize against capture and correction through the same workspace lock.
        await lock(client, scope, "facts");
        const evidence = await eligibleOutcomeFacts(client, scope, row, state.outcome.evidenceFactIds);
        if (evidence.length !== state.outcome.evidenceFactIds.length) {
          throw new OperatingError("CONFLICT", "回填证据已发生更正或无法核实，请退回负责人更新依据");
        }
      }
      const id = randomUUID();
      const time = await nowOf(client);
      const receipt = await appendReceipt(client, scope, actorOf(scope), businessActions.verification, checked.actionId, time,
        { verificationId: id, outcomeId: checked.outcomeId, accepted: checked.accepted, evidenceFactIds: state.outcome.evidenceFactIds });
      await client.query(
        `INSERT INTO eagle_business_action_events(tenant_id,workspace_id,id,action_id,kind,outcome_id,actor_id,created_at,payload,event_id,event_hash)
          VALUES($1,$2,$3,$4,'verification',$5,$6,$7,$8,$9,$10)`,
        [...scoped(scope), id, checked.actionId, checked.outcomeId, scope.memberId, time,
          JSON.stringify({ accepted: checked.accepted, reason }), receipt.eventId, receipt.hash]);
      return { action: await actionHistory(client, scope, row), receipt };
    });
  }
}

export const operatingService = new OperatingService();
