import { clientChineseText } from "@workloom/ui";
import type { Preview } from "./types";
import { displayMoney, displayTime } from "./format";

type Fact = Preview["rows"][number];

const TYPE_LABEL: Record<Fact["kind"], string> = {
  lead: "线索", interaction: "客户跟进", opportunity: "商机节点", contract: "签约",
  invoice: "应收", payment: "回款", delivery_cost: "交付成本", deal_outcome: "成交结果", commitment: "承诺",
};
const SOURCE_LABEL: Record<Fact["sourceKind"], string> = { manual: "人工记录", crm: "业务台账", finance: "财务台账" };
const STAGE_LABEL = { qualified: "已确认有效", proposal: "方案", evaluation: "验证", negotiation: "谈判", won: "赢单", lost: "输单" };
const CUSTOMER_LABEL = { new: "新客", existing: "老客", unknown: "客户类型待确认" };

function summary(fact: Fact): string {
  switch (fact.kind) {
    case "interaction": return fact.note;
    case "lead": return `${fact.channel} · ${fact.qualified ? "已确认有效" : "待确认有效性"}`;
    case "opportunity": return STAGE_LABEL[fact.stage];
    case "contract": return `${displayMoney(fact.amountMinor)} · ${CUSTOMER_LABEL[fact.customerType]}`;
    case "invoice": return `${fact.invoiceRef} · ${displayMoney(fact.amountMinor)} · 到期 ${displayTime(fact.dueOn)}`;
    case "payment": return `${fact.invoiceRef} · ${displayMoney(fact.amountMinor)}`;
    case "delivery_cost": return displayMoney(fact.amountMinor);
    case "deal_outcome": return `${fact.outcome === "won" ? "赢单" : "输单"} · ${fact.reason}`;
    case "commitment": return `${fact.state === "open" ? "待履行" : "已交付"} · 到期 ${displayTime(fact.dueOn)}`;
  }
}

export function FactDetail({ fact }: { fact: Fact }) {
  return <>
    <p className="break-words font-medium text-ink">{fact.accountRef} · {fact.dealRef}</p>
    <p className="mt-1 break-words text-body text-ink3">
      {clientChineseText(TYPE_LABEL[fact.kind], "经营事实")} · {displayTime(fact.occurredOn)} · {clientChineseText(SOURCE_LABEL[fact.sourceKind], "来源待确认")}
      {fact.sourceRef && <> · {fact.sourceRef}</>}
    </p>
    <p className="mt-1 whitespace-pre-wrap break-words text-body text-ink2">{summary(fact)}</p>
    {fact.note && fact.kind !== "interaction" && <p className="mt-1 whitespace-pre-wrap break-words text-body text-ink2">{fact.note}</p>}
  </>;
}
