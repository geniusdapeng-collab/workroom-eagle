import { useCallback, useState, type FormEvent } from "react";
import { AsyncState, Badge, Button, Card } from "@workloom/ui";
import { trpc } from "../../../lib/trpc";
import { businessDay, dateAndTimeIso, displayMoney, displayTime } from "./format";
import { Evidence, WorkCard, WriteFeedback, type OperatingAction } from "./WorkCards";
import { useBusinessResource, useBusinessWrite } from "./useWork";

export interface BusinessMember {
  id: string;
  name: string;
}

type Brief = NonNullable<Awaited<ReturnType<typeof trpc.business.getBrief.query>>>;
type Insight = Brief["insights"][number];

function InsightDetail({ brief, insight, members, scope, canAssign, onChange }: {
  brief: Brief;
  insight: Insight;
  members: BusinessMember[];
  scope: string;
  canAssign: boolean;
  onChange: () => Promise<void>;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [ownerMemberId, setOwnerMemberId] = useState("");
  const [due, setDue] = useState("");
  const [acceptanceCondition, setAcceptanceCondition] = useState("");
  const write = useBusinessWrite(scope);

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ownerMemberId || !due) return;
    const payload = {
      artifactId: brief.artifactId, insightId: insight.id, ownerMemberId, dueAt: dateAndTimeIso(due),
      ...(acceptanceCondition.trim() ? { acceptanceCondition: acceptanceCondition.trim() } : {}),
    };
    const result = await write.submit("派发内部行动", payload, (idempotencyKey) =>
      trpc.business.confirmAction.mutate({ ...payload, idempotencyKey }));
    if (result) {
      setAssigning(false);
      await onChange();
    }
  }

  return <section aria-label="发现详情" className="min-w-0 space-y-3 rounded-lg border border-line bg-card p-4 sm:p-5">
    <h3 className="break-words text-lg font-bold text-ink">{insight.title}</h3>
    <p className="whitespace-pre-wrap break-words leading-relaxed text-ink2">{insight.detail}</p>
    <div className="rounded-lg border border-line bg-panel p-3">
      <p className="text-body font-medium text-ink">建议行动</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-body text-ink2">{insight.action}</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="quiet" aria-expanded={showEvidence} onClick={() => setShowEvidence(!showEvidence)}>
        {showEvidence ? "收起依据" : "查看依据"}
      </Button>
      {canAssign && <Button type="button" variant="primary" aria-expanded={assigning} onClick={() => setAssigning(!assigning)}>
        {assigning ? "收起派发" : "派发内部行动"}
      </Button>}
    </div>
    {showEvidence && <div className="space-y-2">
      <h4 className="font-medium text-ink">原始事实</h4>
      <p className="text-body text-ink3">分析日期 {brief.businessDate} · 计算截止 {displayTime(brief.asOf)}</p>
      {insight.evidenceFactIds.length > 0
        ? <Evidence ids={insight.evidenceFactIds} />
        : <p className="text-body text-ink3">此发现还没有可下钻的事实。</p>}
    </div>}
    {assigning && <form className="space-y-3 border-t border-line pt-3" onSubmit={(event) => void assign(event)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-body font-medium text-ink">
          负责人
          <select className="wl-input mt-1 block w-full" required value={ownerMemberId} onChange={(event) => setOwnerMemberId(event.target.value)}>
            <option value="">请选择</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </label>
        <label className="block text-body font-medium text-ink">
          截止时间（北京时间）
          <input className="wl-input mt-1 block w-full" type="datetime-local" required value={due} onChange={(event) => setDue(event.target.value)} />
        </label>
      </div>
      <label className="block text-body font-medium text-ink">
        验收条件（选填）
        <textarea className="wl-input mt-1 block w-full" rows={2} maxLength={600} value={acceptanceCondition} onChange={(event) => setAcceptanceCondition(event.target.value)} />
      </label>
      <Button type="submit" variant="primary" busy={write.busy} disabled={write.busy || !ownerMemberId || !due}>确认派发</Button>
      {!members.length && <p className="text-body text-ink3">当前没有可指派的成员。</p>}
    </form>}
    <WriteFeedback message={write.message} receipt={write.receipt} />
  </section>;
}

