import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AsyncState, Badge, Button, Card, clientChineseText, clientIdentifierText } from "@workloom/ui";
import { trpc } from "../../../lib/trpc";
import { WriteFeedback } from "./WorkCards";
import { businessDay, dateAndTimeIso, displayTime } from "./format";
import { useBusinessResource, useBusinessWrite } from "./useWork";

type BotStatus = Awaited<ReturnType<typeof trpc.business.botStatus.query>>;
type Task = BotStatus["tasks"][number];
type Mandate = BotStatus["mandates"][number];

const TASK_STATUS: Record<Task["status"], string> = {
  queued: "等待执行",
  running: "执行中",
  succeeded: "已生成并回执",
  failed: "未完成",
  cancelled: "已停止",
};

function taskReason(code: string | null) {
  switch (code) {
    case "MANDATE_INACTIVE": return "委托已到期或撤回";
    case "MANDATE_EXHAUSTED": return "运行次数已用完";
    case "DEADLINE_EXCEEDED": return "运行超出允许时间";
    case "FENCE_BLOCKED": return "当前策略已阻断操作";
    case "CANCELLED": return "任务已停止";
    default: return code ? "服务未完成本次运行，请查看已记录的状态。" : "";
  }
}

function mandateStatus(mandate: Mandate) {
  if (mandate.revokedAt) return "已撤回";
  if (new Date(mandate.expiresAt).getTime() <= Date.now()) return "已到期";
  if (mandate.usedRuns >= mandate.maxRuns) return "次数已用完";
  return "生效中";
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "eagle.bot.task.accepted": "任务已受理",
  "eagle.bot.task.started": "后台已开始执行",
  "eagle.bot.task.retry_scheduled": "已安排重试",
  "eagle.bot.task.succeeded": "结果已入账",
  "eagle.bot.task.failed": "运行未完成",
  "eagle.bot.task.cancelled": "已停止任务",
};

function TaskTimeline({ taskId }: { taskId: string }) {
  const [after, setAfter] = useState<string | undefined>();
  const load = useCallback(() => trpc.business.taskEvents.query({ taskId, after, limit: 40 }), [taskId, after]);
  const state = useBusinessResource(load);
  if (state.loading) return <p className="text-body text-ink3" role="status">正在读取运行记录</p>;
  if (state.message) return <AsyncState status="error" title="运行记录暂不可读" description={state.message} onRetry={state.reload} />;
  return <div className="space-y-2">
    {!state.value?.events.length && <p className="text-body text-ink3">这页暂无记录。</p>}
    {!!state.value?.events.length && <ol className="divide-y divide-line rounded-lg border border-line bg-panel">
      {state.value.events.map((event) => <li key={event.cursor} className="p-2 text-body">
        <p className="font-medium text-ink">{clientChineseText(EVENT_LABELS[event.action], "已记录运行事件")} · {displayTime(event.at)}</p>
        <p className="break-all text-ink3">回执 {clientIdentifierText(event.eventId)}</p>
      </li>)}
    </ol>}
    <div className="flex flex-wrap gap-2">
      {after && <Button type="button" variant="quiet" onClick={() => setAfter(undefined)}>返回首批记录</Button>}
      {state.value?.events.length === 40 && <Button type="button" variant="quiet" onClick={() => setAfter(state.value?.nextCursor)}>下一批记录</Button>}
    </div>
  </div>;
}

