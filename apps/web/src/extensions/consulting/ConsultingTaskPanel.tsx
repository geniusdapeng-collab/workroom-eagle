import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, clientChineseText, clientIdentifierText } from "@workloom/ui";
import { trpc } from "../../lib/trpc";
import { clientNaturalText } from "../../lib/clientText";
import { operationFailure } from "../../lib/ui-state";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import {
  consultingTaskStatusText, hasTaskReceipt, ReportIntegrityError, sourceHttpUrl, taskNaturalText, verifyTaskReport,
  type ConsultingTaskAction, type ConsultingTaskView, type TaskReport,
} from "./task-client";

const ACTIONS: Array<{ id: ConsultingTaskAction; label: string }> = [
  { id: "handoff", label: "转人工" }, { id: "resume", label: "恢复执行" }, { id: "cancel", label: "停止任务" },
];
const ACTION_DONE: Record<ConsultingTaskAction, string> = {
  handoff: "已记录转人工，后续自动步骤暂停", resume: "恢复请求已入账，等待调度执行", cancel: "已停止任务的后续执行",
};
function timeText(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间未提供";
}

/** Industry task facts and controls are all obtained from the authenticated server. */
export function ConsultingTaskPanel({ threadId, canAct, onChanged }: {
  threadId: string; canAct: boolean; onChanged: () => Promise<void>;
}) {
  const { identityKey } = useNavigationAccess();
  const [view, setView] = useState<ConsultingTaskView | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ConsultingTaskAction | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [report, setReport] = useState<TaskReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const alive = useRef(true);
  const readSequence = useRef(0);
  const busyRef = useRef(false);
  const reportBusyRef = useRef(false);
  const autoOpenedReport = useRef<string | null>(null);
  const latestView = useRef(view);
  latestView.current = view;
  const actionKeys = useRef(new Map<ConsultingTaskAction, string>());

  const load = useCallback(async () => {
    if (!alive.current || busyRef.current) return;
    const sequence = ++readSequence.current;
    try {
      const next = await trpc.consulting.taskView.query({ threadId }) as ConsultingTaskView | null;
      if (!alive.current || sequence !== readSequence.current) return;
      if (!next || next.threadId !== threadId) throw new Error("Task detail unavailable");
      setView(next); setReadError(null);
      setReport(current => current && next.runId === current.runId && next.finalArtifact?.sha256 === current.sha256
        && next.finalArtifact.eventId === current.receipt.eventId && next.finalArtifact.hash === current.receipt.hash ? current : null);
    } catch (error) {
      if (alive.current && sequence === readSequence.current) setReadError(operationFailure(error, "任务详情读取"));
    } finally { if (alive.current && sequence === readSequence.current) setLoading(false); }
  }, [threadId]);
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { alive.current = false; readSequence.current++; clearInterval(timer); };
  }, [load]);

  const actOnTask = useCallback(async (action: ConsultingTaskAction) => {
    if (!view || !canAct || busyRef.current || readError || view.availableActions[action]?.enabled !== true) return;
    readSequence.current++;
    busyRef.current = true; setBusy(action); setActionNote(null);
    try {
      const storageKey = `workloom.consulting.action.v1:${encodeURIComponent(identityKey)}:${encodeURIComponent(threadId)}:${action}`;
      let idempotencyKey = actionKeys.current.get(action) ?? localStorage.getItem(storageKey);
      if (idempotencyKey && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(idempotencyKey)) throw new Error("Action recovery metadata unavailable");
      idempotencyKey ??= globalThis.crypto.randomUUID();
      localStorage.setItem(storageKey, idempotencyKey);
      actionKeys.current.set(action, idempotencyKey);
      const next = await trpc.consulting.taskAction.mutate({ threadId, action, idempotencyKey }) as ConsultingTaskView;
      if (!alive.current) return;
      if (next.threadId !== threadId) throw new Error("Task action scope mismatch");
      readSequence.current++;
      if (hasTaskReceipt(next.actionReceipt)) {
        setView(next);
        localStorage.removeItem(storageKey);
        actionKeys.current.delete(action);
        setActionNote(`${ACTION_DONE[action]}，回执${clientIdentifierText(next.actionReceipt.eventId)}已入账。`);
      } else {
        setActionNote("操作已返回，但服务端尚未提供可核验回执；正在重新读取任务状态，尚不宣称成功。");
      }
      await onChanged();
    } catch (error) {
      if (alive.current) {
        setActionNote(`${operationFailure(error, "任务操作")} 操作结果尚未确认，将先读取原任务，不会自动重发。`);
      }
    } finally { busyRef.current = false; if (alive.current) { setBusy(null); await load(); } }
  }, [view, canAct, readError, threadId, identityKey, load, onChanged]);

  const openReport = useCallback(async () => {
    if (!view?.finalArtifact || reportBusyRef.current || readError) return;
    reportBusyRef.current = true; setReportBusy(true); setReportError(null);
    try {
      const raw = await trpc.consulting.taskReport.query({ threadId }) as TaskReport;
      const verified = await verifyTaskReport(view, raw);
      const current = latestView.current;
      if (alive.current && current?.runId === view.runId && current.finalArtifact?.sha256 === verified.sha256
        && current.finalArtifact.eventId === verified.receipt.eventId && current.finalArtifact.hash === verified.receipt.hash) setReport(verified);
    } catch (error) {
      if (alive.current) { setReport(null); setReportError(error instanceof ReportIntegrityError ? error.message : operationFailure(error, "报告打开")); }
    } finally { reportBusyRef.current = false; if (alive.current) setReportBusy(false); }
  }, [view, threadId, readError]);

  useEffect(() => {
    if (!view?.finalArtifact || readError || window.location.hash !== "#report") return;
    const key = `${view.runId}:${view.finalArtifact.sha256}:${view.finalArtifact.eventId}:${view.finalArtifact.hash}`;
    if (autoOpenedReport.current === key) return;
    autoOpenedReport.current = key;
    void openReport();
  }, [view, readError, openReport]);

  if (loading && !view) return <section aria-busy="true" className="mb-3 rounded-lg border border-line bg-card p-4 text-body text-ink2">正在读取报告任务与恢复动作…</section>;
  return (
    <section id="report" aria-label="咨询报告任务" className="mb-3 min-w-0 space-y-3 rounded-lg border border-gline bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-h2 font-bold text-gold">公开资料报告任务</h3>
        {view && <span className="rounded border border-line px-2 py-0.5 text-body text-ink2">{clientChineseText(consultingTaskStatusText(view.status), "任务状态待确认")}</span>}
      </div>
      {readError && <div role="alert" className="rounded border border-alert/50 bg-alert/8 p-2 text-body text-alert">
        {readError} {view ? "当前保留最后一次读取的结果；恢复动作暂时锁定。" : "暂未取得任务详情。"}
        <button type="button" onClick={() => void load()} className="ml-2 underline">重试读取任务</button>
      </div>}
      {view && <>
        <p className="text-body text-ink2">执行来源：公开资料报告流程 · 当前进度 {view.stepsDone}/{view.stepsTotal}</p>
        {view.error && <div role="alert" className="rounded border border-alert/50 bg-alert/8 p-2 text-body text-alert">{clientChineseText(clientNaturalText(view.error.message, "任务执行未完成，服务端尚未提供具体失败原因。"), "任务执行未完成，服务端尚未提供具体失败原因。")}</div>}
        <p className="text-body text-warn">内部报告草稿，待人工审阅。公开资料与模型推断不等于独立审计结论。</p>
        <p className="text-body text-ink3">模型由供应商按实际用量计费，平台积分不代表模型费用；用量见执行回执。</p>
        {canAct && <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {ACTIONS.map(action => <button key={action.id} type="button"
              disabled={busy !== null || Boolean(readError) || view.availableActions[action.id]?.enabled !== true}
              aria-busy={busy === action.id || undefined}
              title={clientChineseText(clientNaturalText(view.availableActions[action.id]?.reason ?? action.label, action.label), action.label)}
              onClick={() => void actOnTask(action.id)}
              className="rounded border border-gline bg-gold/8 px-3 py-1.5 text-body font-bold text-gold hover:bg-gold/15 disabled:cursor-not-allowed disabled:opacity-50">
              {busy === action.id ? "正在提交…" : action.label}
            </button>)}
          </div>
          {ACTIONS.filter(action => view.availableActions[action.id]?.enabled !== true).map(action => <p key={action.id} className="text-body text-ink3">
            {action.label}：{clientChineseText(clientNaturalText(view.availableActions[action.id]?.reason, "当前状态不支持此操作"), "当前状态不支持此操作")}
          </p>)}
          <p className="text-body text-ink3">停止任务只取消本任务后续执行，保留已生成草稿和历史记录；不会撤回已发生的外部业务。</p>
        </div>}
        {actionNote && <p role="status" className="break-words text-body text-holo">{actionNote}</p>}
        <div className="border-t border-line pt-3">
          <h4 className="text-body font-bold text-holo">报告与来源</h4>
          {view.finalArtifact ? <div className="mt-2 space-y-2">
            <button type="button" disabled={reportBusy || Boolean(readError)} onClick={() => void openReport()}
              className="rounded border border-gline px-3 py-1.5 text-body font-bold text-gold hover:bg-gold/10 disabled:opacity-50">
              {reportBusy ? "正在校验报告…" : "打开报告"}
            </button>
            <div className="text-body text-ink3">已记录报告回执 {clientIdentifierText(view.finalArtifact.eventId)} · 内容校验后才可打开和下载</div>
          </div> : <p className="mt-1 text-body text-ink3">尚未生成最终报告，已完成的步骤和原有记录仍会保留。</p>}
          {reportError && <p role="alert" className="mt-2 text-body text-alert">{reportError}</p>}
          {report && <article aria-label="内部报告草稿正文" className="mt-3 min-w-0 rounded-lg border border-line bg-bg950 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-body font-bold text-warn">内容指纹已核对 · 待人工审阅</span>
              <a href={`data:text/markdown;charset=utf-8,${encodeURIComponent(report.content)}`} download={`报告草稿-${threadId.replace(/[^A-Za-z0-9_-]/g, "_")}.md`} className="text-body text-holo underline">下载报告草稿</a>
            </div>
            <div className="space-y-3 break-words text-body leading-7 text-ink2">
              {report.content.split(/\n\s*\n/).map((block, index) => {
                const heading = /^(#{1,6})\s+([^\n]+)$/.exec(block);
                return heading ? <h4 key={index} className="text-h2 font-bold text-ink">{heading[2]}</h4>
                  : <p key={index} className="whitespace-pre-wrap">{block}</p>;
              })}
            </div>
          </article>}
          {view.sources.length ? <ol className="mt-3 space-y-2">
            {view.sources.map((source, index) => {
              const url = sourceHttpUrl(source.url);
              const title = taskNaturalText(source.title, `公开来源 ${index + 1}`);
              return <li key={source.id} className="min-w-0 rounded border border-line p-2 text-body text-ink2">
                {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="break-words text-holo underline">{index + 1}. {title}</a> : <span>{index + 1}. {title}（来源地址不可打开）</span>}
                <div className="mt-1 text-ink3">发布日期 {source.publishedAt ?? "未提供"} · 采集时间 {timeText(source.retrievedAt)}</div>
                <details className="mt-1 text-ink3"><summary className="cursor-pointer">查看来源核验记录</summary>
                  <div className="mt-1 break-all">全文指纹：{source.sha256}</div>
                  <div className="break-all">摘录指纹：{source.excerptSha256}</div>
                  <div>本次读取 {source.excerptBytes} 字节 / 原文 {source.fullBytes} 字节</div>
                </details>
              </li>;
            })}
          </ol> : <p className="mt-2 text-body text-ink3"><Icon name="warning" size={13} className="mr-1 inline" />尚无已冻结的公开来源；不会用无来源内容冒充报告。</p>}
        </div>
      </>}
    </section>
  );
}
