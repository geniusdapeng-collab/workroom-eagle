import { describe, expect, it } from "vitest";
import { selectConsultingDispatchPreset } from "./dispatch-routing.js";

describe("consulting dispatch routing", () => {
  it.each([
    ["做一个温州市制造业数字化转型现状研究报告，仅使用政府官网公开信息", "intel-researcher"],
    ["核对本月收入、毛利和现金流测算", "finance-advisor"],
    ["核对应收账款并准备催收函草稿", "finance-keeper"],
    ["梳理订单变更流程并压缩交期", "ops-lean-counselor"],
    ["设计绩效和关键人才保留方案", "org-hr-counselor"],
    ["审查裁员方案的劳动与数据合规风险", "risk-compliance-officer"],
    ["设计企业AI转型路线图与治理框架", "digital-ai-counselor"],
    ["对交付报告执行独立红队质检", "quality-officer"],
    ["为跨部门90天经营改善任务分诊并安排班组", "chief-of-staff"],
    ["设计常顾客户的月度监测与流失预警", "companion-keeper"],
    ["设计销售漏斗和品牌营销增长实验", "growth-marketer"],
    ["组织一次交付工作坊并复盘PPT", "delivery-director"],
    ["解释餐饮零售单店模型的行业基准", "industry-veteran"],
  ])("routes %s to %s", (goal, expected) => {
    expect(selectConsultingDispatchPreset(goal)).toBe(expected);
  });

  it("leaves unknown goals unclaimed so the runtime can expose a fallback explicitly", () => {
    expect(selectConsultingDispatchPreset("把文件整理一下")).toBeUndefined();
  });
});
