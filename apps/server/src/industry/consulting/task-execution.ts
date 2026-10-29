/** Consulting-owned native report execution. Generic threads receive no industry tools or fabricated receipts. */
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient, maskText, type ActorInfo, type EventDraft } from "@workloom/base/workdata";
import { judge, type RuntimeRule } from "@workloom/base/fence-engine";
import { resolveWorkspaceActiveBundle } from "../../service/active-bundle.js";
import type { IndustryThreadExecutor, ThreadQuestOutcome } from "../../runtime/thread-runner.js";
import { getConsultingExecutionContext, type ConsultingExecutionContext } from "./execution-context.js";
import { ConsultingWorkflow, type ConsultingRun, type DraftFile, type Scope } from "./workflow.js";
import { ConsultingError, assertNoCredentials, canonical, sha256 } from "./workflow-core.js";
import { collectPublicSources, PublicSourceVault, type CollectedPublicSources, type FrozenPublicSource,
  type FrozenSearch, type SourceCollectionCheckpoint, type SelectedPublicSource } from "./public-sources.js";

type Phase = "queued" | "collecting_sources" | "planning" | "working" | "draft_ready" | "blocked";
type Control = "active" | "human_required" | "cancelled";
export interface TaskReceipt { eventId: string; hash: string; synced: true }
export interface TaskThread { id: string; title: string; status: string; createdBy: string; mode: string }
export interface TaskStoredEvent { eventId: string; hash: string; at: string; action: string; data: Record<string, unknown> }
export interface TaskProjection {
  status: "queued" | "running" | "completed" | "failed" | "paused" | "cancelled";
  currentAction: string;
  error: string | null;
  progressDone: number;
  progressTotal: number;
  plan?: ConsultingRun["steps"];
}
export interface ConsultingTaskTransaction {
  thread: TaskThread;
  events: TaskStoredEvent[];
  append(action: string, data: Record<string, unknown>, actor: ActorInfo, receipt?: boolean, impacts?: EventDraft["rule_impact"]): Promise<TaskStoredEvent>;
  project(projection: TaskProjection): Promise<void>;
  assertPublicRead?(): Promise<EventDraft["rule_impact"]>;
}
export interface ConsultingTaskStore {
  transaction<T>(scope: Scope, threadId: string, body: (tx: ConsultingTaskTransaction) => Promise<T>): Promise<T>;
}
interface TaskState {
  schemaVersion: "eagle.consulting-task/v1";
  executionSource: "consulting-report";
  threadId: string;
  requestId?: string;
  actorId: string;
  goal: string;
  goalHash: string;
  presetKey: string;
  phase: Phase;
  control: Control;
  runId: string;
  sourceCheckpoint: SourceCollectionCheckpoint;
  selection: CollectedPublicSources | null;
  stepsDone: number;
  stepsTotal: number;
  plan: ConsultingRun["steps"];
  error: { code: string; message: string } | null;
  reportFile: DraftFile | null;
  reportReceipt: TaskReceipt | null;
  operation: { id: string; kind: "search" | "fetch" | "workflow" } | null;
  execution: { id: string; startedAt: string } | null;
}
export interface ConsultingTaskView {
  threadId: string;
  runId: string | null;
  status: Phase | "human_required" | "cancelled";
  phase: Phase;
  stepsDone: number;
  stepsTotal: number;
  humanReviewRequired: true;
  sourceMode: "public-web";
  sources: Array<Omit<SelectedPublicSource, "file">>;
  finalArtifact: { kind: "report"; sha256: string; bytes: number; eventId: string; hash: string; synced: true } | null;
  error: { code: string; message: string } | null;
  availableActions: Record<"resume" | "handoff" | "cancel", { enabled: boolean; reason: string }>;
  lastReceipt: TaskReceipt | null;
  actionReceipt?: TaskReceipt;
}
type ExecutionInput = { threadId: string; goal: string; actorId: string; presetKey: string; requestId?: string };
type WorkflowPort = Pick<ConsultingWorkflow, "dossierPut" | "submit" | "advance" | "get" | "artifact">;
type ContextPort = Pick<ConsultingExecutionContext, "client" | "taskIdentity" | "budgetFile"> & Partial<Pick<ConsultingExecutionContext, "cacheDirectory">>;
export interface ConsultingExecutionDependencies {
  store?: ConsultingTaskStore;
  vault?: PublicSourceVault;
  context?: (input: { scope: Scope; threadId: string; requestId?: string }) => ContextPort;
  activeBundle?: (scope: Scope) => Promise<boolean>;
  workflow?: (context: ContextPort, parentThreadId: string, executionId: string) => WorkflowPort;
}
const SAFE_THREAD = /^T-[A-Za-z0-9_-]{1,110}$/;
const SAFE_REQUEST = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SOURCE_ACTOR: ActorInfo = { id: "intel-researcher", type: "agent", readonly: true, fenceBindings: [] };
const human = (id: string): ActorInfo => ({ id, type: "human" });
const receipt = (event: TaskStoredEvent): TaskReceipt => ({ eventId: event.eventId, hash: event.hash, synced: true });
function requireThread(threadId: string): void {
  if (!SAFE_THREAD.test(threadId)) throw new ConsultingError("INVALID_THREAD", "任务 ID 无效");
}
function reduceTask(events: TaskStoredEvent[]): { state: TaskState | null; lastReceipt: TaskReceipt | null } {
  let state: TaskState | null = null; let lastReceipt: TaskReceipt | null = null;
  for (const event of events) {
    if ((event.action === "thread.execution.bound" || event.action.startsWith("consulting.task.") || event.action.startsWith("consulting.public-source."))
      && event.data.state && typeof event.data.state === "object") {
      const candidate = event.data.state as TaskState;
      if (candidate.schemaVersion !== "eagle.consulting-task/v1" || candidate.executionSource !== "consulting-report") {
        throw new ConsultingError("TASK_STATE_INVALID", "咨询任务状态结构无效，不能猜测或重建执行结果");
      }
      state = candidate; lastReceipt = receipt(event);
      if (event.action === "consulting.task.report.ready") state = { ...candidate, reportReceipt: receipt(event) };
    }
  }
  return { state, lastReceipt };
}
function controlError(state: TaskState): void {
  if (state.control === "human_required") throw new ConsultingError("TASK_HUMAN_REQUIRED", "任务已转人工，等待成员明确继续；保留已取得资料与草稿");
  if (state.control === "cancelled") throw new ConsultingError("TASK_CANCELLED", "任务已停止；保留草稿与历史，不再启动后续步骤");
}
function statusOf(state: TaskState): ConsultingTaskView["status"] { return state.control === "active" ? state.phase : state.control; }
function safeError(error: unknown): { code: string; message: string } {
  const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "TASK_EXECUTION_FAILED";
  const code = /^[A-Z0-9_]{1,80}$/.test(candidate) ? candidate : "TASK_EXECUTION_FAILED";
  if (error instanceof ConsultingError) return { code, message: error.message };
  return { code, message: `咨询报告尚未交付（${code}）。已保留原任务与已知回执；没有更换模型、补造来源或自动重购未知调用。` };
}
function isUncertain(code?: string): boolean {
  return Boolean(code && /^(?:PROVIDER_|OPERATION_|USAGE_|MODEL_RECEIPT|BUDGET_FROZEN|CACHE_|COMMIT_STATUS_UNKNOWN)/.test(code));
}
function viewOf(state: TaskState, lastReceipt: TaskReceipt | null): ConsultingTaskView {
  const status = statusOf(state);
  const inFlight = Boolean(state.execution || state.operation);
  const resumable = state.control === "human_required" && state.phase !== "blocked" && !inFlight;
  const ended = state.control === "cancelled";
  return { threadId: state.threadId, runId: state.runId, status, phase: state.phase,
    stepsDone: state.stepsDone, stepsTotal: state.stepsTotal, humanReviewRequired: true, sourceMode: "public-web",
    sources: (state.selection?.sources ?? []).map(({ file: _file, ...source }) => source),
    finalArtifact: state.reportFile && state.reportReceipt ? { kind: "report", sha256: state.reportFile.sha256,
      bytes: state.reportFile.bytes, ...state.reportReceipt } : null,
    error: state.error,
    availableActions: {
      resume: { enabled: resumable, reason: resumable ? "继续原任务，复用已冻结资料与原步骤回执，不重建或重购已完成调用。"
        : ended ? "任务已停止，不能恢复后续自动执行；原草稿与历史仍可查看。"
          : state.phase === "blocked" && isUncertain(state.error?.code) ? "模型或提交结果存在不确定性，禁止重复付费；请转人工核验原始回执。"
            : state.phase === "blocked" ? "任务有尚未解决的证据或运行错误；先转人工处理，不能用重试跳过校验。"
              : state.control === "human_required" && inFlight ? "原执行仍在结算来源或模型回执，暂不能继续；结算完成后再提交恢复。若服务已重启且原结果未知，须由人工核验原调用，不能重新购买答案。"
                : "当前没有等待成员继续的暂停任务。" },
      handoff: { enabled: !ended && state.control !== "human_required", reason: ended ? "任务已停止，历史和草稿保持可查。"
        : state.control === "human_required" ? "已转人工，后续自动步骤保持暂停。" : "暂停后续自动步骤并留存转人工事件，交由人类顾问接手。" },
      cancel: { enabled: !ended, reason: ended ? "已停止本线程后续执行，未删除草稿或声称撤销任何外部经营动作。"
        : "停止本线程后续执行，保留资料、已发生费用回执和草稿；已在途调用只结算原结果。" },
    }, lastReceipt };
}
function projection(state: TaskState): TaskProjection {
  const status = statusOf(state);
  const currentAction = status === "human_required" ? "已转人工 · 后续自动步骤暂停"
    : status === "cancelled" ? "任务已停止 · 草稿与历史保留"
      : state.phase === "collecting_sources" ? `检索并冻结政府官网资料 · 已取得 ${state.sourceCheckpoint.sources.length} 份正文`
        : state.phase === "planning" ? "基于冻结资料编排六名咨询员工"
          : state.phase === "working" ? `形成咨询报告待审稿 · 已完成 ${state.stepsDone}/${state.stepsTotal} 步`
            : state.phase === "draft_ready" ? "内部报告待审稿已生成 · 待人类顾问审阅"
              : state.phase === "blocked" ? `未交付 · ${state.error?.message ?? "需人工核验"}` : "咨询报告任务排队中";
  return { status: status === "human_required" ? "paused" : status === "cancelled" ? "cancelled"
    : state.phase === "draft_ready" ? "completed" : state.phase === "blocked" ? "failed" : "running",
    currentAction, error: state.error?.message ?? null, progressDone: state.stepsDone, progressTotal: state.stepsTotal,
    ...(state.plan.length ? { plan: state.plan } : {}) };
}

