import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { getAppPool, withWorkspace } from "@workloom/db";
import { judge, type RuntimeRule } from "@workloom/base/fence-engine";
import { gatewayAppendOnClient, type ActorInfo, type EventDraft } from "@workloom/base/workdata";
import { memberAccessGrants, type MemberAuthorityFacts } from "../../service/access-authority.js";
import { bindVerifiedActiveBundle } from "../../service/active-bundle.js";
import { canonical } from "../consulting/workflow-core.js";

const CAPABILITY = "eagle.operating-brief";
const BUSINESS_READ_PERMISSION = "consulting.business.read";
const CONTRACT_VERSION = 1;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DELIVERY_WINDOW_MS = 12 * 60 * 60 * 1000;
const LEASE_GRACE_MS = 5_000;
const PRESENCE_TTL_MS = 30_000;
const MAX_ATTEMPTS = 3;
const SCHEDULE_BATCH = 8;
const OPEN_TASK_LIMIT = 40;

export const BOT_CAPABILITIES = Object.freeze([{
  projectId: "workroom-eagle",
  capabilityId: CAPABILITY,
  contractVersion: CONTRACT_VERSION,
  policyVersion: "eagle-operating-bot/1",
  triggers: ["manual", "daily"] as const,
  access: "read-and-internal-report",
  externalWrites: false,
  providerCalls: false,
  result: "operating-brief",
  scheduleZone: "Asia/Shanghai",
}]);

const businessUnit = z.string().min(1).max(80).regex(/^[\w\-\u3400-\u9fff]+$/u);
const idempotencyKey = z.string().min(8).max(160);
const identifier = z.uuid();
const businessDate = z.iso.date();
const boundedLimit = z.number().int().min(1).max(100);

export const createMandateInput = z.object({
  businessUnit,
  expiresAt: z.iso.datetime({ offset: true }),
  maxRuns: z.number().int().min(1).max(90),
  maxRuntimeSeconds: z.number().int().min(5).max(120),
  dailyAt: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  idempotencyKey,
}).strict();

export const manualTaskInput = z.object({
  mandateId: identifier,
  businessDate,
  idempotencyKey,
}).strict();

const taskFilter = z.object({ businessUnit: businessUnit.optional(), limit: boundedLimit.optional() }).strict();
const eventFilter = z.object({
  taskId: identifier,
  after: z.string().regex(/^\d{1,19}$/u).refine((value) => value.length < 19 || value <= "9223372036854775807").optional(),
  limit: boundedLimit.optional(),
}).strict();

export type OperatingBotScope = { tenantId: string; workspaceId: string };
export type OperatingBotActor = { memberId: string; memberNo: string };
export type OperatingBotResult = { artifactId: string; eventId: string; hash: string };
export type ExecuteOperatingBrief = (
  client: pg.PoolClient,
  scope: OperatingBotScope,
  request: { businessUnit: string; businessDate: string; asOf: string; taskId: string },
) => Promise<OperatingBotResult>;

type BotTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type BotTrigger = "manual" | "daily";
type Receipt = { eventId: string; hash: string };
type ErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "FORBIDDEN" | "IDEMPOTENCY_CONFLICT"
  | "MANDATE_INACTIVE" | "MANDATE_EXHAUSTED" | "BUNDLE_NOT_READY" | "FENCE_BLOCKED" | "QUEUE_FULL"
  | "DEADLINE_EXCEEDED" | "LEASE_EXPIRED" | "EXECUTION_TIMEOUT" | "EXECUTION_FAILED";

const errors: Record<ErrorCode, string> = {
  INVALID_INPUT: "经营 BOT 请求参数无效。",
  NOT_FOUND: "当前工作区找不到这项经营 BOT 记录。",
  FORBIDDEN: "当前成员无权执行这项经营 BOT 操作。",
  IDEMPOTENCY_CONFLICT: "同一请求键绑定了不同的输入。",
  MANDATE_INACTIVE: "经营 BOT 委托未生效、已过期或已撤销。",
  MANDATE_EXHAUSTED: "经营 BOT 委托的运行次数已经用完。",
  BUNDLE_NOT_READY: "当前工作区未装配已验证的鹰眼行业包。",
  FENCE_BLOCKED: "当前经营围栏未放行本次分析。",
  QUEUE_FULL: "当前工作区的经营 BOT 待处理任务已达上限。",
  DEADLINE_EXCEEDED: "已超过本次经营分析的交付时限。",
  LEASE_EXPIRED: "原执行租约已过期。",
  EXECUTION_TIMEOUT: "本次经营分析超过运行时限。",
  EXECUTION_FAILED: "本次经营分析失败，记录已保留。",
};

export class OperatingBotError extends Error {
  constructor(readonly code: ErrorCode) {
    super(errors[code]);
    this.name = "OperatingBotError";
  }
}

interface MandateRow {
  id: string;
  business_unit: string;
  issuer_member_id: string;
  issuer_member_no: string;
  contract_version: number;
  input_digest: string;
  created_at: Date;
  expires_at: Date;
  max_runs: number;
  used_runs: number;
  max_runtime_seconds: number;
  daily_at: string | null;
  next_due_at: Date | null;
  revoked_at: Date | null;
  event_id: string;
  event_hash: string;
}