function TaskDetail({ task, scope, canManage, onViewBrief, reload }: {
  task: Task;
  scope: string;
  canManage: boolean;
  onViewBrief: (artifactId: string) => void;
  reload: () => Promise<void>;
}) {
  const write = useBusinessWrite(scope);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const load = useCallback(() => trpc.business.taskView.query({ taskId: task.id }), [task.id]);
  const detail = useBusinessResource(load);
  const current = detail.value ?? task;
  const isActive = current.status === "queued" || current.status === "running";

  async function cancel() {
    const payload = { taskId: task.id };
    const result = await write.submit("停止自动任务", payload, () => trpc.business.cancelTask.mutate(payload));
    if (result) {
      setConfirmCancel(false);
      await Promise.all([detail.reload(), reload()]);
    }
  }

  return <Card className="min-w-0 space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-bold text-ink">{task.businessDate} 经营晨报</h3>
      <Badge tone={current.status === "succeeded" ? "success" : current.status === "failed" ? "warning" : "neutral"}>{TASK_STATUS[current.status]}</Badge>
    </div>
    <dl className="grid grid-cols-2 gap-3 text-body">
      <div><dt className="text-ink3">启动方式</dt><dd className="text-ink">{task.trigger === "daily" ? "定时" : "手动"}</dd></div>
      <div><dt className="text-ink3">允许执行到</dt><dd className="text-ink">{displayTime(task.deadline)}</dd></div>
      <div><dt className="text-ink3">排队时间</dt><dd className="text-ink">{displayTime(task.scheduledAt)}</dd></div>
      <div><dt className="text-ink3">执行次数</dt><dd className="text-ink">{current.attempts}</dd></div>
    </dl>
    {taskReason(current.errorCode) && <p className="text-body text-warn">{taskReason(current.errorCode)}</p>}
    {detail.message && <AsyncState status="error" title="任务详情暂不可刷新" description={detail.message} onRetry={detail.reload} />}
    {current.status === "succeeded" && current.result && <div className="space-y-2">
      <Button type="button" variant="primary" onClick={() => current.result && onViewBrief(current.result.artifactId)}>打开本次晨报</Button>
      <p className="break-all text-body text-ink3">晨报回执 {clientIdentifierText(current.result.eventId)}</p>
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="quiet" disabled={detail.loading} onClick={() => void detail.reload()}>{detail.loading ? "正在刷新…" : "刷新任务状态"}</Button>
      <Button type="button" variant="quiet" aria-expanded={showEvents} onClick={() => setShowEvents(!showEvents)}>{showEvents ? "收起运行记录" : "查看运行记录"}</Button>
      {canManage && isActive && <Button type="button" variant="quiet" aria-expanded={confirmCancel} onClick={() => setConfirmCancel(!confirmCancel)}>停止后续执行</Button>}
    </div>
    {showEvents && <TaskTimeline taskId={task.id} />}
    {confirmCancel && <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
      <p className="text-body text-ink2">确认后将停止这个 自动任务的后续执行，历史与已有回执仍可查阅。</p>
      <Button type="button" variant="danger" disabled={write.busy} busy={write.busy} onClick={() => void cancel()}>确认停止</Button>
    </div>}
    <WriteFeedback message={write.message} receipt={write.receipt} />
  </Card>;
}

function MandateSettings({ mandates, scope, onChange }: {
  mandates: Mandate[];
  scope: string;
  onChange: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expires, setExpires] = useState("");
  const [runs, setRuns] = useState("7");
  const [runtime, setRuntime] = useState("120");
  const [dailyAt, setDailyAt] = useState("");
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const write = useBusinessWrite(scope);

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!expires) return;
    const payload = { expiresAt: dateAndTimeIso(expires), maxRuns: Number(runs), maxRuntimeSeconds: Number(runtime), ...(dailyAt ? { dailyAt } : {}) };
    const result = await write.submit("创建运行委托", payload, (idempotencyKey) => trpc.business.grantMandate.mutate({ ...payload, idempotencyKey }));
    if (result) {
      setExpanded(false);
      await onChange();
    }
  }

  async function revoke(mandateId: string) {
    const payload = { mandateId };
    const result = await write.submit("撤回运行委托", payload, () => trpc.business.revokeMandate.mutate(payload));
    if (result) {
      setRevokeId(null);
      await onChange();
    }
  }

  return <section aria-labelledby="eagle-bot-mandates" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="eagle-bot-mandates" className="font-bold text-ink">运行委托</h3>
      <Button type="button" variant="quiet" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起设置" : "新建委托"}</Button>
    </div>
    {expanded && <Card className="min-w-0 p-4">
      <form className="space-y-3" onSubmit={(event) => void grant(event)}>
        <p className="text-body text-ink2">后台执行器仅在当前获权工作区内读取经营事实并生成晨报。按北京时间填写到期时间和每日触发时间。</p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="text-body font-medium text-ink">到期时间
            <input className="wl-input mt-1 block w-full" type="datetime-local" required value={expires} onChange={(event) => setExpires(event.target.value)} />
          </label>
          <label className="text-body font-medium text-ink">每日运行时间（选填）
            <input className="wl-input mt-1 block w-full" type="time" value={dailyAt} onChange={(event) => setDailyAt(event.target.value)} />
          </label>
          <label className="text-body font-medium text-ink">最多运行次数
            <input className="wl-input mt-1 block w-full" type="number" min={1} max={90} required value={runs} onChange={(event) => setRuns(event.target.value)} />
          </label>
          <label className="text-body font-medium text-ink">单次时限（秒）
            <input className="wl-input mt-1 block w-full" type="number" min={5} max={120} required value={runtime} onChange={(event) => setRuntime(event.target.value)} />
          </label>
        </div>
        <Button type="submit" variant="primary" busy={write.busy} disabled={write.busy || !expires}>确认委托</Button>
      </form>
    </Card>}
    {mandates.map((mandate) => <Card key={mandate.id} className="min-w-0 space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={mandateStatus(mandate) === "生效中" ? "success" : "neutral"}>{mandateStatus(mandate)}</Badge>
        <span className="text-body text-ink3">到期 {displayTime(mandate.expiresAt)}</span>
      </div>
      <p className="text-body text-ink2">委托人 {mandate.createdBy} · 已用 {mandate.usedRuns}/{mandate.maxRuns} 次 · 单次 {mandate.maxRuntimeSeconds} 秒</p>
      <p className="text-body text-ink3">{mandate.dailyAt ? `每天 ${mandate.dailyAt} · 下次 ${displayTime(mandate.nextDueAt)}` : "仅手动运行"}</p>
      {!mandate.revokedAt && <Button type="button" variant="quiet" aria-expanded={revokeId === mandate.id} onClick={() => setRevokeId(revokeId === mandate.id ? null : mandate.id)}>撤回委托</Button>}
      {revokeId === mandate.id && <div className="space-y-2">
        <p className="text-body text-ink2">撤回后，本委托不能受理新的运行。</p>
        <Button type="button" variant="danger" disabled={write.busy} busy={write.busy} onClick={() => void revoke(mandate.id)}>确认撤回</Button>
      </div>}
    </Card>)}
    {!mandates.length && <p className="text-body text-ink3">当前没有运行委托。</p>}
    <WriteFeedback message={write.message} receipt={write.receipt} />
  </section>;
}

