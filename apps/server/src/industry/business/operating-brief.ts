import { canonical, sha256 } from "../consulting/workflow-core.js";
import type { OperatingFact } from "./operating-facts.js";

type FactOf<K extends OperatingFact["kind"]> = Extract<OperatingFact, { kind: K }>;

export type OperatingInsight = {
  id: string;
  kind: "growth" | "leakage" | "competition" | "channel" | "commitment";
  title: string;
  detail: string;
  action: string;
  evidenceFactIds: string[];
};

function shiftDate(day: string, amount: number): string {
  const time = new Date(day);
  time.setUTCDate(time.getUTCDate() + amount);
  return time.toISOString().slice(0, 10);
}

function totalMinor(rows: Array<{ amountMinor: number }>): number {
  return rows.reduce((sum, row) => sum + row.amountMinor, 0);
}

function chronological(a: OperatingFact, b: OperatingFact): number {
  return a.occurredOn.localeCompare(b.occurredOn) || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const existing = groups.get(groupKey);
    if (existing) existing.push(row);
    else groups.set(groupKey, [row]);
  }
  return groups;
}

function kinds<K extends OperatingFact["kind"]>(facts: OperatingFact[], kind: K): FactOf<K>[] {
  return facts.filter((fact): fact is FactOf<K> => fact.kind === kind);
}

function dealIdentity(row: Pick<OperatingFact, "accountRef" | "dealRef">): string {
  return canonical([row.accountRef, row.dealRef]);
}

const UNKNOWN_CHANNEL = "未知来源";
const OBSERVATION_DAYS = 30;
const MINIMUM_COMPARABLE_LEADS = 10;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ADVANCED_STAGES = new Set(["proposal", "evaluation", "negotiation", "won"]);

function knownChannel(value: string): boolean {
  return Boolean(value.trim()) && !/^(?:未知(?:来源)?|来源未明|未记录|无来源|未提供|unknown|n\/?a|-)$/iu.test(value.trim());
}

type CohortEntry = {
  channel: string;
  lead: FactOf<"lead">;
  stage: FactOf<"opportunity"> | undefined;
  outcome: FactOf<"deal_outcome"> | undefined;
};

function summarizeChannel(entries: CohortEntry[]) {
  const evidence = entries.flatMap(({ lead, stage, outcome }) => [lead, ...(stage ? [stage] : []), ...(outcome ? [outcome] : [])]);
  return {
    leads: entries.length, qualified: entries.filter(({ lead }) => lead.qualified).length,
    advanced: entries.filter(({ stage, outcome }) => stage || outcome?.outcome === "won").length,
    won: entries.filter(({ outcome }) => outcome?.outcome === "won").length,
    evidenceFactIds: evidence.map((row) => row.id), evidence,
  };
}

