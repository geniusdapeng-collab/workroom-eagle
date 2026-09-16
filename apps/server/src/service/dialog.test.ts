/**
 * 对话意图与置信度纯函数测试。
 *
 * 鹰眼仓没有内置业务数据适配器：行业词义必须由活动 Bundle 选择的已登记
 * 适配器显式注入。测试适配器只验证基座接缝，不进入生产登记表。
 */
import { describe, expect, it } from "vitest";
import type { ServiceFrontBusinessAdapter } from "./adapters/business.js";
import {
  classify,
  tierOfScore,
  ticketKindOf,
  sharesDistinctiveEvidence,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
} from "./dialog.js";

const testAdapter: ServiceFrontBusinessAdapter = {
  id: "consulting.test-only",
  classify(text) {
    if (text.includes("咨询项目")) return { tool: "query_order", answer: "正在查询咨询项目。" };
    if (text.includes("顾问权益")) return { tool: "query_member", answer: "正在查询顾问服务权益。" };
    if (text.includes("服务方案")) return { tool: "query_catalog", answer: "正在查询咨询服务方案。" };
    return null;
  },
  ticketKind(text) {
    if (text.includes("修复")) return "repair";
    if (text.includes("递交")) return "delivery";
    return null;
  },
  async queryOrder() {
    return { demo: false, orders: [] };
  },
  async queryMember() {
    return { demo: false, member: null };
  },
  async queryCatalog() {
    return { demo: false, cardTitle: "咨询服务方案", items: [] };
  },
};

describe("行业中立的意图路由", () => {
  const cases: Array<[string, string, string?]> = [
    ["我要投诉服务响应太慢", "complaint"],
    ["查一下我的咨询项目", "biz_query", "query_order"],
    ["我的顾问权益还有哪些", "biz_query", "query_member"],
    ["服务方案怎么收费", "biz_query", "query_catalog"],
    ["我的工单进度怎么样了", "biz_query", "query_ticket"],
    ["请帮我修复资料链接", "service_request"],
    ["请帮我递交这份材料", "service_request"],
    ["下次访谈几点开始？", "kb_qa"],
  ];

  for (const [text, intent, tool] of cases) {
    it(`「${text}」→ ${intent}${tool ? `/${tool}` : ""}`, () => {
      const result = classify(text, testAdapter);
      expect(result.intent).toBe(intent);
      if (tool) expect(result.tool).toBe(tool);
    });
  }

  it("未注入行业适配器时不把业务词映射到任何行业工具", () => {
    for (const text of ["查一下我的订单", "我的会员积分还有多少", "豪华大床房多少钱一晚"]) {
      expect(classify(text)).toEqual({ intent: "kb_qa" });
    }
  });
});

describe("工单类型只接受已验证适配器投影", () => {
  it("适配器可返回基座支持的类型；无适配器时安全降级", () => {
    expect(ticketKindOf("请帮我修复资料链接", testAdapter)).toBe("repair");
    expect(ticketKindOf("请帮我递交这份材料", testAdapter)).toBe("delivery");
    expect(ticketKindOf("请安排一次访谈", testAdapter)).toBe("other");
    expect(ticketKindOf("空调坏了，帮我修一下")).toBe("other");
  });
});

describe("置信度三档", () => {
  it("阈值边界", () => {
    expect(CONFIDENCE_HIGH).toBe(0.72);
    expect(CONFIDENCE_MEDIUM).toBe(0.45);
    expect(tierOfScore(0.95)).toBe("high");
    expect(tierOfScore(0.72)).toBe("high");
    expect(tierOfScore(0.71)).toBe("medium");
    expect(tierOfScore(0.45)).toBe("medium");
    expect(tierOfScore(0.44)).toBe("low");
    expect(tierOfScore(undefined)).toBe("low");
  });

  it("越界输入归一化", () => {
    expect(tierOfScore(1.2)).toBe("high");
    expect(tierOfScore(-0.3)).toBe("low");
  });
});

describe("知识块合并词义由活动 Bundle 注入", () => {
  const first = { heading: "项目", content: "第一段" };
  const second = { heading: "项目", content: "第二段" };

  it("基座默认不把行业词擅自降为弱词", () => {
    expect(sharesDistinctiveEvidence(first, second)).toBe(true);
  });

  it("显式词表可阻止仅共享弱词的知识块合并", () => {
    expect(sharesDistinctiveEvidence(first, second, { weakTokens: ["项目"] })).toBe(false);
  });
});