export function BotPanel({ scope, canManage, canConfigure, onViewBrief }: {
  scope: string;
  canManage: boolean;
  canConfigure: boolean;
  onViewBrief: (artifactId: string) => void;
}) {
  const load = useCallback(() => trpc.business.botStatus.query(), []);
  const state = useBusinessResource(load);
  const { value: snapshot, reload } = state;
  const [mandateId, setMandateId] = useState("");
  const [date, setDate] = useState(businessDay);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const write = useBusinessWrite(scope);
  const selected = snapshot?.tasks.find((task) => task.id === selectedId);
  const active = snapshot?.mandates.filter((mandate) => mandateStatus(mandate) === "生效中") ?? [];
  const currentMandate = active.some((mandate) => mandate.id === mandateId) ? mandateId : active[0]?.id;
  const queue = snapshot?.tasks.filter((task) => task.status === "queued" || task.status === "running") ?? [];
  const history = snapshot?.tasks.filter((task) => task.status !== "queued" && task.status !== "running") ?? [];

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), queue.length ? 5000 : 20_000);
    return () => window.clearInterval(timer);
  }, [queue.length, reload]);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentMandate || !date) return;
    const payload = { mandateId: currentMandate, businessDate: date };
    const task = await write.submit("提交经营晨报任务", payload, (idempotencyKey) =>
      trpc.business.submitTask.mutate({ ...payload, idempotencyKey }));
    if (task) {
      setSelectedId(task.id);
      await reload();
    }
  }

  return <div className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-xl font-bold text-ink">自动运行</h2>
        <p className="mt-1 text-body text-ink3">查看经营晨报的运行状态与回执。</p>
      </div>
      <Button type="button" variant="quiet" disabled={state.loading} onClick={() => void reload()}>{state.loading ? "刷新中…" : "刷新运行状态"}</Button>
    </div>
    {state.message && <AsyncState status="error" title="运行状态暂不可读" description={state.message} onRetry={reload} />}
    {!snapshot && state.loading && <AsyncState status="loading" title="正在读取运行状态" />}
    {snapshot && <>
      <p role="status" className="rounded-lg border border-line bg-panel p-3 text-body text-ink2">
        <strong className="text-ink">{snapshot.worker.state === "online" ? "后台执行器在线" : snapshot.worker.state === "stale" ? "后台连接待核实" : "后台执行器尚未上报"}</strong>
        {snapshot.worker.lastSeenAt && <> · 最后心跳 {displayTime(snapshot.worker.lastSeenAt)}</>}
        {snapshot.worker.state !== "online" && <> · 新任务将保留在队列等待执行。</>}
      </p>
      <Card className="p-4">
        <h3 className="font-bold text-ink">运行经营晨报</h3>
        {canManage && currentMandate ? <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(event) => void run(event)}>
          <label className="min-w-0 text-body font-medium text-ink">使用委托
            <select className="wl-input mt-1 block w-full" value={currentMandate} onChange={(event) => setMandateId(event.target.value)}>
              {active.map((mandate) => <option key={mandate.id} value={mandate.id}>{displayTime(mandate.createdAt)} · 余 {mandate.maxRuns - mandate.usedRuns} 次</option>)}
            </select>
          </label>
          <label className="min-w-0 text-body font-medium text-ink">经营日期
            <input className="wl-input mt-1 block w-full" type="date" max={businessDay()} required value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <Button type="submit" variant="primary" busy={write.busy} disabled={write.busy || !date}>手动运行</Button>
        </form> : <p className="mt-2 text-body text-ink3">{canManage ? "当前没有可用的运行委托。" : "可查看运行记录。手动运行由获权成员提交。"}</p>}
        <div className="mt-2"><WriteFeedback message={write.message} receipt={write.receipt} /></div>
      </Card>
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <section aria-label="自动任务队列与历史" className="min-w-0 space-y-3">
          {[{ label: "运行队列", rows: queue }, { label: "运行历史", rows: history }].map(({ label, rows }) =>
            <div key={label} className="space-y-2">
              <h3 className="font-bold text-ink">{label}</h3>
              {!rows.length && <p className="text-body text-ink3">暂无运行记录。</p>}
              {rows.map((task) => <button
                key={task.id}
                type="button"
                aria-pressed={task.id === selectedId}
                className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-card p-3 text-left hover:border-gline focus-visible:outline-2 focus-visible:outline-offset-2 aria-pressed:border-gline"
                onClick={() => setSelectedId(task.id)}
              >
                <span className="font-semibold text-ink">{task.businessDate} 经营晨报</span>
                <span className="text-body text-ink3">{TASK_STATUS[task.status]}</span>
              </button>)}
            </div>
          )}
        </section>
        {selected && <TaskDetail key={selected.id + selected.status} task={selected} scope={scope} canManage={canManage} onViewBrief={onViewBrief} reload={reload} />}
      </div>
      {canConfigure && <MandateSettings mandates={snapshot.mandates} scope={scope} onChange={reload} />}
      {!canConfigure && snapshot.mandates.length > 0 && <section className="space-y-2" aria-label="运行委托状态">
        <h3 className="font-bold text-ink">委托状态</h3>
        <ul className="space-y-2">{snapshot.mandates.map((mandate) =>
          <li key={mandate.id} className="rounded-lg border border-line bg-card p-3 text-body text-ink2">
            {mandate.createdBy} · {mandateStatus(mandate)} · 已用 {mandate.usedRuns}/{mandate.maxRuns} 次 · 到期 {displayTime(mandate.expiresAt)}
          </li>)}</ul>
      </section>}
    </>}
  </div>;
}