function channelCohorts(
  facts: OperatingFact[], businessDate: string, asOf: string,
  outcomesByDeal: Map<string, FactOf<"deal_outcome">[]>,
) {
  const observationDate = new Date(Date.parse(asOf) + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  const firstUnfinishedDay = businessDate < observationDate ? businessDate : observationDate;
  const maturityEnd = shiftDate(firstUnfinishedDay, -OBSERVATION_DAYS - 1);
  const current = { from: shiftDate(maturityEnd, -29), to: maturityEnd };
  const previous = { from: shiftDate(maturityEnd, -59), to: shiftDate(maturityEnd, -30) };
  const leadsByDeal = groupBy(kinds(facts, "lead"), dealIdentity);
  const stagesByDeal = groupBy(kinds(facts, "opportunity"), dealIdentity);
  const entries: CohortEntry[] = [];
  let unmaturedLeadCount = 0;
  for (const [deal, leads] of leadsByDeal) {
    const qualifiedSource = leads.find((lead) => lead.qualified && knownChannel(lead.channel));
    const lead = qualifiedSource ?? leads.find((item) => item.qualified) ?? leads[0]!;
    if (lead.occurredOn > maturityEnd) { unmaturedLeadCount++; continue; }
    if (lead.occurredOn < previous.from) continue;
    const horizon = shiftDate(lead.occurredOn, OBSERVATION_DAYS);
    const inWindow = (row: OperatingFact) => row.occurredOn >= lead.occurredOn && row.occurredOn <= horizon;
    entries.push({
      channel: qualifiedSource?.channel ?? UNKNOWN_CHANNEL, lead,
      stage: stagesByDeal.get(deal)?.find((row) => inWindow(row) && ADVANCED_STAGES.has(row.stage)),
      outcome: outcomesByDeal.get(deal)?.filter(inWindow).at(-1),
    });
  }
  const pairs = [...groupBy(entries, (entry) => entry.channel)].map(([channel, group]) => {
    const { evidence, ...currentSnapshot } = summarizeChannel(group.filter(({ lead }) => lead.occurredOn >= current.from));
    const { evidence: previousEvidence, ...previousSnapshot } = summarizeChannel(group.filter(({ lead }) => lead.occurredOn <= previous.to));
    const comparable = channel !== UNKNOWN_CHANNEL && currentSnapshot.leads >= MINIMUM_COMPARABLE_LEADS
      && previousSnapshot.leads >= MINIMUM_COMPARABLE_LEADS;
    const delta = previousSnapshot.advanced * currentSnapshot.leads - currentSnapshot.advanced * previousSnapshot.leads;
    const hasDropSignal = comparable && delta * 5 >= currentSnapshot.leads * previousSnapshot.leads;
    return { metric: { channel, ...currentSnapshot, previous: previousSnapshot, comparable }, hasDropSignal, evidence: [...evidence, ...previousEvidence] };
  }).sort((a, b) => b.metric.leads - a.metric.leads || b.metric.previous.leads - a.metric.previous.leads || a.metric.channel.localeCompare(b.metric.channel));
  return { pairs, metadata: { observationDays: OBSERVATION_DAYS, minimumComparableLeads: MINIMUM_COMPARABLE_LEADS,
    current, previous, unmaturedLeadCount, unknownSourceLabel: UNKNOWN_CHANNEL } };
}

export function composeOperatingBrief(rows: OperatingFact[], businessDate: string, asOf: string) {
  const facts = rows.filter((row) => row.occurredOn <= businessDate && row.recordedAt <= asOf).sort(chronological);
  const superseded = new Set(facts.flatMap((row) => row.supersedesFactId ? [row.supersedesFactId] : []));
  const active = facts.filter((row) => !superseded.has(row.id));
  const currentStart = shiftDate(businessDate, -29);
  const previousStart = shiftDate(businessDate, -59);
  const previousEnd = shiftDate(businessDate, -30);
  const current = active.filter((row) => row.occurredOn >= currentStart);
  const previous = active.filter((row) => row.occurredOn >= previousStart && row.occurredOn <= previousEnd);
  const insights: OperatingInsight[] = [];
  const add = (kind: OperatingInsight["kind"], key: string, title: string, detail: string, action: string, evidence: OperatingFact[]) => {
    if (!evidence.length) return;
    insights.push({ id: sha256(canonical([kind, key])).slice(0, 24), kind, title, detail, action,
      evidenceFactIds: [...new Set(evidence.map((fact) => fact.id))] });
  };

  const contracts = kinds(current, "contract");
  const priorContracts = kinds(previous, "contract");
  const currentContractMinor = totalMinor(contracts);
  const previousContractMinor = totalMinor(priorContracts);
  const growth = {
    currentContractMinor, previousContractMinor, contractDeltaMinor: currentContractMinor - previousContractMinor,
    newCustomerContractMinor: totalMinor(contracts.filter((row) => row.customerType === "new")),
    existingCustomerContractMinor: totalMinor(contracts.filter((row) => row.customerType === "existing")),
    unknownCustomerContractMinor: totalMinor(contracts.filter((row) => row.customerType === "unknown")),
  };
  if (contracts.length && priorContracts.length && growth.contractDeltaMinor !== 0) add("growth", "window-delta", "核对签约额变化", "依两段各 30 天内已确认的合同记录计算，签约额与回款、收入分列。", "核对增减来自哪些合同以及新老客归类，补齐上游来源和期末漏录。", [...contracts, ...priorContracts]);
  else if (contracts.length && !priorContracts.length) add("growth", "prior-baseline", "补齐签约额对照期", "对照期未记录合同，需核实是否为零或数据尚未接入。", "核对对照期合同台账后再判断增长趋势。", contracts);
  if (growth.unknownCustomerContractMinor > 0) add("growth", "unknown-customer", "补齐新增与复购归类", "部分合同尚未归入新客或老客。", "请负责人核对客户关系并追加更正事实。", contracts.filter((row) => row.customerType === "unknown"));

  const invoices = kinds(active, "invoice");
  const payments = kinds(active, "payment");
  const invoiceKey = (row: FactOf<"invoice"> | FactOf<"payment">) => canonical([row.invoiceRef, row.accountRef, row.dealRef]);
  const invoicesByKey = groupBy(invoices, invoiceKey);
  const paymentsByKey = groupBy(payments, invoiceKey);
  let overdueInvoiceCount = 0;
  let overdueBalanceMinor = 0;
  for (const [key, group] of invoicesByKey) {
    const invoice = group.at(-1)!;
    const relatedPayments = paymentsByKey.get(key) ?? [];
    const balance = Math.max(0, invoice.amountMinor - totalMinor(relatedPayments));
    if (!balance || invoice.dueOn >= businessDate) continue;
    overdueInvoiceCount++;
    overdueBalanceMinor += balance;
    add("leakage", `invoice:${key}`, `核对到期应收 ${invoice.invoiceRef}`, "截至本次业务日期，已到期应收仍有余额。", "由财务核对回款入账及争议，销售核实回收计划并回填依据。", [invoice, ...relatedPayments]);
  }
  const contractsByDeal = groupBy(kinds(active, "contract"), dealIdentity);
  const costsByDeal = groupBy(kinds(active, "delivery_cost"), dealIdentity);
  let negativeContributionDealCount = 0;
  for (const [dealKey, costs] of costsByDeal) {
    const signed = contractsByDeal.get(dealKey) ?? [];
    if (!signed.length || !costs.some((row) => row.occurredOn >= currentStart) || totalMinor(costs) <= totalMinor(signed)) continue;
    negativeContributionDealCount++;
    add("leakage", `cost:${dealKey}`, `复核超支信号 ${costs[0]!.dealRef}`, "已记录直接交付成本超过已记录签约额。", "核对合同增补和成本归属，确认需不需要调整交付资源。", [...signed, ...costs]);
  }
  const leakage = { overdueInvoiceCount, overdueBalanceMinor, negativeContributionDealCount,
    unlinkedPaymentCount: payments.filter((row) => !invoicesByKey.has(invoiceKey(row))).length };

  const outcomesByDeal = groupBy(kinds(active, "deal_outcome"), dealIdentity);
  const lostDeals = [...outcomesByDeal.values()].map((items) => items.at(-1)!).filter((row) => row.outcome === "lost" && row.occurredOn >= currentStart);
  const competitors = [...groupBy(lostDeals.filter((row) => row.competitor), (row) => row.competitor!).entries()]
    .map(([name, items]) => ({ name, count: items.length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  for (const { name, count } of competitors) {
    add("competition", name, `复盘涉及 ${name} 的失单`, `当前记录有 ${count} 条失单提及该竞对，来源为团队确认的失单反馈。`,
      "核对客户实际选择标准、可佐证的差异和下一次可验证的话术或方案。", lostDeals.filter((row) => row.competitor === name));
  }
  const competition = { lostDealCount: lostDeals.length, unidentifiedCompetitorCount: lostDeals.filter((row) => !row.competitor).length, competitors };

  const cohorts = channelCohorts(active, businessDate, asOf, outcomesByDeal);
  const channels = cohorts.pairs.map(({ metric, hasDropSignal, evidence }) => {
    if (hasDropSignal) {
      add("channel", metric.channel, `抽查 ${metric.channel} 的推进卡点`,
        `本批 ${metric.advanced}/${metric.leads} 条得到推进或成交证据，对照批为 ${metric.previous.advanced}/${metric.previous.leads} 条，同口径推进比例降低至少 20 个百分点。`,
        "复核两个成熟批次的来源、阶段与客户反馈，抽查影响差异的代表性商机。", evidence);
    }
    return metric;
  });

  const commitmentKey = (row: FactOf<"commitment">) => canonical([row.accountRef, row.dealRef, row.commitmentRef]);
  const openCommitments = [...groupBy(kinds(active, "commitment"), commitmentKey).values()].map((items) => items.at(-1)!)
    .filter((item) => item.state === "open").sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.commitmentRef.localeCompare(b.commitmentRef));
  for (const item of openCommitments) {
    if (item.dueOn > shiftDate(businessDate, 3)) continue;
    add("commitment", commitmentKey(item), `核对待履行承诺 ${item.commitmentRef}`, `截止日期 ${item.dueOn}，当前档案仍显示待履行。`,
      "由承诺负责人核对实际进展、留存交付或重约证据。", [item]);
  }

  const kindCounts = Object.fromEntries([...groupBy(active, (row) => row.kind)].map(([kind, group]) => [kind, group.length]));
  const coverage = { currentStart, currentEnd: businessDate, previousStart, previousEnd, factCount: active.length,
    currentContractCount: contracts.length, previousContractCount: priorContracts.length, kindCounts,
    disclosure: "仅统计截至观察时间的已确认记录。空记录、未知来源及不完整对照期不能用于判断真实经营为零。金额为人民币分。成本超支信号供核查，正式利润仍由财务确认。" };
  const insightPriority = { commitment: 0, leakage: 1, competition: 2, channel: 3, growth: 4 };
  insights.sort((a, b) => insightPriority[a.kind] - insightPriority[b.kind]);
  return { metrics: { growth, leakage, competition, channels, channelCohorts: cohorts.metadata, coverage, openCommitmentCount: openCommitments.length },
    insights: insights.slice(0, 30), totalInsightCount: insights.length };
}
export type OperatingAnalysis = ReturnType<typeof composeOperatingBrief>;
