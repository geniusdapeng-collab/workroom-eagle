import { useCallback, useState, type FormEvent } from "react";
import { AsyncState, Badge, Button, Card, clientChineseText, clientIdentifierText } from "@workloom/ui";
import { trpc } from "../../../lib/trpc";
import { FactDetail } from "./FactDetail";
import { displayTime } from "./format";
import { useBusinessResource, useBusinessWrite } from "./useWork";

export type OperatingAction = Awaited<ReturnType<typeof trpc.business.listActions.query>>[number];
export type OperatingFact = Awaited<ReturnType<typeof trpc.business.listFacts.query>>[number];

interface Feedback {
  message: string;
  receipt: string;
}

export function WriteFeedback({ message, receipt }: Feedback) {
  return <>
    {message && <p className="break-words text-body text-warn" role="alert">{message}</p>}
    {receipt && <p className="break-all text-body text-go" role="status">操作已入账，回执 {clientIdentifierText(receipt)}</p>}
  </>;
}

export function Evidence({ ids }: { ids: readonly string[] }) {
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const load = useCallback(() => {
    const batch = ids.slice(page * pageSize, (page + 1) * pageSize);
    return batch.length ? trpc.business.getEvidence.query({ factIds: batch }) : Promise.resolve([]);
  }, [ids, page]);
  const { value, message, loading, reload } = useBusinessResource(load);
  if (loading) return <p className="text-body text-ink3" role="status">正在读取依据</p>;
  if (message) return <AsyncState status="error" title="依据暂不可读" description={message} onRetry={reload} />;
  if (!value?.length) return <p className="text-body text-ink3">当前权限范围内没有可显示的依据。</p>;
  return <div className="space-y-2">
    {ids.length > pageSize && <div className="flex flex-wrap items-center gap-2 text-body text-ink2">
      <Button type="button" variant="quiet" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
      <span>第 {page + 1} 页，共 {Math.ceil(ids.length / pageSize)} 页</span>
      <Button type="button" variant="quiet" disabled={(page + 1) * pageSize >= ids.length} onClick={() => setPage(page + 1)}>下一页</Button>
    </div>}
    <ul className="space-y-2">
    {value.map((fact) => <li key={fact.id} className="min-w-0 rounded-lg border border-line bg-panel p-3">
      <FactDetail fact={fact} />
    </li>)}
    </ul>
  </div>;
}

const ACTION_STATUS: Record<OperatingAction["status"], string> = {
  open: "待处理",
  reported: "已回填，待核实",
  verified: "结果已核实",
  changes_requested: "需补充证据",
};

function OutcomeEvidence({ actionId, selected, onSelect }: {
  actionId: string;
  selected: readonly string[];
  onSelect: (id: string, checked: boolean) => void;
}) {
  const load = useCallback(() => trpc.business.outcomeEvidence.query({ actionId }), [actionId]);
  const state = useBusinessResource(load);
  return <fieldset className="min-w-0 space-y-2">
    <legend className="text-body font-medium text-ink">选择已保存的事实作依据</legend>
    {state.loading ? <p className="text-body text-ink3" role="status">正在读取这项行动可用的证据</p>
      : state.message ? <AsyncState status="error" title="依据暂不可读" description={state.message} onRetry={state.reload} />
      : !state.value?.length ? <p className="text-body text-ink3">请先为这项行动关联的客户和商机记录新的跟进事实。</p>
      : state.value.map((fact) => <label key={fact.id} className="flex items-start gap-2 break-words text-body text-ink2">
        <input type="checkbox" checked={selected.includes(fact.id)} onChange={(event) => onSelect(fact.id, event.target.checked)} />
        <span>{fact.accountRef} · {fact.dealRef} · {displayTime(fact.occurredOn)}{fact.note && <> · {fact.note}</>}</span>
      </label>)}
  </fieldset>;
}

