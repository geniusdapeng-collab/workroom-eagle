import { useState, type FormEvent } from "react";
import { AsyncState, Button, Card } from "@workloom/ui";
import { operationFailure } from "../../../lib/ui-state";
import { trpc } from "../../../lib/trpc";
import { FactDetail } from "./FactDetail";
import { businessDay } from "./format";
import { WorkCard, WriteFeedback } from "./WorkCards";
import type { OperatingAction, OperatingFact, Preview, PreviewInput } from "./types";
import { useBusinessWrite } from "./useWork";

function Capture({ scope, canImport, reload }: { scope: string; canImport: boolean; reload: () => Promise<void> }) {
  const [kind, setKind] = useState<"interaction" | "lead">("interaction");
  const [channel, setChannel] = useState("");
  const [qualified, setQualified] = useState(false);
  const [accountRef, setAccount] = useState("");
  const [dealRef, setDeal] = useState("");
  const [occurredOn, setOccurredOn] = useState(businessDay);
  const [note, setNote] = useState("");
  const [csv, setCsv] = useState("");
  const [batch, setBatch] = useState(false);
  const [preview, setPreview] = useState<{ result: Preview; input: PreviewInput } | null>(null);
  const [previewMessage, setPreviewMessage] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const write = useBusinessWrite(scope);

  async function makePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (previewing) return;
    const common = { occurredOn, accountRef: accountRef.trim(), dealRef: dealRef.trim(), sourceKind: "manual" as const };
    const input: PreviewInput = batch ? { csv: csv.trim() }
      : { rows: [kind === "lead"
        ? { ...common, kind: "lead", channel: channel.trim() || "未知来源", qualified, ...(note.trim() ? { note: note.trim() } : {}) }
        : { ...common, kind: "interaction", note: note.trim() }] };
    setPreviewing(true);
    setPreviewMessage("");
    try {
      const result = await trpc.business.previewFacts.mutate(input);
      setPreview({ result, input });
    } catch (error) {
      setPreviewMessage(operationFailure(error, "预览经营事实"));
    } finally {
      setPreviewing(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    const payload = { ...preview.input, previewDigest: preview.result.previewDigest };
    const result = await write.submit("保存经营事实", payload, (idempotencyKey) =>
      trpc.business.confirmFacts.mutate({ ...payload, idempotencyKey }));
    if (result) {
      setPreview(null);
      setNote("");
      setCsv("");
      await reload();
    }
  }

  const available = batch ? csv.trim() : accountRef.trim() && dealRef.trim() && occurredOn
    && (kind === "lead" || note.trim());
  return <Card className="min-w-0 space-y-3 p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-bold text-ink">{batch ? "批量导入经营事实" : "记一条跟进"}</h3>
      {canImport && !preview && <Button type="button" variant="quiet" aria-pressed={batch} disabled={previewing} onClick={() => {
        setBatch(!batch);
        setPreviewMessage("");
      }}>{batch ? "改为单条记录" : "批量导入"}</Button>}
    </div>
    <WriteFeedback message={write.message} receipt={write.receipt} />
    {!preview && <form className="space-y-3" onSubmit={(event) => void makePreview(event)}>
      {batch ? <label className="block text-body font-medium text-ink">
        粘贴 CSV
        <textarea aria-describedby="eagle-csv-hint" className="wl-input mt-1 block w-full" required maxLength={128000} rows={7} value={csv} onChange={(event) => setCsv(event.target.value)} />
        <span id="eagle-csv-hint" className="mt-1 block text-ink3">保留表头，预览后核对来源、业务日期和使用范围。</span>
      </label> : <>
        <label className="block text-body font-medium text-ink">记录类型
          <select className="wl-input mt-1 block w-full" value={kind} onChange={(event) => setKind(event.target.value === "lead" ? "lead" : "interaction")}>
            <option value="interaction">客户跟进</option>
            <option value="lead">新线索</option>
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-body font-medium text-ink">客户
            <input className="wl-input mt-1 block w-full" required maxLength={120} value={accountRef} onChange={(event) => setAccount(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._:\-]{0,119}" placeholder="填写业务系统的客户编号" />
          </label>
          <label className="block text-body font-medium text-ink">商机
            <input className="wl-input mt-1 block w-full" required maxLength={120} value={dealRef} onChange={(event) => setDeal(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._:\-]{0,119}" placeholder="填写业务系统的商机编号" />
          </label>
          <label className="block text-body font-medium text-ink">沟通日期
            <input className="wl-input mt-1 block w-full" required type="date" max={businessDay()} value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} />
          </label>
        </div>
        {kind === "lead" && <div className="space-y-2">
          <label className="block text-body font-medium text-ink">渠道
            <input className="wl-input mt-1 block w-full" maxLength={80} value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="如伙伴推荐，未知可留待核实" />
          </label>
          <label className="flex items-center gap-2 text-body text-ink2">
            <input type="checkbox" checked={qualified} onChange={(event) => setQualified(event.target.checked)} /> 已确认有效
          </label>
        </div>}
        <label className="block text-body font-medium text-ink">沟通原话或纪要
          <textarea className="wl-input mt-1 block w-full" required={kind === "interaction"} maxLength={600} rows={4} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记下客户实际说了什么、约定了什么" />
        </label>
      </>}
      <Button type="submit" variant="primary" busy={previewing} disabled={previewing || !available}>预览记录</Button>
    </form>}
    {previewMessage && <p className="break-words text-body text-warn" role="alert">{previewMessage}</p>}
    {preview && <section className="space-y-3" aria-label="待确认经营事实">
      <p className="text-ink2">待确认 {preview.result.rows.length} 条，核对无误后入账。</p>
      <ul className="max-h-80 space-y-2 overflow-y-auto" tabIndex={0} aria-label="待确认记录">
        {preview.result.rows.map((row, index) => <li key={index} className="rounded-lg border border-line bg-panel p-2 text-body text-ink2">
          <FactDetail fact={row} />
        </li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="quiet" disabled={write.busy} onClick={() => setPreview(null)}>返回修改</Button>
        <Button type="button" variant="primary" busy={write.busy} disabled={write.busy} onClick={() => void confirm()}>确认并保存</Button>
      </div>
    </section>}
  </Card>;
}

export function SellerPanel({ scope, viewerMemberId, canCapture, canImport, actions, facts, loading, message, reload }: {
  scope: string;
  viewerMemberId: string;
  canCapture: boolean;
  canImport: boolean;
  actions: OperatingAction[];
  facts: OperatingFact[];
  loading: boolean;
  message: string;
  reload: () => Promise<void>;
}) {
  const [showCapture, setShowCapture] = useState(false);
  const [outcomeReceipt, setOutcomeReceipt] = useState("");
  const open = actions
    .filter((action) => action.status === "open" || action.status === "changes_requested")
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  const history = actions.filter((action) => !open.includes(action));

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold text-ink">我的今日</h2>
        <p className="mt-1 text-body text-ink3">{businessDay()} · 按承诺期限优先处理</p>
      </div>
      {canCapture && <Button type="button" variant="primary" aria-expanded={showCapture} onClick={() => setShowCapture(!showCapture)}>
        {showCapture ? "收起记录" : "记一条"}
      </Button>}
    </div>
    <WriteFeedback message="" receipt={outcomeReceipt} />
    {showCapture && <Capture scope={scope} canImport={canImport} reload={reload} />}
    {message ? <AsyncState status="error" title="今日记录暂不可读" description={message} onRetry={reload} />
      : loading && !actions.length && !facts.length ? <AsyncState status="loading" title="正在读取今日工作" />
      : <>
        <section aria-labelledby="eagle-priority-list" className="space-y-3">
          <h3 id="eagle-priority-list" className="font-bold text-ink">先做这三件事</h3>
          {open.length ? <div className="grid min-w-0 gap-3 xl:grid-cols-3">
            {open.slice(0, 3).map((action) =>
              <WorkCard key={action.id} action={action} scope={scope} viewerMemberId={viewerMemberId} canReport={canCapture} canVerify={false} onReceipt={setOutcomeReceipt} reload={reload} />)}
          </div> : <AsyncState status="empty" title="还没有待处理的行动" description="新的内部行动会在这里出现。" />}
          {open.length > 3 && <details className="space-y-2">
            <summary className="cursor-pointer font-medium text-ink">其余待办 · {open.length - 3} 项</summary>
            {open.slice(3).map((action) =>
              <WorkCard key={action.id} action={action} scope={scope} viewerMemberId={viewerMemberId} canReport={canCapture} canVerify={false} onReceipt={setOutcomeReceipt} reload={reload} />)}
          </details>}
        </section>
        {history.length > 0 && <details className="space-y-2">
          <summary className="cursor-pointer font-medium text-ink">已回填的行动 · {history.length} 项</summary>
          {history.map((action) =>
            <WorkCard key={action.id} action={action} scope={scope} viewerMemberId={viewerMemberId} canReport={false} canVerify={false} reload={reload} />)}
        </details>}
        {facts.length > 0 && <section aria-labelledby="eagle-recent-facts" className="space-y-2">
          <h3 id="eagle-recent-facts" className="font-bold text-ink">最近记录</h3>
          <ul className="divide-y divide-line rounded-lg border border-line bg-card">
            {facts.slice(0, 6).map((fact) => <li key={fact.id} className="grid min-w-0 gap-1 p-3 text-body">
              <FactDetail fact={fact} />
            </li>)}
          </ul>
        </section>}
      </>}
  </div>;
}