/** RLS scope, task-control lock, task event and thread projection share one transaction. */
export class PgConsultingTaskStore implements ConsultingTaskStore {
  constructor(private readonly pool: () => pg.Pool = getAppPool) {}
  async transaction<T>(scope: Scope, threadId: string, body: (tx: ConsultingTaskTransaction) => Promise<T>): Promise<T> {
    requireThread(threadId); const client = await this.pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)", [scope.tenantId, scope.workspaceId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`consulting-task:${scope.tenantId}:${scope.workspaceId}:${threadId}`]);
      const threadResult = await client.query<{ id: string; title: string; status: string; created_by: string; mode: string }>(
        `SELECT id,title,status,created_by,mode FROM threads WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR NO KEY UPDATE`,
        [threadId, scope.tenantId, scope.workspaceId]);
      const row = threadResult.rows[0]; if (!row) throw new ConsultingError("NOT_FOUND", "任务不属于当前租户与工作区");
      const records = await client.query<{ event_id: string; hash: string; payload: EventDraft }>(
        `SELECT event_id,hash,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq`,
        [scope.tenantId, scope.workspaceId, threadId]);
      const events: TaskStoredEvent[] = records.rows.map((item) => ({ eventId: item.event_id, hash: item.hash,
        at: item.payload.context.time, action: item.payload.decision.action, data: (item.payload.decision.after ?? {}) as Record<string, unknown> }));
      const tx: ConsultingTaskTransaction = {
        thread: { id: row.id, title: row.title, status: row.status, createdBy: row.created_by, mode: row.mode }, events,
        append: async (action, data, actor, confirmed, impacts) => {
          const time = new Date().toISOString();
          const saved = await gatewayAppendOnClient(client, { ...scope, actor, sessionId: threadId }, {
            who: { id: actor.id, type: actor.type, ...(actor.type === "agent" ? { version: "v1.0" } : {}) },
            context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time, channel: "consulting-native" },
            object: { type: "thread", id: threadId }, decision: { action, after: data,
              basis: ["咨询行业内部报告任务；仅公开官网资料与本机草稿，不代替人类顾问审阅或执行外发"] }, rule_impact: impacts ?? [],
            ...(confirmed ? { receipt: { synced: true, mode: "real", verified_at: time,
              snapshot_uri: `workloom://consulting-task/${threadId}/${action}` } } : {}),
          });
          const event = { eventId: saved.eventId, hash: saved.hash, at: time, action, data }; events.push(event); return event;
        },
        project: async (value) => {
          await client.query(`UPDATE threads SET status=$4,current_action=$5,error=$6,progress_done=$7,progress_total=$8,
            plan=CASE WHEN $9::jsonb IS NULL THEN plan ELSE $9::jsonb END,
            plan_version=CASE WHEN $9::jsonb IS NULL THEN plan_version ELSE GREATEST(COALESCE(plan_version,0),1) END,
            updated_at=now() WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3`,
          [threadId, scope.tenantId, scope.workspaceId, value.status, value.currentAction, value.error, value.progressDone, value.progressTotal,
            value.plan ? JSON.stringify(value.plan.map((step) => ({ ...step, stepId: step.id, label: step.objective, tool: "consulting.analysis.read", action: "consulting.analysis.read", objectType: "enterprise" }))) : null]);
        },
        assertPublicRead: async () => {
          const worker = await client.query<{ status: string; skills: string[] }>(
            `SELECT status,skills FROM agents WHERE workspace_id=$1 AND preset_key='intel-researcher'`, [scope.workspaceId]);
          if (worker.rows[0]?.status !== "ready" || !worker.rows[0].skills.includes("pre-meeting-brief")) {
            throw new ConsultingError("PUBLIC_RESEARCHER_NOT_READY", "情报研究员或其已绑定研究技能尚未就绪，不能调用公开来源工具");
          }
          const installed = await client.query(`SELECT 1 FROM skill_installs si JOIN skills s ON s.id=si.skill_id
            WHERE si.workspace_id=$1 AND s.bundle='consulting' AND s.name='pre-meeting-brief'`, [scope.workspaceId]);
          if (!installed.rowCount) throw new ConsultingError("PUBLIC_RESEARCHER_NOT_READY", "情报研究员的公开研究技能未安装到当前工作区，不能仅凭员工声明启动来源工具");
          const rules = await client.query<{ rule_id: string; version: string; name: string; level: RuntimeRule["level"]; is_baseline: boolean;
            match_spec: { object_types: string[]; actions: string[]; when: string } }>(
            `SELECT rule_id,version,name,level,is_baseline,match_spec FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'`, [scope.workspaceId]);
          const verdict = judge({ object: { type: "enterprise", id: threadId }, action: "web.research", effect: "read",
            params: { public_only: true, third_party: false, pii_desensitized: true } },
          rules.rows.map((rule) => ({ ...rule, objectTypes: rule.match_spec.object_types, actions: rule.match_spec.actions, when: rule.match_spec.when })), "review");
          if (verdict.level !== "auto") throw new ConsultingError("FENCE_BLOCKED", "当前围栏阻止公开资料采集，不能跳过人工或阻断关卡");
          return verdict.impacts;
        },
      };
      const value = await body(tx); await client.query("COMMIT"); return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "咨询任务事务失败，回滚亦未确认"); }
      throw error;
    } finally { client.release(); }
  }
}