export function WorkCard({ action, scope, viewerMemberId, canReport, canVerify, ownerName, onReceipt, reload }: {
  action: OperatingAction;
  scope: string;
  viewerMemberId: string;
  canReport: boolean;
  canVerify: boolean;
  ownerName?: string;
  onReceipt?: (receipt: string) => void;
  reload: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceFactIds, setEvidenceFactIds] = useState<string[]>([]);
  const write = useBusinessWrite(scope);
  const reportAllowed = canReport && (action.status === "open" || action.status === "changes_requested");
  const verifyAllowed = canVerify && action.status === "reported" && action.outcome !== null
    && action.outcome.reporterMemberId !== viewerMemberId;

  async function report(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = { actionId: action.id, description: description.trim(), evidenceFactIds };
    if (!payload.description || evidenceFactIds.length === 0) return;
    const result = await write.submit("回填行动结果", payload, (idempotencyKey) =>
      trpc.business.recordActionOutcome.mutate({ ...payload, idempotencyKey }));
    if (result) {
      setExpanded(false);
      setDescription("");
      setEvidenceFactIds([]);
      if (result.receipt.synced) onReceipt?.(result.receipt.eventId);
      await reload();
    }
  }

  async function verify(accepted: boolean) {
    if (!action.outcome || !reason.trim()) return;
    const payload = { actionId: action.id, outcomeId: action.outcome.id, accepted, reason: reason.trim() };
    const result = await write.submit("核实行动结果", payload, (idempotencyKey) =>
      trpc.business.verifyActionOutcome.mutate({ ...payload, idempotencyKey }));
    if (result) {
      setExpanded(false);
      setReason("");
      await reload();
    }
  }

  return <Card className="min-w-0 p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Badge tone={action.status === "verified" ? "success" : "neutral"}>{clientChineseText(ACTION_STATUS[action.status], "状态待核实")}</Badge>
      <span className="text-body text-ink3">截止 {displayTime(action.dueAt)}</span>
    </div>
    <h3 className="mt-2 break-words text-body font-semibold text-ink">{action.title}</h3>
    <p className="mt-1 whitespace-pre-wrap break-words text-body text-ink2">{action.description}</p>
    {action.acceptanceCondition && <p className="mt-1 whitespace-pre-wrap break-words text-body text-ink2">验收条件 · {action.acceptanceCondition}</p>}
    {ownerName && <p className="mt-1 text-body text-ink3">负责人 · {ownerName}</p>}
    {action.outcome && <div className="mt-3 space-y-2 rounded-lg border border-line p-3 text-body">
      <p className="text-ink3">回填结果 · {displayTime(action.outcome.reportedAt)}</p>
      <p className="whitespace-pre-wrap break-words text-ink">{action.outcome.description}</p>
      <Button type="button" variant="quiet" onClick={() => setEvidence(!evidence)} aria-expanded={evidence}>
        {evidence ? "收起回填依据" : "查看回填依据"}
      </Button>
      {evidence && <Evidence ids={action.outcome.evidenceFactIds} />}
    </div>}
    {action.verification && <p className="mt-2 whitespace-pre-wrap break-words text-body text-ink2">复核意见 · {action.verification.reason}</p>}
    {(reportAllowed || verifyAllowed) && <Button className="mt-3" type="button" variant="quiet" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? "收起操作" : reportAllowed ? "回填结果" : "复核结果"}
    </Button>}
    {expanded && reportAllowed && <form className="mt-3 space-y-3" onSubmit={(event) => void report(event)}>
      <label className="block text-body font-medium text-ink">
        实际发生了什么
        <textarea className="wl-input mt-1 block w-full" rows={3} required maxLength={600} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <OutcomeEvidence actionId={action.id} selected={evidenceFactIds} onSelect={(id, checked) =>
        setEvidenceFactIds((selected) => checked ? [...selected, id] : selected.filter((selectedId) => selectedId !== id))} />
      <Button type="submit" variant="primary" busy={write.busy} disabled={write.busy || !description.trim() || evidenceFactIds.length === 0}>提交结果</Button>
    </form>}
    {expanded && verifyAllowed && <div className="mt-3 space-y-3">
      <label className="block text-body font-medium text-ink">
        复核意见
        <textarea className="wl-input mt-1 block w-full" rows={2} maxLength={600} required value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" busy={write.busy} disabled={write.busy || !reason.trim()} onClick={() => void verify(true)}>确认已核实</Button>
        <Button type="button" variant="quiet" disabled={write.busy || !reason.trim()} onClick={() => void verify(false)}>要求补证</Button>
      </div>
    </div>}
    <div className="mt-2"><WriteFeedback message={write.message} receipt={write.receipt} /></div>
  </Card>;
}
