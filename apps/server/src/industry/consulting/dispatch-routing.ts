/**
 * Consulting-owned task semantics for generic dispatch.
 *
 * The public report bridge orchestrates its own six-role workflow, but the
 * thread's user-facing owner is still chosen before execution. Falling back to
 * an alphabetical employee there mislabels research, finance, operations and
 * compliance work as the chief of staff. Keep the vocabulary in the industry
 * package and let the shared runtime consume only the resulting claim.
 */
const ROUTES: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/独立(?:质检|复核)|红队|质检|审核交付|打回|退回/u, "quality-officer"],
  [/访谈纪要|访谈提纲|转写|录音/u, "interview-secretary"],
  [/线索|商机|资格初筛/u, "lead-concierge"],
  [/应收|催收|开票|记账|账期|项目盈亏/u, "finance-keeper"],
  [/财报|毛利|营业利润|预算|现金流|估值|融资|勾稽/u, "finance-advisor"],
  [/交期|返工|精益|供应链|库存|流程再造|运营改善|订单变更|流程梳理/u, "ops-lean-counselor"],
  [/交付总监|交付物|工作坊|交付复盘|PPT/iu, "delivery-director"],
  [/组织|人力|绩效|薪酬|人才|权责|岗位评估/u, "org-hr-counselor"],
  [/风控|合规|风险|劳动法|数据合规|监管|隐私/u, "risk-compliance-officer"],
  [/提案|报价|方案架构/u, "proposal-architect"],
  [/三年规划|竞争战略|第二曲线|战略澄清|战略选项/u, "strategy-counselor"],
  [/AI转型|人工智能|数字化成熟度|数字员工|智能化路线图|AI治理/iu, "digital-ai-counselor"],
  [/专家匹配|资源对接|专家库/u, "resource-broker"],
  [/夜班|守夜|夜间巡检|经营异动/u, "night-watch"],
  [/续约|年度价值报告|情报订阅|预警值守|知识订阅|增值服务/u, "value-service-designer"],
  [/陪伴|常顾|客户流失|月度指标|五节拍/u, "companion-keeper"],
  [/营销|品牌定位|增长实验|销售漏斗|内容营销|转化率|ROI|CAC|能见度/u, "growth-marketer"],
  [/行业基准|行业口径|行业know-how|单店模型|SaaS指标|品类创新/iu, "industry-veteran"],
  [/公开研究|行业研究|产业分析|市场调研|政策研究|会前简报|公开信息|研究报告/u, "intel-researcher"],
  [/企业诊断|数据勾稽|矛盾|反证/u, "diagnosis-analyst"],
  [/报告排版|报告成稿|PPT排版/u, "report-composer"],
  [/分诊|派发|调度|跨部门|多岗位|班组|复杂.*咨询/u, "chief-of-staff"],
]);

/** Return the consulting employee that owns the request, or undefined when no domain matches. */
export function selectConsultingDispatchPreset(goal: string): string | undefined {
  const text = String(goal ?? "").trim();
  if (!text) return undefined;
  for (const [pattern, presetKey] of ROUTES) {
    if (pattern.test(text)) return presetKey;
  }
  return undefined;
}