interface TaskRow {
  id: string;
  mandate_id: string;
  business_unit: string;
  business_date: string;
  trigger: BotTrigger;
  input_digest: string;
  scheduled_at: Date;
  as_of: Date;
  deadline: Date;
  status: BotTaskStatus;
  attempts: number;
  lease_token: string | null;
  lease_until: Date | null;
  result: OperatingBotResult | null;
  error_code: ErrorCode | "CANCELLED" | null;
  event_id: string;
  event_hash: string;
  created_at: Date;
  updated_at: Date;
}

const TASK_RETURN = "*, to_char(business_date, 'YYYY-MM-DD') AS business_date";
const SYSTEM_ACTOR: ActorInfo = { id: "system", type: "system" };
const scopeParams = (scope: OperatingBotScope) => [scope.tenantId, scope.workspaceId] as const;

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const checked = schema.safeParse(value);
  if (!checked.success) throw new OperatingBotError("INVALID_INPUT");
  return checked.data;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localDate(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function firstDailyAt(now: Date, time: string): Date {
  const today = new Date(`${localDate(now)}T${time}:00+08:00`);
  return today < now ? new Date(today.getTime() + DAY_MS) : today;
}

function mandateView(row: MandateRow) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    capabilityId: CAPABILITY,
    contractVersion: row.contract_version,
    createdBy: row.issuer_member_no,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    maxRuns: row.max_runs,
    usedRuns: row.used_runs,
    maxRuntimeSeconds: row.max_runtime_seconds,
    dailyAt: row.daily_at,
    nextDueAt: row.next_due_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    receipt: { eventId: row.event_id, hash: row.event_hash },
  };
}