function workflowKey(state: Pick<TaskState, "requestId" | "threadId">): string { return `consulting-thread:${state.requestId ?? state.threadId}:v1`; }
function reportGoal(goal: string): boolean { return /报告|调研|行业研究|产业分析|简报/u.test(goal); }
function unsupportedGoal(goal: string): string | null {
  if (/发送给|外发|群发|发布到|通知客户|代为访谈|替我访谈|联系客户/u.test(goal)) return "本入口仅形成内部报告待审稿，外发、通知和人类访谈必须单独由人类顾问处理。";
  if (/内部报表|客户档案|客户资料|上传|附件|这份报表|薪酬|银行流水|私密|内部资料/u.test(goal)) return "此任务依赖客户内部资料；请由人类顾问在一企一档核定授权来源，当前公开研究入口不会读取或外传私人档案。";
  if (!reportGoal(goal)) return "当前咨询执行桥只支持有明确资料范围的内部研究报告，其他经营动作需使用已连接的行业能力。";
  return null;
}

export class ConsultingTaskService {
  private readonly store: ConsultingTaskStore;
  constructor(private readonly deps: ConsultingExecutionDependencies = {}) {
    this.store = deps.store ?? new PgConsultingTaskStore();
  }
  private context(scope: Scope, input: { threadId: string; requestId?: string }): ContextPort {
    return (this.deps.context ?? getConsultingExecutionContext)({ scope, threadId: input.threadId,
      ...(input.requestId ? { requestId: input.requestId } : {}) });
  }
  private vault(scope: Scope, state: { threadId: string; requestId?: string }, context?: ContextPort): PublicSourceVault {
    if (this.deps.vault) return this.deps.vault;
    const current = context ?? this.context(scope, state);
    if (!current.cacheDirectory) throw new ConsultingError("TASK_STORAGE_UNAVAILABLE", "执行上下文缺少同源本机资料目录，禁止写到另一默认位置");
    return new PublicSourceVault(join(dirname(dirname(current.cacheDirectory)), "public-research"));
  }
  async claimsIndustry(scope: Scope): Promise<boolean> {
    if (this.deps.activeBundle) return this.deps.activeBundle(scope);
    const bundle = await resolveWorkspaceActiveBundle(scope.workspaceId); return bundle.state === "ready" && bundle.bundleId === "consulting";
  }
  private async assertActiveIndustry(scope: Scope): Promise<void> {
    if (!await this.claimsIndustry(scope)) throw new ConsultingError("BUNDLE_NOT_READY", "本任务仍属于原咨询报告流程，但当前咨询行业包已失效或变更；保留原资料与回执，不启动新的来源或模型调用");
  }
  async isBound(scope: Scope, threadId: string): Promise<boolean> {
    return this.store.transaction(scope, threadId, async (tx) => reduceTask(tx.events).state !== null);
  }
  private async snapshot(scope: Scope, threadId: string) {
    return this.store.transaction(scope, threadId, async (tx) => {
      const reduced = reduceTask(tx.events); if (!reduced.state) throw new ConsultingError("NOT_FOUND", "此线程尚未绑定咨询报告执行流程");
      return { state: structuredClone(reduced.state), lastReceipt: reduced.lastReceipt };
    });
  }
  private async update(scope: Scope, threadId: string, action: string, modify: (state: TaskState) => TaskState,
    data: Record<string, unknown> = {}, actor?: ActorInfo, publicRead = false) {
    return this.store.transaction(scope, threadId, async (tx) => {
      const current = reduceTask(tx.events).state; if (!current) throw new ConsultingError("NOT_FOUND", "咨询任务不存在");
      const next = modify(structuredClone(current));
      const impacts = publicRead ? await tx.assertPublicRead?.() : undefined;
      const event = await tx.append(action, { ...data, state: next }, actor ?? human(current.actorId), true, impacts);
      const durable = action === "consulting.task.report.ready" ? { ...next, reportReceipt: receipt(event) } : next;
      await tx.project(projection(durable)); return { state: durable, lastReceipt: receipt(event) };
    });
  }
  async view(scope: Scope, threadId: string): Promise<ConsultingTaskView> {
    const current = await this.snapshot(scope, threadId);
    if (current.state.reportFile && current.state.reportReceipt) await this.vault(scope, current.state).read(scope, threadId, current.state.reportFile);
    return viewOf(current.state, current.lastReceipt);
  }
  async report(scope: Scope, threadId: string) {
    const { state } = await this.snapshot(scope, threadId);
    if (!state.reportFile || !state.reportReceipt) throw new ConsultingError("REPORT_NOT_READY", "尚未生成有完整文件与事件回执的报告；不能以任务状态代替文件");
    const content = await this.vault(scope, state).read(scope, threadId, state.reportFile);
    return { threadId, runId: state.runId, content, sha256: state.reportFile.sha256, bytes: state.reportFile.bytes,
      receipt: state.reportReceipt, humanReviewRequired: true as const };
  }
  async action(scope: Scope, actorId: string, input: { threadId: string; action: "resume" | "handoff" | "cancel"; idempotencyKey: string; reason?: string }): Promise<ConsultingTaskView> {
    assertNoCredentials(JSON.stringify(input));
    const requestKey = sha256(input.idempotencyKey);
    const fingerprint = sha256(canonical({ action: input.action, reason: input.reason ?? "", actorId }));
    return this.store.transaction(scope, input.threadId, async (tx) => {
      const reduced = reduceTask(tx.events); const state = reduced.state;
      if (!state) throw new ConsultingError("NOT_FOUND", "此线程没有可操作的咨询报告任务");
      const existing = tx.events.find((event) => event.action === "consulting.task.control" && event.data.requestKey === requestKey);
      if (existing) {
        if (existing.data.fingerprint !== fingerprint) throw new ConsultingError("IDEMPOTENCY_CONFLICT", "同一个操作键不能用于不同动作、原因或操作者");
        return { ...viewOf(state, reduced.lastReceipt), actionReceipt: receipt(existing) };
      }
      const available = viewOf(state, reduced.lastReceipt).availableActions[input.action];
      if (!available.enabled) throw new ConsultingError("ACTION_NOT_AVAILABLE", available.reason);
      const next = { ...state, control: input.action === "handoff" ? "human_required" as const : input.action === "cancel" ? "cancelled" as const : "active" as const };
      const event = await tx.append("consulting.task.control", { action: input.action, reason: maskText(input.reason ?? "").text,
        requestKey, fingerprint, state: next }, human(actorId), true);
      const visible = projection(next); if (input.action === "resume" && next.phase !== "draft_ready") visible.status = "queued";
      await tx.project(visible);
      return { ...viewOf(next, receipt(event)), actionReceipt: receipt(event) };
    });
  }
  private async bind(scope: Scope, input: ExecutionInput): Promise<TaskState> {
    requireThread(input.threadId); assertNoCredentials(input.goal);
    if (!input.actorId || (input.requestId !== undefined && !SAFE_REQUEST.test(input.requestId)) || input.goal.length < 8 || input.goal.length > 500) {
      throw new ConsultingError("INVALID_TASK_INPUT", "咨询任务身份、稳定请求或目标长度无效");
    }
    const goal = maskText(input.goal).text; const goalHash = sha256(goal);
    return this.store.transaction(scope, input.threadId, async (tx) => {
      const prior = reduceTask(tx.events).state;
      if (prior) {
        if (prior.goalHash !== goalHash || prior.requestId !== input.requestId) throw new ConsultingError("TASK_INPUT_DRIFT", "原任务目标或请求身份已变化，保留原件；请明确创建新任务，不能借重试重购");
        return structuredClone(prior);
      }
      const idempotencyKey = workflowKey(input);
      const state: TaskState = { schemaVersion: "eagle.consulting-task/v1", executionSource: "consulting-report", threadId: input.threadId,
        ...(input.requestId ? { requestId: input.requestId } : {}), actorId: input.actorId, goal, goalHash, presetKey: input.presetKey,
        phase: "queued", control: "active", runId: `CR-${sha256(`${scope.tenantId}:${scope.workspaceId}:${idempotencyKey}`).slice(0, 24)}`,
        sourceCheckpoint: { search: null, sources: [] }, selection: null, stepsDone: 0, stepsTotal: 6, plan: [],
        error: null, reportFile: null, reportReceipt: null, operation: null, execution: null };
      await tx.append("thread.execution.bound", { executionSource: "consulting-report", workflowId: state.runId, requestId: input.requestId ?? null, state }, human(input.actorId), true);
      await tx.project(projection(state)); return state;
    });
  }
  private outcome(state: TaskState): ThreadQuestOutcome {
    const projected = projection(state);
    return { threadId: state.threadId, presetKey: state.presetKey, status: projected.status === "queued" ? "running" : projected.status,
      stepsDone: state.stepsDone, stepsTotal: state.stepsTotal, unverified: state.error ? [state.error.message] : [],
      executionSource: "consulting-report", current_action: projected.currentAction, ...(state.error ? { error: state.error.message } : {}) };
  }
  async execute(scope: Scope, input: ExecutionInput): Promise<ThreadQuestOutcome> {
    const state = await this.bind(scope, input);
    if (state.control !== "active" || state.phase === "blocked") return this.outcome(state);
    if (state.phase === "draft_ready") { await this.report(scope, input.threadId); return this.outcome(state); }
    // The task-level claim is durable and shares the stop/handoff transaction lock.
    // A second process or service instance only reads the existing execution. A
    // crashed claim is never reclaimed speculatively or used to buy another call.
    const executionId = randomUUID();
    const claimed = await this.store.transaction(scope, input.threadId, async tx => {
      const current = reduceTask(tx.events).state;
      if (!current) throw new ConsultingError("NOT_FOUND", "咨询任务不存在");
      if (current.execution || current.operation || current.control !== "active" || current.phase === "blocked" || current.phase === "draft_ready") return null;
      const next = { ...current, execution: { id: executionId, startedAt: new Date().toISOString() } };
      await tx.append("consulting.task.execution.started", { executionId, state: next }, human(current.actorId), true);
      await tx.project(projection(next)); return next;
    });
    if (!claimed) return this.outcome((await this.snapshot(scope, input.threadId)).state);
    try { await this.executeClaimed(scope, input, claimed); }
    finally {
      try {
        await this.update(scope, input.threadId, "consulting.task.execution.settled", next => {
          if (next.execution?.id !== executionId) throw new ConsultingError("TASK_EXECUTION_CLAIM_LOST", "原任务执行认领已变化，不能清除其他执行的状态");
          return { ...next, execution: null };
        }, { executionId });
      } catch (error) {
        // A lost COMMIT acknowledgement may follow a durable release. Read it
        // back before reporting uncertainty; never start another execution here.
        const settled = await this.snapshot(scope, input.threadId);
        if (settled.state.execution?.id === executionId) throw error;
        if (settled.state.execution) throw new ConsultingError("TASK_EXECUTION_CLAIM_LOST", "任务执行认领已变化，保留原回执并停止");
      }
    }
    return this.outcome((await this.snapshot(scope, input.threadId)).state);
  }
  private async executeClaimed(scope: Scope, input: ExecutionInput, claimed: TaskState): Promise<ThreadQuestOutcome> {
    let state = claimed;
    try {
      await this.assertActiveIndustry(scope);
      const unsupported = unsupportedGoal(state.goal);
      if (unsupported) throw new ConsultingError("HUMAN_SCOPE_REQUIRED", unsupported);
      const context = this.context(scope, input); const vault = this.vault(scope, state, context);
      const workflow = this.deps.workflow ? this.deps.workflow(context, input.threadId, claimed.execution!.id) : new ConsultingWorkflow({ model: () => context.client,
        parentThreadId: input.threadId, parentExecutionId: claimed.execution!.id, sourceTrust: "public-source-excerpts-unverified" });
      if (!state.selection) {
        await this.update(scope, input.threadId, "consulting.task.phase", (next) => ({ ...next, phase: "collecting_sources" }));
        const selection = await collectPublicSources({ scope, threadId: input.threadId, goal: state.goal }, { client: context.client, vault,
          journal: {
            read: async () => (await this.snapshot(scope, input.threadId)).state.sourceCheckpoint,
            beforeCall: async (operation) => { await this.assertActiveIndustry(scope);
              await this.update(scope, input.threadId, "consulting.task.operation.started", (next) => {
              controlError(next);
              if (next.operation) throw new ConsultingError("TASK_OPERATION_IN_PROGRESS", "原来源调用仍在结算，不能同时启动另一操作");
              return { ...next, operation };
            }, { operation }, human(state.actorId), true); },
            saveSearch: async (search: FrozenSearch) => { await this.update(scope, input.threadId, "consulting.public-source.search", (next) => ({
              ...next, sourceCheckpoint: { ...next.sourceCheckpoint, search }, operation: null,
            }), { reservationId: search.reservationId, file: search.file }, SOURCE_ACTOR); },
            saveSource: async (source: FrozenPublicSource) => { await this.update(scope, input.threadId, "consulting.public-source.fetch", (next) => ({
              ...next, sourceCheckpoint: { ...next.sourceCheckpoint, sources: [...next.sourceCheckpoint.sources, source] }, operation: null,
            }), { reservationId: source.reservationId, sourceId: source.id, file: source.file }, SOURCE_ACTOR); },
          },
        });
        ({ state } = await this.update(scope, input.threadId, "consulting.task.sources.frozen", (next) => ({ ...next, selection, phase: "planning", operation: null })));
      }
      state = (await this.snapshot(scope, input.threadId)).state; controlError(state);
      const selection = state.selection!;
      await vault.read(scope, input.threadId, selection.manifestFile);
      const enterpriseId = `research-${input.threadId}`;
      await workflow.dossierPut(scope, state.actorId, { enterpriseId, sources: selection.modelSources, idempotencyKey: `${workflowKey(state)}:dossier` });
      await this.assertActiveIndustry(scope);
      await this.update(scope, input.threadId, "consulting.task.operation.started", (next) => {
        controlError(next); return { ...next, phase: "planning", operation: { id: "workflow-submit", kind: "workflow" } };
      });
      let run = await workflow.submit(scope, state.actorId, { enterpriseId, goal: state.goal, idempotencyKey: workflowKey(state) });
      ({ state } = await this.update(scope, input.threadId, "consulting.task.progress", (next) => ({ ...next, phase: "working", operation: null,
        runId: run.id, stepsDone: run.completed.length, stepsTotal: run.steps.length || 6, plan: run.steps })));
      if (state.control !== "active") return this.outcome(state);
      if (run.status === "blocked") throw new ConsultingError(run.error?.code ?? "WORKFLOW_BLOCKED", run.error?.message ?? "咨询模型步骤被阻断");
      while (run.status !== "draft_ready") {
        state = (await this.snapshot(scope, input.threadId)).state; controlError(state);
        if (run.status !== "queued") throw new ConsultingError("WORKFLOW_NOT_READY", "原步骤尚在执行或等待处理，不能创建新认领或重复调用");
        await this.assertActiveIndustry(scope);
        await this.update(scope, input.threadId, "consulting.task.operation.started", next => {
          controlError(next);
          if (next.operation) throw new ConsultingError("TASK_OPERATION_IN_PROGRESS", "原模型步骤仍在结算，不能同时启动后续步骤");
          return { ...next, operation: { id: `workflow-advance:${run.completed.length}`, kind: "workflow" } };
        });
        run = await workflow.advance(scope, state.actorId, { runId: run.id, idempotencyKey: `${workflowKey(state)}:advance:${run.completed.length}` });
        ({ state } = await this.update(scope, input.threadId, "consulting.task.progress", (next) => ({ ...next, stepsDone: run.completed.length,
          stepsTotal: run.steps.length || 6, plan: run.steps, phase: "working", operation: null })));
        if (state.control !== "active") return this.outcome(state);
        if (run.status === "blocked") throw new ConsultingError(run.error?.code ?? "WORKFLOW_BLOCKED", run.error?.message ?? "咨询模型步骤被阻断");
      }
      controlError((await this.snapshot(scope, input.threadId)).state);
      const content = await this.compileReport(scope, state, run, workflow);
      const file = await vault.write(scope, input.threadId, "report", sha256(content), content);
      await vault.read(scope, input.threadId, file);
      const qualityDecision = run.completed.at(-1)?.artifact.reviewDecision;
      const qualityNeedsHuman = run.steps.at(-1)?.employeeKey === "quality-officer" && qualityDecision !== "approved";
      ({ state } = await this.update(scope, input.threadId, "consulting.task.report.ready", (next) => {
        controlError(next);
        return {
          ...next,
          reportFile: file,
          phase: "draft_ready",
          ...(qualityNeedsHuman
            ? {
              control: "human_required",
              error: {
                code: "QUALITY_REVIEW_REQUIRED",
                message: "独立质检未批准当前草稿；报告文件已保留，须由人类顾问按质检意见处理。",
              },
            }
            : { error: null }),
          operation: null,
        };
      }, { file, runId: run.id, sourceDigest: selection.sourceDigest }));
      return this.outcome(state);
    } catch (error) {
      const current = await this.snapshot(scope, input.threadId);
      if (current.state.control !== "active") return this.outcome(current.state);
      if (current.state.phase === "draft_ready" && current.state.reportFile && current.state.reportReceipt) {
        await this.report(scope, input.threadId); return this.outcome(current.state);
      }
      ({ state } = await this.update(scope, input.threadId, "consulting.task.failed", (next) => ({ ...next, phase: "blocked", error: safeError(error) })));
      return this.outcome(state);
    }
  }
  private async compileReport(scope: Scope, state: TaskState, run: ConsultingRun, workflow: WorkflowPort): Promise<string> {
    if (run.status !== "draft_ready" || run.completed.length !== 6 || run.steps[4]?.employeeKey !== "report-composer"
      || run.steps[5]?.employeeKey !== "quality-officer" || !state.selection) throw new ConsultingError("REPORT_NOT_READY", "报告与独立质检步骤均需有真实回执后才能汇编文件");
    const files = await Promise.all(run.steps.map((step) => workflow.artifact(scope, run.id, step.id)));
    for (const [index, file] of files.entries()) {
      if (!file.receipt.synced || file.receipt.eventId !== run.completed[index]!.eventId || sha256(file.content) !== run.completed[index]!.file.sha256) {
        throw new ConsultingError("ARTIFACT_HASH_MISMATCH", "报告输入文件与原步骤回执不一致");
      }
    }
    const sourceNotes = state.selection.sources.map((source) => {
      const excerpt = state.selection!.modelSources.find((item) => item.id === source.id)!;
      const date = source.publishedAt ?? "未提供，未核实";
      return `### ${source.id} · ${source.title.replace(/[\r\n<>]/g, " ")}\n\n- 官网：${source.url}\n- 发布日期：${date}；日期依据：${source.publicationDateSource}\n- 采集时间：${source.retrievedAt}\n- 完整返回正文：${source.fullBytes} 字节；SHA256：${source.sha256}\n- 模型摘录：${source.excerptBytes} 字节；SHA256：${source.excerptSha256}\n- 原文 UTF-8 字节范围（左闭右开）：${source.excerptRanges.map((range) => `[${range.startByte}, ${range.endByte})`).join("、")}\n\n${excerpt.content.split("\n").map((line) => `> ${line}`).join("\n")}\n`;
    }).join("\n");
    const title = state.goal.replace(/[\r\n<>]/g, " ");
    const text = `# ${title}\n\n> 内部报告待审稿。待人类顾问审阅与最终定调；未向客户、同事或外部渠道发送。\n\n## 报告正文\n\n${files[4]!.content}\n\n## 独立质检与反证\n\n${files[5]!.content}\n\n## 公开来源与采集范围\n\n${state.selection.disclosure}\n\n- 实际检索式：${state.selection.query}\n- 资料摘录摘要：${state.selection.sourceDigest}\n\n${sourceNotes}\n\n## 分析支撑材料\n\n${files.slice(0, 4).map((file, index) => `### 支撑步骤 ${index + 1}\n\n${file.content}`).join("\n\n")}\n\n## 任务与审阅边界\n\n- 线程：${state.threadId}；咨询流程：${run.id}\n- 本文件由已校验的员工草稿、独立质检和公开来源目录汇编，未额外生成模型答案。\n- 官方公开信息、报告期间与政策目标仍须逐项审阅；行业层面资料不能代替企业经营事实。\n- 转人工与停止仅控制后续自动执行；历史、已发生费用回执与草稿保留。\n`;
    assertNoCredentials(text); return text;
  }
}

export const consultingTaskService = new ConsultingTaskService();
/** Registered by the industry composition root; legacy unbound threads are not reclassified by title. */
export function createConsultingIndustryThreadExecutor(deps: ConsultingExecutionDependencies = {}): IndustryThreadExecutor {
  const service = Object.keys(deps).length ? new ConsultingTaskService(deps) : consultingTaskService;
  return async ({ scope, input, presetKey, taskContext }) => {
    if (input.mode === "agent") return undefined;
    const bound = await service.isBound(scope, input.threadId);
    if (!bound && !await service.claimsIndustry(scope)) return undefined;
    if (!bound && (!taskContext.requestId || !reportGoal(input.goal))) return undefined;
    if (!input.actorId) throw new ConsultingError("TASK_ACTOR_MISSING", "任务缺少服务端核验的派单成员");
    return service.execute(scope, { threadId: input.threadId, goal: input.goal, actorId: input.actorId, presetKey,
      ...(taskContext.requestId ? { requestId: taskContext.requestId } : {}) });
  };
}