function BriefMetrics({ brief }: { brief: Brief }) {
  const { growth, leakage, competition, channels, coverage, channelCohorts } = brief.metrics;
  const hasInvoices = (coverage.kindCounts.invoice ?? 0) > 0;
  const hasOutcomes = (coverage.kindCounts.deal_outcome ?? 0) > 0;
  const comparable = coverage.currentContractCount > 0 && coverage.previousContractCount > 0;
  return <div className="space-y-4">
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Card className="min-w-0 p-3">
        <dt className="text-body text-ink3">本期签约</dt>
        <dd className="mt-1 break-words font-bold tabular-nums text-ink">{displayMoney(coverage.currentContractCount ? growth.currentContractMinor : null)}</dd>
        <dd className="mt-1 text-body text-ink2">{comparable ? `变化 ${displayMoney(growth.contractDeltaMinor)}` : "待核对两期覆盖"}</dd>
      </Card>
      <Card className="min-w-0 p-3">
        <dt className="text-body text-ink3">逾期应收</dt>
        <dd className="mt-1 break-words font-bold tabular-nums text-ink">{displayMoney(hasInvoices ? leakage.overdueBalanceMinor : null)}</dd>
        <dd className="mt-1 text-body text-ink2">{hasInvoices ? `逾期发票 ${leakage.overdueInvoiceCount} 张` : "当前未记录应收"}</dd>
      </Card>
      <Card className="min-w-0 p-3">
        <dt className="text-body text-ink3">有记录的输单</dt>
        <dd className="mt-1 font-bold tabular-nums text-ink">{hasOutcomes ? `${competition.lostDealCount} 单` : "待接入"}</dd>
        {competition.competitors[0] && <dd className="mt-1 break-words text-body text-ink2">提及最多 · {competition.competitors[0].name}</dd>}
      </Card>
      <Card className="min-w-0 p-3">
        <dt className="text-body text-ink3">渠道</dt>
        <dd className="mt-1 font-bold tabular-nums text-ink">{channels.length} 个来源分组</dd>
        <dd className="mt-1 text-body text-ink2">有效线索 {channels.reduce((sum, channel) => sum + channel.qualified, 0)} 条</dd>
      </Card>
    </dl>
    {channels.length > 0 && <details className="rounded-lg border border-line bg-card p-3">
      <summary className="cursor-pointer font-medium text-ink">渠道分组明细</summary>
      {channelCohorts && <p className="mt-2 text-body text-ink3">
        本批 {channelCohorts.current.from} 至 {channelCohorts.current.to}。按每条线索进入后的 {channelCohorts.observationDays} 天观察，未满窗口 {channelCohorts.unmaturedLeadCount} 条。
      </p>}
      <dl className="mt-2 divide-y divide-line">
        {channels.map((channel) => <div key={channel.channel} className="flex flex-wrap justify-between gap-2 py-2 text-body">
          <dt className="break-words font-medium text-ink">{channel.channel}</dt>
          <dd className="text-ink2">
            <p>本批线索 {channel.leads} · 有效 {channel.qualified} · 推进 {channel.advanced} · 成交 {channel.won}</p>
            {channel.previous && <p className="text-ink3">前批推进 {channel.previous.advanced}/{channel.previous.leads} · {channel.comparable ? "样本达到对照要求" : "暂作观察"}</p>}
          </dd>
        </div>)}
      </dl>
    </details>}
    <p className="text-body text-ink3">本期 {coverage.currentStart} 至 {coverage.currentEnd} · 已确认事实 {coverage.factCount} 条</p>
    <p className="text-body text-ink3">{coverage.disclosure}</p>
  </div>;
}

function ReviewPanel({ onViewBrief }: { onViewBrief: (artifactId: string) => void }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [date, setDate] = useState(businessDay);
  const load = useCallback(() => trpc.business.review.query({ businessDate: date, days }), [date, days]);
  const state = useBusinessResource(load);
  return <div className="mt-3 space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-body font-medium text-ink">周期
        <select className="wl-input mt-1 block w-full" value={days} onChange={(event) => setDays(event.target.value === "30" ? 30 : 7)}>
          <option value="7">最近七天</option>
          <option value="30">最近三十天</option>
        </select>
      </label>
      <label className="text-body font-medium text-ink">统计截止日
        <input className="wl-input mt-1 block w-full" type="date" max={businessDay()} value={date} onChange={(event) => {
          if (event.target.value) setDate(event.target.value);
        }} />
      </label>
    </div>
    {state.loading ? <p className="text-body text-ink3" role="status">正在读取经营复盘</p>
      : state.message ? <AsyncState status="error" title="复盘暂不可读" description={state.message} onRetry={state.reload} />
      : state.value && <>
        <p className="text-body text-ink3">该周期有 {state.value.availableDays} / {days} 天的已生成晨报。</p>
        <ul className="divide-y divide-line">{state.value.briefs.map(({ brief, matchingInsightIds }) =>
          <li key={brief.artifactId} className="flex flex-wrap items-center justify-between gap-1 py-2 text-body">
            <span className="text-ink2">{brief.businessDate} · {matchingInsightIds.length} 项发现</span>
            <Button type="button" variant="quiet" onClick={() => onViewBrief(brief.artifactId)}>查看当天晨报</Button>
          </li>
        )}</ul>
      </>}
  </div>;
}