function taskView(row: TaskRow) {
  return {
    id: row.id,
    mandateId: row.mandate_id,
    businessUnit: row.business_unit,
    businessDate: row.business_date,
    trigger: row.trigger,
    scheduledAt: row.scheduled_at.toISOString(),
    asOf: row.as_of.toISOString(),
    deadline: row.deadline.toISOString(),
    status: row.status,
    attempts: row.attempts,
    result: row.result,
    errorCode: row.error_code,
    receipt: { eventId: row.event_id, hash: row.event_hash },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export type BotMandate = ReturnType<typeof mandateView>;
export type BotTask = ReturnType<typeof taskView>;

async function record(
  client: pg.PoolClient,
  scope: OperatingBotScope,
  at: Date,
  id: string,
  type: "bot_mandate" | "bot_task",
  action: string,
  detail: Record<string, unknown>,
  actor: ActorInfo = SYSTEM_ACTOR,
  ruleImpact: EventDraft["rule_impact"] = [],
): Promise<Receipt> {
  const saved = await gatewayAppendOnClient(client, { ...scope, actor, sessionId: id }, {
    who: { type: actor.type, id: actor.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: at.toISOString(), channel: "eagle-operating-bot" },
    object: { type, id },
    decision: { action, after: detail, basis: ["eagle-operating-bot/1", CAPABILITY] },
    rule_impact: ruleImpact,
    receipt: { mode: "real", synced: true, verified_at: at.toISOString(), snapshot_uri: `workloom://eagle/bot/${type}/${id}` },
  });
  return { eventId: saved.eventId, hash: saved.hash };
}

interface MemberRow {
  member_no: string;
  role: MemberAuthorityFacts["role"];
  plan: MemberAuthorityFacts["plan"];
  permissions: Record<string, unknown>;
}

async function currentMember(client: pg.PoolClient, scope: OperatingBotScope, memberId: string) {
  const result = await client.query<MemberRow>(
    `SELECT m.member_no, m.role, m.permissions, t.plan
      FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN tenants t ON t.id=w.tenant_id
      WHERE m.id=$1 AND w.id=$2 AND t.id=$3 AND m.status='active' AND t.status='active'
      FOR SHARE OF m,t`,
    [memberId, scope.workspaceId, scope.tenantId],
  );
  return result.rows[0];
}

function canRun(member: MemberRow, requireConfiguration: boolean): boolean {
  const grants = memberAccessGrants({
    role: member.role, plan: member.plan, guest: false, permissions: member.permissions,
    verifiedBundlePermissions: [BUSINESS_READ_PERMISSION],
  });
  return grants.actionPermissions.includes("workspace.write")
    && grants.actionPermissions.includes("task.dispatch")
    && grants.navigationPermissions.includes(BUSINESS_READ_PERMISSION)
    && (!requireConfiguration || grants.actionPermissions.includes("workspace.configure"));
}

async function assertActor(
  client: pg.PoolClient, scope: OperatingBotScope, actor: OperatingBotActor, mode: "owner" | "dispatch" | "stop" | "owner-stop",
) {
  const member = await currentMember(client, scope, actor.memberId);
  const ownerOnly = mode === "owner" || mode === "owner-stop";
  const goingToRun = mode === "owner" || mode === "dispatch";
  if (!member || actor.memberNo === "GUEST" || member.member_no !== actor.memberNo
    || (ownerOnly ? member.role !== "owner" : member.role !== "owner" && member.role !== "manager")
    || (goingToRun && !canRun(member, ownerOnly))) {
    throw new OperatingBotError("FORBIDDEN");
  }
}

async function selectMandate(client: pg.PoolClient, scope: OperatingBotScope, mandateId: string, lock: "update" | "share"): Promise<MandateRow> {
  const result = await client.query<MandateRow>(
    `SELECT * FROM eagle_bot_mandates WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 ${lock === "update" ? "FOR UPDATE" : "FOR SHARE"}`,
    [...scopeParams(scope), mandateId],
  );
  if (!result.rows[0]) throw new OperatingBotError("NOT_FOUND");
  return result.rows[0];
}

async function lockQueueAdmissions(client: pg.PoolClient, scope: OperatingBotScope): Promise<void> {
  // Hold admissions from all mandates in this scope to the same open-task cap.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`eagle:queue:${scope.tenantId}:${scope.workspaceId}`]);
}

async function hasQueueRoom(client: pg.PoolClient, scope: OperatingBotScope): Promise<boolean> {
  const found = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM eagle_bot_tasks WHERE tenant_id=$1 AND workspace_id=$2 AND status IN ('queued','running')",
    [...scopeParams(scope)],
  );
  return found.rows[0]!.count < OPEN_TASK_LIMIT;
}

async function activeMandate(client: pg.PoolClient, scope: OperatingBotScope, mandate: MandateRow, now: Date): Promise<boolean> {
  if (mandate.revoked_at || mandate.expires_at <= now) return false;
  const member = await currentMember(client, scope, mandate.issuer_member_id);
  return Boolean(member && member.role === "owner" && member.member_no === mandate.issuer_member_no && canRun(member, true));
}

async function analysisFence(client: pg.PoolClient, scope: OperatingBotScope, unit: string): Promise<EventDraft["rule_impact"]> {
  type Row = Pick<RuntimeRule, "rule_id" | "version" | "name" | "level" | "is_baseline"> & {
    match_spec: { object_types: string[]; actions: string[]; when: string };
  };
  const result = await client.query<Row>(
    "SELECT rule_id, version, name, level, is_baseline, match_spec FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'",
    [scope.workspaceId],
  );
  const rules: RuntimeRule[] = result.rows.map(({ match_spec: match, ...rule }) => ({
    ...rule, objectTypes: match.object_types, actions: match.actions, when: match.when,
  }));
  const verdict = judge({
    object: { type: "enterprise", id: unit },
    action: "eagle.operating-brief.read",
    effect: "read",
    params: { within_customer_domain: true, external_write: false, provider_calls: false },
  }, rules, "review");
  if (verdict.level !== "auto") throw new OperatingBotError("FENCE_BLOCKED");
  return verdict.impacts;
}

interface EngineOptions {
  pool?: () => pg.Pool;
  now?: () => Date;
  assertWorkspace?: (scope: OperatingBotScope) => Promise<void>;
}

export class OperatingBot {
  constructor(private readonly options: EngineOptions = {}) {}

  private async now(client: pg.PoolClient): Promise<Date> {
    if (this.options.now) return this.options.now();
    // Use the same clock for every worker process and the native brief snapshot.
    const result = await client.query<{ time: Date }>("SELECT clock_timestamp() AS time");
    return result.rows[0]!.time;
  }

  private tx<T>(scope: OperatingBotScope, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withWorkspace((this.options.pool ?? getAppPool)(), scope, (_db, client) => operation(client));
  }

  private async assertWorkspace(client: pg.PoolClient, scope: OperatingBotScope) {
    if (this.options.assertWorkspace) return this.options.assertWorkspace(scope);
    // Verify and lock the active installation with its work. The common resolver
    // otherwise uses its own transaction, allowing disable to race the claim.
    const workspace = await client.query<{ bundle_id: string | null }>(
      "SELECT bundle_id FROM workspaces WHERE id=$1 AND tenant_id=$2 FOR SHARE", [scope.workspaceId, scope.tenantId],
    );
    if (!workspace.rows[0]) throw new OperatingBotError("BUNDLE_NOT_READY");
    const active = await client.query<{ id: string; bundle_id: string }>(
      "SELECT id,bundle_id FROM bundle_installs WHERE workspace_id=$1 AND status='active' FOR SHARE", [scope.workspaceId],
    );
    const bundle = bindVerifiedActiveBundle({
      workspaceBundleId: workspace.rows[0].bundle_id,
      activeInstalls: active.rows.map(({ id, bundle_id: bundleId }) => ({ id, bundleId })),
    });
    if (bundle.state !== "ready" || bundle.bundleId !== "consulting"
      || !bundle.projection?.navigationPermissionUniverse?.includes(BUSINESS_READ_PERMISSION)) {
      throw new OperatingBotError("BUNDLE_NOT_READY");
    }
  }

  async createMandate(scope: OperatingBotScope, actor: OperatingBotActor, value: z.input<typeof createMandateInput>): Promise<BotMandate> {
    const args = input(createMandateInput, value);
    if (args.businessUnit !== scope.workspaceId) throw new OperatingBotError("FORBIDDEN");
    const expiresAt = new Date(args.expiresAt);
    const requestDigest = digest(args.idempotencyKey);
    const inputDigest = digest(JSON.stringify([actor.memberId, args.businessUnit, expiresAt.toISOString(),
      args.maxRuns, args.maxRuntimeSeconds, args.dailyAt ?? null]));
    return this.tx(scope, async (client) => {
      await this.assertWorkspace(client, scope);
      await assertActor(client, scope, actor, "owner");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`eagle:mandate:${scope.tenantId}:${scope.workspaceId}:${requestDigest}`]);
      const prior = (await client.query<MandateRow>(
        "SELECT * FROM eagle_bot_mandates WHERE tenant_id=$1 AND workspace_id=$2 AND request_digest=$3",
        [...scopeParams(scope), requestDigest],
      )).rows[0];
      if (prior) {
        if (inputDigest !== prior.input_digest) throw new OperatingBotError("IDEMPOTENCY_CONFLICT");
        return mandateView(prior);
      }
      const now = await this.now(client);
      if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 31 * DAY_MS) throw new OperatingBotError("INVALID_INPUT");
      const id = randomUUID();
      const due = args.dailyAt ? firstDailyAt(now, args.dailyAt) : null;
      const receipt = await record(client, scope, now, id, "bot_mandate", "eagle.bot.mandate.granted", {
        businessUnit: args.businessUnit, capabilityId: CAPABILITY, contractVersion: CONTRACT_VERSION,
        expiresAt: expiresAt.toISOString(), maxRuns: args.maxRuns, maxRuntimeSeconds: args.maxRuntimeSeconds,
        dailyAt: args.dailyAt ?? null, inputDigest,
      }, { type: "human", id: actor.memberNo });
      const saved = await client.query<MandateRow>(
        `INSERT INTO eagle_bot_mandates (id,tenant_id,workspace_id,business_unit,issuer_member_id,issuer_member_no,
          capability,contract_version,request_digest,input_digest,created_at,expires_at,max_runs,max_runtime_seconds,daily_at,next_due_at,event_id,event_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [id, scope.tenantId, scope.workspaceId, args.businessUnit, actor.memberId, actor.memberNo,
          CAPABILITY, CONTRACT_VERSION, requestDigest, inputDigest, now, expiresAt, args.maxRuns, args.maxRuntimeSeconds,
          args.dailyAt ?? null, due, receipt.eventId, receipt.hash],
      );
      return mandateView(saved.rows[0]!);
    });
  }

  async listMandates(scope: OperatingBotScope): Promise<BotMandate[]> {
    return this.tx(scope, async (client) => {
      const rows = await client.query<MandateRow>(
        "SELECT * FROM eagle_bot_mandates WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id LIMIT 100",
        [...scopeParams(scope)],
      );
      return rows.rows.map(mandateView);
    });
  }

  async markWorkerPresence(scope: OperatingBotScope, completedTick: boolean): Promise<void> {
    await this.tx(scope, async (client) => {
      const workspace = await client.query(
        "SELECT 1 FROM workspaces WHERE id=$1 AND tenant_id=$2", [scope.workspaceId, scope.tenantId],
      );
      if (!workspace.rowCount) throw new OperatingBotError("BUNDLE_NOT_READY");
      const now = await this.now(client);
      await client.query(
        `INSERT INTO eagle_bot_worker_presence (tenant_id,workspace_id,last_seen_at,last_successful_tick_at,valid_until)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id,workspace_id) DO UPDATE SET
            last_seen_at=GREATEST(eagle_bot_worker_presence.last_seen_at,EXCLUDED.last_seen_at),
            last_successful_tick_at=GREATEST(eagle_bot_worker_presence.last_successful_tick_at,EXCLUDED.last_successful_tick_at),
            valid_until=GREATEST(eagle_bot_worker_presence.valid_until,EXCLUDED.valid_until)`,
        [scope.tenantId, scope.workspaceId, now, completedTick ? now : null, new Date(now.getTime() + PRESENCE_TTL_MS)],
      );
    });
  }

  async getWorkerStatus(scope: OperatingBotScope) {
    return this.tx(scope, async (client) => {
      const found = await client.query<{ last_seen_at: Date; last_successful_tick_at: Date | null; valid_until: Date }>(
        "SELECT last_seen_at,last_successful_tick_at,valid_until FROM eagle_bot_worker_presence WHERE tenant_id=$1 AND workspace_id=$2",
        [...scopeParams(scope)],
      );
      const row = found.rows[0];
      const state = !row ? "never" : row.valid_until <= await this.now(client) ? "stale" : "online";
      return {
        state,
        lastSeenAt: row?.last_seen_at.toISOString() ?? null,
        lastSuccessfulTickAt: row?.last_successful_tick_at?.toISOString() ?? null,
      };
    });
  }

  async revokeMandate(scope: OperatingBotScope, actor: OperatingBotActor, mandateId: string): Promise<BotMandate> {
    const id = input(identifier, mandateId);
    return this.tx(scope, async (client) => {
      await assertActor(client, scope, actor, "owner-stop");
      const mandate = await selectMandate(client, scope, id, "update");
      if (mandate.revoked_at) return mandateView(mandate);
      const now = await this.now(client);
      const receipt = await record(client, scope, now, id, "bot_mandate", "eagle.bot.mandate.revoked",
        { capabilityId: CAPABILITY }, { type: "human", id: actor.memberNo });
      const updated = await client.query<MandateRow>(
        "UPDATE eagle_bot_mandates SET revoked_at=$2,event_id=$3,event_hash=$4 WHERE id=$1 RETURNING *",
        [id, now, receipt.eventId, receipt.hash],
      );
      return mandateView(updated.rows[0]!);
    });
  }

  private async insertTask(client: pg.PoolClient, scope: OperatingBotScope, mandate: MandateRow, request: {
    trigger: BotTrigger; requestDigest: string; inputDigest: string; date: string; scheduledAt: Date; now: Date; actor?: ActorInfo;
  }): Promise<TaskRow> {
    const id = randomUUID();
    const deadline = new Date(Math.min(mandate.expires_at.getTime(), request.scheduledAt.getTime() + DELIVERY_WINDOW_MS));
    const expired = deadline <= request.now;
    const status = expired ? "failed" : "queued";
    const errorCode = expired ? "DEADLINE_EXCEEDED" : null;
    await client.query("UPDATE eagle_bot_mandates SET used_runs=used_runs+1 WHERE id=$1", [mandate.id]);
    const receipt = await record(client, scope, request.now, id, "bot_task", expired ? "eagle.bot.task.failed" : "eagle.bot.task.accepted", {
      mandateId: mandate.id, capabilityId: CAPABILITY, trigger: request.trigger, businessUnit: mandate.business_unit,
      businessDate: request.date, asOf: request.scheduledAt.toISOString(), deadline: deadline.toISOString(), status, errorCode,
    }, request.actor);
    const saved = await client.query<TaskRow>(
      `INSERT INTO eagle_bot_tasks (id,tenant_id,workspace_id,mandate_id,business_unit,business_date,trigger,request_digest,
        input_digest,scheduled_at,as_of,deadline,status,available_at,error_code,event_id,event_hash,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$13,$13) RETURNING ${TASK_RETURN}`,
      [id, scope.tenantId, scope.workspaceId, mandate.id, mandate.business_unit, request.date, request.trigger,
        request.requestDigest, request.inputDigest, request.scheduledAt, deadline, status, request.now,
        errorCode, receipt.eventId, receipt.hash],
    );
    return saved.rows[0]!;
  }

  async enqueueManual(scope: OperatingBotScope, actor: OperatingBotActor, value: z.input<typeof manualTaskInput>): Promise<BotTask> {
    const args = input(manualTaskInput, value);
    const requestDigest = digest(args.idempotencyKey);
    const inputDigest = digest(JSON.stringify([actor.memberId, args.mandateId, args.businessDate]));
    return this.tx(scope, async (client) => {
      await this.assertWorkspace(client, scope);
      await assertActor(client, scope, actor, "dispatch");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`eagle:manual:${scope.tenantId}:${scope.workspaceId}:${requestDigest}`]);
      const prior = await client.query<TaskRow>(
        `SELECT ${TASK_RETURN} FROM eagle_bot_tasks WHERE tenant_id=$1 AND workspace_id=$2 AND trigger='manual' AND request_digest=$3`,
        [...scopeParams(scope), requestDigest],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].input_digest !== inputDigest) throw new OperatingBotError("IDEMPOTENCY_CONFLICT");
        return taskView(prior.rows[0]);
      }
      const mandate = await selectMandate(client, scope, args.mandateId, "update");
      const now = await this.now(client);
      if (args.businessDate > localDate(now)) throw new OperatingBotError("INVALID_INPUT");
      if (!await activeMandate(client, scope, mandate, now)) throw new OperatingBotError("MANDATE_INACTIVE");
      if (mandate.used_runs >= mandate.max_runs) throw new OperatingBotError("MANDATE_EXHAUSTED");
      await lockQueueAdmissions(client, scope);
      if (!await hasQueueRoom(client, scope)) throw new OperatingBotError("QUEUE_FULL");
      return taskView(await this.insertTask(client, scope, mandate, {
        trigger: "manual", requestDigest, inputDigest, date: args.businessDate, scheduledAt: now, now,
        actor: { type: "human", id: actor.memberNo },
      }));
    });
  }

  async scheduleDue(scope: OperatingBotScope): Promise<number> {
    return this.tx(scope, async (client) => {
      await this.assertWorkspace(client, scope);
      const now = await this.now(client);
      const due = await client.query<MandateRow>(
        `SELECT * FROM eagle_bot_mandates
          WHERE tenant_id=$1 AND workspace_id=$2 AND revoked_at IS NULL AND next_due_at IS NOT NULL AND next_due_at<expires_at
            AND next_due_at<=$3 AND used_runs<max_runs
          ORDER BY next_due_at,id LIMIT $4 FOR UPDATE SKIP LOCKED`,
        [...scopeParams(scope), now, SCHEDULE_BATCH],
      );
      if (!due.rows.length) return 0;
      await lockQueueAdmissions(client, scope);
      let count = 0;
      for (const mandate of due.rows) {
        const next = mandate.next_due_at!;
        if (mandate.expires_at > now && !await activeMandate(client, scope, mandate, now)) {
          const receipt = await record(client, scope, now, mandate.id, "bot_mandate", "eagle.bot.mandate.revoked",
            { reason: "ISSUER_AUTHORITY_LOST", capabilityId: CAPABILITY });
          await client.query("UPDATE eagle_bot_mandates SET revoked_at=$2,event_id=$3,event_hash=$4 WHERE id=$1",
            [mandate.id, now, receipt.eventId, receipt.hash]);
          continue;
        }
        // Missed occurrences before an expiration remain visible as failed
        // commitments. Their analysis never runs after the authorization ends.
        const willQueue = mandate.expires_at > now && next.getTime() + DELIVERY_WINDOW_MS > now.getTime();
        if (willQueue && !await hasQueueRoom(client, scope)) continue;
        const date = localDate(next);
        const key = digest(`daily:${mandate.id}:${date}`);
        await this.insertTask(client, scope, mandate, { trigger: "daily", requestDigest: key, inputDigest: key, date, scheduledAt: next, now });
        count++;
        await client.query("UPDATE eagle_bot_mandates SET next_due_at=$2 WHERE id=$1", [mandate.id, new Date(next.getTime() + DAY_MS)]);
      }
      return count;
    });
  }

  async listTasks(scope: OperatingBotScope, value: z.input<typeof taskFilter> = {}): Promise<BotTask[]> {
    const args = input(taskFilter, value);
    return this.tx(scope, async (client) => {
      const rows = await client.query<TaskRow>(
        `SELECT * FROM (
          (SELECT ${TASK_RETURN},0 AS history FROM eagle_bot_tasks
            WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR business_unit=$3)
              AND status IN ('queued','running') ORDER BY created_at,id LIMIT $4)
          UNION ALL
          (SELECT ${TASK_RETURN},1 AS history FROM eagle_bot_tasks
            WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR business_unit=$3)
              AND status NOT IN ('queued','running') ORDER BY created_at DESC,id LIMIT $5)
          ) AS lanes ORDER BY history,
            CASE WHEN history=0 THEN created_at END,
            CASE WHEN history=1 THEN created_at END DESC,id`,
        [...scopeParams(scope), args.businessUnit ?? null, OPEN_TASK_LIMIT, args.limit ?? 40],
      );
      return rows.rows.map(taskView);
    });
  }

  private async loadTask(client: pg.PoolClient, scope: OperatingBotScope, id: string, lock = false): Promise<TaskRow> {
    const found = await client.query<TaskRow>(
      `SELECT ${TASK_RETURN} FROM eagle_bot_tasks WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 ${lock ? "FOR UPDATE" : ""}`,
      [...scopeParams(scope), id],
    );
    if (!found.rows[0]) throw new OperatingBotError("NOT_FOUND");
    return found.rows[0];
  }

  async getTask(scope: OperatingBotScope, taskId: string): Promise<BotTask> {
    const id = input(identifier, taskId);
    return this.tx(scope, async (client) => taskView(await this.loadTask(client, scope, id)));
  }

  async listEvents(scope: OperatingBotScope, value: z.input<typeof eventFilter>) {
    const args = input(eventFilter, value);
    return this.tx(scope, async (client) => {
      await this.loadTask(client, scope, args.taskId);
      const found = await client.query<{
        cursor: string; event_id: string; hash: string; action: string; actor: string; at: Date; detail: Record<string, unknown>;
      }>(
        `SELECT seq::text AS cursor,event_id,hash,created_at AS at,
          payload#>>'{decision,action}' AS action,payload#>>'{who,id}' AS actor,payload#>'{decision,after}' AS detail
          FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3
            AND seq>$4::bigint AND payload#>>'{object,type}'='bot_task' ORDER BY seq LIMIT $5`,
        [scope.tenantId, scope.workspaceId, args.taskId, args.after ?? "0", args.limit ?? 40],
      );
      const events = found.rows.map(({ cursor, event_id: eventId, hash, at, action, actor, detail }) =>
        ({ cursor, eventId, hash, at: at.toISOString(), action, actor, detail }));
      return { events, nextCursor: events.at(-1)?.cursor ?? args.after ?? "0" };
    });
  }

  private async settle(client: pg.PoolClient, scope: OperatingBotScope, row: TaskRow, at: Date, disposition: {
    status: "queued" | "succeeded" | "failed" | "cancelled";
    attemptStatus?: "succeeded" | "failed" | "cancelled" | "expired";
    errorCode?: ErrorCode | "CANCELLED";
    availableAt?: Date;
    result?: OperatingBotResult;
    actor?: ActorInfo;
    ruleImpact?: EventDraft["rule_impact"];
  }): Promise<TaskRow> {
    const receipt = await record(client, scope, at, row.id, "bot_task",
      `eagle.bot.task.${disposition.status === "queued" ? "retry_scheduled" : disposition.status}`, {
        mandateId: row.mandate_id, status: disposition.status, attempt: row.attempts,
        ...(disposition.errorCode ? { errorCode: disposition.errorCode } : {}),
        ...(disposition.result ? { result: disposition.result } : {}),
      }, disposition.actor, disposition.ruleImpact);
    if (row.lease_token && disposition.attemptStatus) {
      const attempt = await client.query(
        `UPDATE eagle_bot_attempts SET status=$3,settled_at=$4,error_code=$5,event_id=$6,event_hash=$7
          WHERE task_id=$1 AND lease_token=$2 AND status='running'`,
        [row.id, row.lease_token, disposition.attemptStatus, at, disposition.errorCode ?? null, receipt.eventId, receipt.hash],
      );
      if (attempt.rowCount !== 1) throw new OperatingBotError("LEASE_EXPIRED");
    }
    const updated = await client.query<TaskRow>(
      `UPDATE eagle_bot_tasks SET status=$2,lease_token=NULL,lease_until=NULL,available_at=$3,result=$4,
        error_code=$5,event_id=$6,event_hash=$7,updated_at=$8 WHERE id=$1 RETURNING ${TASK_RETURN}`,
      [row.id, disposition.status, disposition.availableAt ?? at, disposition.result ?? null,
        disposition.errorCode ?? null, receipt.eventId, receipt.hash, at],
    );
    return updated.rows[0]!;
  }

  async cancelTask(scope: OperatingBotScope, actor: OperatingBotActor, taskId: string): Promise<BotTask> {
    const id = input(identifier, taskId);
    return this.tx(scope, async (client) => {
      await assertActor(client, scope, actor, "stop");
      const row = await this.loadTask(client, scope, id, true);
      if (row.status !== "queued" && row.status !== "running") return taskView(row);
      return taskView(await this.settle(client, scope, row, await this.now(client), {
        status: "cancelled", attemptStatus: "cancelled", errorCode: "CANCELLED", actor: { type: "human", id: actor.memberNo },
      }));
    });
  }

  private async recoverExpiredAttempts(scope: OperatingBotScope): Promise<void> {
    await this.tx(scope, async (client) => {
      const now = await this.now(client);
      const expired = await client.query<TaskRow>(
        `SELECT ${TASK_RETURN} FROM eagle_bot_tasks WHERE tenant_id=$1 AND workspace_id=$2 AND status='running' AND lease_until<=$3
          ORDER BY lease_until,id LIMIT 3 FOR UPDATE SKIP LOCKED`, [...scopeParams(scope), now],
      );
      for (const row of expired.rows) {
        const retry = row.attempts < MAX_ATTEMPTS && row.deadline > now;
        await this.settle(client, scope, row, now, {
          status: retry ? "queued" : "failed", attemptStatus: "expired", errorCode: "LEASE_EXPIRED",
        });
      }
    });
  }

  private async claim(scope: OperatingBotScope): Promise<TaskRow | null> {
    return this.tx(scope, async (client) => {
      await this.assertWorkspace(client, scope);
      const now = await this.now(client);
      const queued = await client.query<TaskRow>(
        `SELECT ${TASK_RETURN} FROM eagle_bot_tasks WHERE tenant_id=$1 AND workspace_id=$2 AND status='queued' AND available_at<=$3
          ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [...scopeParams(scope), now],
      );
      const row = queued.rows[0];
      if (!row) return null;
      const mandate = await selectMandate(client, scope, row.mandate_id, "share");
      const errorCode = row.deadline <= now ? "DEADLINE_EXCEEDED"
        : !await activeMandate(client, scope, mandate, now) ? "MANDATE_INACTIVE" : null;
      if (errorCode) return this.settle(client, scope, row, now, { status: "failed", errorCode });
      const leaseToken = randomUUID();
      const leaseUntil = new Date(Math.min(row.deadline.getTime(), now.getTime() + mandate.max_runtime_seconds * 1000 + LEASE_GRACE_MS));
      const receipt = await record(client, scope, now, row.id, "bot_task", "eagle.bot.task.started", {
        status: "running", attempt: row.attempts + 1, leaseUntil: leaseUntil.toISOString(), mandateId: row.mandate_id,
      });
      const updated = await client.query<TaskRow>(
        `UPDATE eagle_bot_tasks SET status='running',attempts=attempts+1,lease_token=$2,lease_until=$3,error_code=NULL,
          event_id=$4,event_hash=$5,updated_at=$6 WHERE id=$1 RETURNING ${TASK_RETURN}`,
        [row.id, leaseToken, leaseUntil, receipt.eventId, receipt.hash, now],
      );
      await client.query(
        `INSERT INTO eagle_bot_attempts (tenant_id,workspace_id,task_id,attempt_no,lease_token,started_at,lease_until,status,event_id,event_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9)`,
        [scope.tenantId, scope.workspaceId, row.id, row.attempts + 1, leaseToken, now, leaseUntil, receipt.eventId, receipt.hash],
      );
      return updated.rows[0]!;
    });
  }

  async runOnce(scope: OperatingBotScope, execute: ExecuteOperatingBrief): Promise<BotTask | null> {
    await this.recoverExpiredAttempts(scope);
    const claim = await this.claim(scope);
    if (!claim || claim.status !== "running") return claim ? taskView(claim) : null;
    try {
      return await this.tx(scope, async (client) => {
        await this.assertWorkspace(client, scope);
        const row = await this.loadTask(client, scope, claim.id, true);
        if (row.status !== "running" || row.lease_token !== claim.lease_token) return taskView(row);
        const mandate = await selectMandate(client, scope, row.mandate_id, "share");
        const now = await this.now(client);
        if (!await activeMandate(client, scope, mandate, now)) throw new OperatingBotError("MANDATE_INACTIVE");
        const finishBy = Math.min(row.deadline.getTime(),
          claim.updated_at.getTime() + mandate.max_runtime_seconds * 1000);
        const remaining = finishBy - now.getTime();
        if (remaining <= 0) throw new OperatingBotError("EXECUTION_TIMEOUT");
        const impacts = await analysisFence(client, scope, row.business_unit);
        await client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining)]);
        const result = await execute(client, scope, {
          businessUnit: row.business_unit, businessDate: row.business_date, asOf: row.as_of.toISOString(), taskId: row.id,
        });
        const settledAt = await this.now(client);
        if (settledAt.getTime() >= finishBy) throw new OperatingBotError("EXECUTION_TIMEOUT");
        if (!result.artifactId || !result.eventId || !/^[a-f0-9]{64}$/u.test(result.hash)) throw new OperatingBotError("EXECUTION_FAILED");
        const proof = await client.query<{ payload: unknown; content_hash: string }>(
          `SELECT b.payload,b.content_hash
            FROM eagle_business_briefs b JOIN biz_events e
              ON e.tenant_id=b.tenant_id AND e.workspace_id=b.workspace_id AND e.event_id=b.event_id AND e.hash=b.event_hash
            WHERE b.tenant_id=$1 AND b.workspace_id=$2 AND b.event_id=$3 AND b.event_hash=$4
              AND e.session_id=$5 AND b.id=$6::uuid AND b.source_run_key=$7
              AND b.business_date=$8::date AND b.as_of=$9::timestamptz
              AND e.payload#>>'{object,type}'='operating_brief' AND e.payload#>>'{object,id}'=$6::uuid::text
              AND e.payload#>>'{decision,action}'='eagle.operating.brief.ready'
              AND e.payload#>>'{decision,after,taskId}'=$5 AND e.payload#>>'{decision,after,artifactId}'=$6::uuid::text
              AND e.payload#>>'{decision,after,contentHash}'=b.content_hash
              AND e.payload#>>'{receipt,mode}'='real' AND e.payload#>>'{receipt,synced}'='true'`,
          [scope.tenantId, scope.workspaceId, result.eventId, result.hash, row.id, result.artifactId, `bot:${row.id}`, row.business_date, row.as_of],
        );
        const artifact = proof.rows[0];
        if (!artifact || digest(canonical(artifact.payload)) !== artifact.content_hash) throw new OperatingBotError("EXECUTION_FAILED");
        const completed = await this.settle(client, scope, row, settledAt, {
          status: "succeeded", attemptStatus: "succeeded", result, ruleImpact: impacts,
        });
        if ((await this.now(client)).getTime() >= finishBy) throw new OperatingBotError("EXECUTION_TIMEOUT");
        return taskView(completed);
      });
    } catch (error) {
      // A lost COMMIT acknowledgment is resolved by reading the original task, whose attempt, artifact and receipt share one transaction.
      const code = error instanceof OperatingBotError ? error.code
        : typeof error === "object" && error && "code" in error ? String(error.code) : "EXECUTION_FAILED";
      return this.tx(scope, async (client) => {
        const row = await this.loadTask(client, scope, claim.id, true);
        if (row.status !== "running" || row.lease_token !== claim.lease_token) return taskView(row);
        const now = await this.now(client);
        const errorCode: ErrorCode = code === "57014" ? "EXECUTION_TIMEOUT"
          : Object.hasOwn(errors, code) ? code as ErrorCode : "EXECUTION_FAILED";
        const retry = /^(40001|40P01|55P03)$/u.test(code) && row.attempts < MAX_ATTEMPTS && row.deadline.getTime() > now.getTime() + 5000;
        return taskView(await this.settle(client, scope, row, now, {
          status: retry ? "queued" : "failed", attemptStatus: "failed", errorCode,
          ...(retry ? { availableAt: new Date(now.getTime() + row.attempts * 1000) } : {}),
        }));
      });
    }
  }
}

export const operatingBot = new OperatingBot();
