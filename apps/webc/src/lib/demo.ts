/** 内置演示数据：API 不可达时优雅降级使用（UI 会标注「演示数据」）。品牌文案一律读配置，无硬编码。 */
import { getConfig } from "./config";
import type { MemberInfo, NotificationItem, Order, TimelineItem, Ticket } from "./types";

export const DEMO_FLAG = "演示数据";

export function getDemoOrders(): Order[] {
  const brand = getConfig().brandName;
  return [
    {
      id: "HT-2025-HC-001",
      title: `${brand}常年顾问 · 年度服务`,
      status: "服务中",
      checkIn: "2025-07-01",
      roomType: "常年顾问",
      amount: 117600,
    },
    {
      id: "HT-2026-CY-001",
      title: "深度诊断 · 标准包",
      status: "服务中",
      checkIn: "2026-08-10",
      roomType: "深度诊断",
      amount: 68000,
    },
  ];
}

export function getDemoMember(): MemberInfo {
  return {
    level: "常年顾问客户",
    points: 0,
    benefits: ["7×24 指标监测", "月度观察报告（5 日前送达）", "季度复盘会", "年度价值报告（可审计）"],
    demo: true,
  };
}

export const demoTickets: Ticket[] = [
  {
    id: "TK-20260901-101",
    kind: "meeting",
    title: "预约深谈：下周季度复盘会（视频）",
    status: "处理中",
    createdAt: "2026-09-01T08:42:00.000Z",
    slaDueAt: "2026-09-01T10:42:00.000Z",
  },
  {
    id: "TK-20260831-087",
    kind: "material",
    title: "提交资料：8 月各门店营收汇总表截图",
    status: "已完成",
    createdAt: "2026-08-31T23:05:00.000Z",
  },
  {
    id: "TK-20260830-066",
    kind: "urgent",
    title: "紧急呼叫：董事会汇报预案支持",
    status: "已完成",
    createdAt: "2026-08-30T23:40:00.000Z",
  },
];

export function demoTimeline(ticketId: string): TimelineItem[] {
  const base = Date.now() - 1000 * 60 * 42;
  return [
    {
      action: "created",
      actorType: "guest",
      actorId: "me",
      detail: "工单已提交，AI 前台已受理",
      createdAt: new Date(base).toISOString(),
    },
    {
      action: "assigned",
      actorType: "agent",
      actorId: "AI-Concierge",
      detail: "已派单至客户成功（演示流转）",
      createdAt: new Date(base + 1000 * 60 * 5).toISOString(),
    },
    {
      action: "progress",
      actorType: "staff",
      actorId: "staff-0312",
      detail: `工单 ${ticketId} 处理中，客户成功已跟进`,
      createdAt: new Date(base + 1000 * 60 * 18).toISOString(),
    },
  ];
}

export function getDemoNotifications(): NotificationItem[] {
  return [
    {
      kind: "ticket.accepted",
      payload: { ticketId: "TK-20260901-101", title: "预约深谈：下周季度复盘会（视频）" },
      createdAt: "2026-09-01T08:42:10.000Z",
      read: false,
    },
    {
      kind: "ticket.completed",
      payload: { ticketId: "TK-20260831-087", title: "提交资料：8 月各门店营收汇总表截图" },
      createdAt: "2026-08-31T23:30:00.000Z",
      read: true,
    },
    {
      kind: "report.monthly",
      payload: { title: "月度观察报告已送达", detail: "8 月月报：营收环比 -6%，含 2 条建议动作" },
      createdAt: "2026-09-01T07:30:00.000Z",
      read: true,
    },
  ];
}

/** 关键词匹配的演示应答（用于 /c/chat 降级） */
export function demoChatAnswer(text: string): {
  intent: string;
  answer: string;
  confidence: number;
  citations: { documentTitle: string; heading: string; content: string }[];
  cards?: { kind: "order" | "member" | "catalog"; data: Record<string, unknown> }[];
} {
  const brand = getConfig().brandName;
  const t = text.toLowerCase();
  if (/月报|报告|进度|价值/.test(text)) {
    return {
      intent: "report.query",
      answer: "您的 8 月月度观察报告已生成并送主理咨询师审核（结论类内容按规矩必须他本人拍板），审核通过后即刻推送。年度价值报告草稿也已备好，每项价值都可下钻到服务记录。",
      confidence: 0.93,
      citations: [
        {
          documentTitle: `${brand}服务目录`,
          heading: "报告与档案",
          content: "月报每月 5 日前送达；年度价值报告续约季自动生成，每项价值可下钻到服务记录。",
        },
      ],
      cards: [{ kind: "order", data: getDemoOrders()[0] as unknown as Record<string, unknown> }],
    };
  }
  if (/预约|深谈|复盘|见面|视频/.test(text)) {
    return {
      intent: "meeting.book",
      answer: "已为您登记预约深谈需求，客户成功 2 小时内与您确认时间。会前 10 分钟情报简报会自动备好，纪要与行动项会自动归档进您的企业档案。",
      confidence: 0.92,
      citations: [
        {
          documentTitle: `${brand}服务目录`,
          heading: "预约深谈",
          content: "视频或到场均可；会前情报简报自动备好，会后行动项自动跟踪。",
        },
      ],
    };
  }
  if (/资料|截图|报表|文件|语音|提交/.test(t) || /资料|截图|报表|文件|语音|提交/.test(text)) {
    return {
      intent: "material.submit",
      answer:
        "直接把截图/照片/语音/文件发给我就行。我会自动解析内容、与历史口径比对、标注异常后归档进您的企业档案；涉及个人信息的部分会先脱敏。异常发现会附在清晨决策包里，比您开口更早。",
      confidence: 0.9,
      citations: [
        {
          documentTitle: `${brand}服务指南`,
          heading: "资料提交",
          content: "支持文件/截图/语音；自动解析归档入企业档案（脱敏后入库）。",
        },
      ],
    };
  }
  if (/紧急|帮忙|出事了|怎么办|焦虑/.test(text)) {
    return {
      intent: "urgent.escalate",
      answer: "我在。请简单说下发生了什么，我先帮您把关键信息整理好。此类事项按规矩需要主理咨询师亲自处理——我已同步升级叫醒他，夜间 15 分钟内回复您。",
      confidence: 0.88,
      citations: [],
    };
  }
  return {
    intent: "fallback",
    answer: "这个问题我已记录并转客户成功跟进，稍后会有人与您联系。您也可以直接描述需要的服务，或发截图/语音给我。",
    confidence: 0.42,
    citations: [],
  };
}