export function BriefPanel({ artifactId, members, scope, viewerMemberId, canAssign, canVerify, actions, actionsLoading, actionsMessage, reloadActions, onViewBrief }: {
  artifactId: string | null;
  members: BusinessMember[];
  scope: string;
  viewerMemberId: string;
  canAssign: boolean;
  canVerify: boolean;
  actions: OperatingAction[];
  actionsLoading: boolean;
  actionsMessage: string;
  reloadActions: () => Promise<void>;
  onViewBrief: (artifactId: string) => void;
}) {
  const load = useCallback(() => trpc.business.getBrief.query(artifactId ? { artifactId } : {}), [artifactId]);
  const { value: brief, message, loading, reload } = useBusinessResource(load);
  const [showReview, setShowReview] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = brief?.insights.find((item) => item.id === selectedId) ?? brief?.insights[0];
  return <div className="space-y-6">
    <section className="space-y-4" aria-labelledby="eagle-business-brief">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="eagle-business-brief" className="text-xl font-bold text-ink">经营晨报</h2>
          {brief && <p className="mt-1 text-body text-ink3">{brief.businessDate} · 截至 {displayTime(brief.asOf)}（北京时间）</p>}
        </div>
        <Button variant="quiet" type="button" disabled={loading} onClick={() => void reload()}>{loading ? "刷新中…" : "刷新晨报"}</Button>
      </div>
      {message && <AsyncState status="error" title="晨报暂不可读" description={message} onRetry={reload} />}
      {!brief && !message && (loading
        ? <AsyncState status="loading" title="正在读取经营晨报" />
        : <AsyncState status="empty" title="还没有生成晨报" description="具备授权时，可从 自动运行运行一次经营晨报。" />)}
      {brief && <>
        <BriefMetrics brief={brief} />
        {selected ? <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <section aria-label="优先事项" className="min-w-0 space-y-2">
            <h3 className="font-bold text-ink">优先事项</h3>
            {brief.insights.map((insight) => <button
              key={insight.id}
              type="button"
              aria-pressed={selected.id === insight.id}
              className="w-full rounded-lg border border-line bg-card p-3 text-left text-ink hover:border-gline focus-visible:outline-2 focus-visible:outline-offset-2 aria-pressed:border-gline aria-pressed:bg-panel"
              onClick={() => setSelectedId(insight.id)}
            >
              <span className="block break-words text-body font-semibold">{insight.title}</span>
              <span className="mt-1 block text-body text-ink3">{insight.evidenceFactIds.length} 条依据</span>
            </button>)}
          </section>
          <InsightDetail
            key={selected.id}
            brief={brief}
            insight={selected}
            members={members}
            scope={scope}
            canAssign={canAssign && !actions.some((action) => action.artifactId === brief.artifactId && action.insightId === selected.id)}
            onChange={reloadActions}
          />
        </div> : <AsyncState status="empty" title="本期没有触发优先事项" description="可复核本期口径和数据范围。" />}
      </>}
    </section>
    <section className="space-y-2 rounded-lg border border-line bg-card p-4" aria-label="经营复盘">
      <Button type="button" variant="quiet" aria-expanded={showReview} onClick={() => setShowReview(!showReview)}>
        {showReview ? "收起周月复盘" : "打开周月复盘"}
      </Button>
      {showReview && <ReviewPanel onViewBrief={onViewBrief} />}
    </section>
    <section aria-labelledby="eagle-action-ledger" className="space-y-3">
      <h2 id="eagle-action-ledger" className="text-xl font-bold text-ink">行动台账</h2>
      {actionsMessage ? <AsyncState status="error" title="行动暂不可读" description={actionsMessage} onRetry={reloadActions} />
        : actionsLoading && !actions.length ? <AsyncState status="loading" title="正在读取行动" />
        : actions.length ? <div className="grid gap-3 lg:grid-cols-2">
          {actions.map((action) =>
            <WorkCard key={action.id} action={action} scope={scope} viewerMemberId={viewerMemberId} canReport={false} canVerify={canVerify} ownerName={members.find((member) => member.id === action.ownerMemberId)?.name} reload={reloadActions} />)}
        </div> : <AsyncState status="empty" title="暂无内部行动" description="确认晨报上的一项建议后，可以在此查看。" />}
    </section>
  </div>;
}
