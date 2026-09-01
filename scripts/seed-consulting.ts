/**
 * A5 · eagle 鹰眼咨询演示种子数据（鹰眼咨询所：一个主理咨询师 + 12 数字员工的咨询所运行态）
 * 用法：pnpm db:seed（在 hotel 演示集之后执行；幂等，可重复执行）
 *
 * 内容：demo 租户 / 鹰眼咨询所工作区 / 3 人类成员 / 12 Agent preset 实例 /
 *      一企一档（3 家企业客户七大分区档案 + forbidden 硬约束）/ 基线围栏 C-R1~C-R9 装载 /
 *      10 官方技能 / 触发器 / 昨夜夜班班次 / 100 条五元事件（哈希链）/ 审批样例 / 组织记忆 /
 *      C 端咨询服务前台运行态（含多模态截图解析场景）
 *
 * 纪律与 scripts/seed.ts 完全一致：
 *  - 事件只经 workloom_gateway 角色写入（F1.2），其余表走 owner 种子连接（D10）；
 *  - 事件一律走 append_event_insert 特权函数（P0-3）；种子 event_id 用 E-SEED-99xx 前缀段，
 *    与 hotel 演示集（E-SEED-88xx）命名空间硬隔离；
 *  - 每条事件写入前过 zod（safeParseReplayAwareEvent）；
 *  - 幂等：组织模型 ON CONFLICT DO NOTHING；事件先查存在再写（L1.4）；
 *  - GUC 一律 set_config(..., is_local=true) 且包在显式事务内（L2）；
 *  - 验收：写入后回读 100 条事件逐条过 zod，五元字段完整率必须 100%（附录 H-1）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import YAML from "yaml";
import { eventHash, safeParseReplayAwareEvent } from "@workloom/base/workdata";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUNDLE_DIR = join(REPO_ROOT, "bundles/consulting");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const GATEWAY_URL =
  process.env.DATABASE_GATEWAY_URL ??
  "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";

/* ================= 固定演示标识（幂等键） ================= */

const TENANT_ID = "tenant-demo";
const WS_ID = "ws-eagle";
const WS_NAME = "鹰眼咨询所";
const WS_SLUG = "eagle-consulting";
const FENCE_VERSION = "consulting-baseline/v1";

const MEMBERS = [
  { id: "MEM-E01", name: "陈鹰", role: "owner" },      // 主理咨询师：唯一的信任载体与判断中枢
  { id: "MEM-E02", name: "林助理", role: "manager" },  // 客户经理/客户成功
  { id: "MEM-E03", name: "小周", role: "readonly" },   // 实习分析师
] as const;

const EVENT_BASE = 9800; // 事件编号 E-SEED-9801..9900 起（与 hotel 演示集 E-SEED-88xx 硬隔离；保持 4 位编号字典序口径）
const EVENT_COUNT = 100;
const GENESIS_HASH = "GENESIS";

/* ================= 工具 ================= */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260901);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

function iso(d: Date): string {
  return d.toISOString();
}

/** 演示时间轴：昨天 00:00 到今天现在；夜班段额外加密（22:00–08:30，F4.1） */
function demoTimeline(): Date[] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const span = now.getTime() - start.getTime();
  const times: Date[] = [];
  for (let i = 0; i < EVENT_COUNT; i++) {
    let t: number;
    if (i % 5 < 3) {
      const nightStart = new Date(start); nightStart.setHours(22, 0, 0, 0);
      const nightEnd = new Date(start); nightEnd.setDate(nightEnd.getDate() + 1); nightEnd.setHours(8, 30, 0, 0);
      t = nightStart.getTime() + rand() * (nightEnd.getTime() - nightStart.getTime());
    } else {
      t = start.getTime() + rand() * span;
    }
    times.push(new Date(t));
  }
  times.sort((a, b) => a.getTime() - b.getTime());
  return times;
}

/* ================= Bundle 资产读取 ================= */

interface Preset {
  preset_key: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  readonly: boolean;
  night_shift: boolean;
  high_risk: boolean;
  fence_bindings: string[];
  skills: string[];
  tools: Array<{ name: string; access: string; desc: string }>;
  prompt: unknown;
  write_back: string[];
}

function loadPresets(): Preset[] {
  const dir = join(BUNDLE_DIR, "presets");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f) => YAML.parse(readFileSync(join(dir, f), "utf-8")) as Preset);
}

interface FenceRule {
  rule_id: string;
  name: string;
  level: "auto" | "review" | "block";
  is_baseline: boolean;
  match: { object_types: string[]; actions: string[] };
  when: string;
  note?: string;
}

function loadFences(): FenceRule[] {
  const doc = YAML.parse(readFileSync(join(BUNDLE_DIR, "fences/consulting-baseline.yml"), "utf-8"));
  return (doc?.rules ?? []) as FenceRule[];
}

interface SkillDoc {
  name: string;
  description: string;
  body: string;
  fenceBindings: string[];
}

function loadSkills(): SkillDoc[] {
  const dir = join(BUNDLE_DIR, "skills");
  const bindMap: Record<string, string[]> = {
    "lead-triage": ["C-R1"],
    "pre-meeting-brief": [],
    "interview-kit": ["C-R5"],
    "enterprise-diagnosis": ["C-R2"],
    "proposal-forge": ["C-R1", "C-R3"],
    "report-composer": ["C-R2", "C-R5"],
    "red-team-review": ["C-R2", "C-R7"],
    "companion-watch": ["C-R2"],
    "expert-match": ["C-R8", "C-R9"],
    "finance-keeper": ["C-R6"],
  };
  return readdirSync(dir)
    .sort()
    .map((d) => {
      const raw = readFileSync(join(dir, d, "SKILL.md"), "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = YAML.parse(m?.[1] ?? "{}");
      return {
        name: String(fm.name ?? d),
        description: String(fm.description ?? ""),
        body: (m?.[2] ?? "").trim(),
        fenceBindings: bindMap[String(fm.name ?? d)] ?? [],
      };
    });
}

/** 鹰眼咨询所档案 + 一企一档 ×3（bundles/consulting/schemas/archive.schema.json 对齐；forbidden 与 C-R4/C-R5/C-R9 同源） */
function eagleArchive(): Record<string, unknown> {
  return {
    firm: {
      name: WS_NAME,
      principal: "陈鹰",
      bio: "12 年制造业与连锁消费管理咨询经验，前大型咨询机构项目总监",
      specialties: ["战略澄清", "组织效能", "运营改善", "数字化转型"],
      methodologies: ["7S", "波特五力", "SWOT", "BLM", "价值链分析"],
      price_list: {
        "快速体检": 0,
        "深度诊断（标准）": 68000,
        "方案设计（标准）": 98000,
        "落地陪跑（月）": 15000,
        "常年顾问（月）": 9800,
      },
    },
    clients: [
      {
        id: "ent-hengchang",
        name: "恒昌机械",
        stage: "retainer",
        profile: { industry: "装备制造", city: "苏州", employees: 320, revenue_band: "1.5-2 亿/年", owner: "王总", since: "2025-07" },
        metrics: {
          "2026-06": { revenue: 1420, gross_margin: 0.28, headcount: 318, cash_months: 4.2 },
          "2026-07": { revenue: 1385, gross_margin: 0.27, headcount: 320, cash_months: 3.9 },
          "2026-08": { revenue: 1302, gross_margin: 0.25, headcount: 322, cash_months: 3.5 },
        },
        cognition: [
          { date: "2025-08", type: "诊断结论", text: "核心瓶颈在订单交付周期（42 天 vs 行业 28 天），根因是计划排产依赖老师傅经验" },
          { date: "2025-10", type: "方案要点", text: "分三阶段导入计划体系：先可视化、再规则化、后系统化" },
          { date: "2026-03", type: "决策记录", text: "客户决定暂缓 ERP 大替换，先做轻量排产工具（避开了 80 万的无效投入）" },
        ],
        people: [
          { name: "王总", role: "创始人", style: "数据驱动，厌恶空话，喜欢先看结论", relation: "信任深" },
          { name: "李厂长", role: "生产负责人", style: "经验主义，初期抵触变革", relation: "已转为支持者" },
        ],
        actions: [
          { item: "排产规则 V2 试运行", owner: "李厂长", due: "2026-09-15", status: "on_track" },
          { item: "交付周期月度复盘", owner: "计划部", due: "2026-09-05", status: "overdue_2d" },
        ],
        value_ledger: [
          { date: "2025-11", action: "交付周期专项", value: "交付周期 42→31 天，年化释放产能约 900 万" },
          { date: "2026-03", action: "ERP 决策劝阻", value: "避免 80 万无效系统投入" },
          { date: "2026-07", action: "毛利异动预警", value: "提前 6 周发现原材料涨价侵蚀，调价挽回约 35 万/年" },
        ],
      },
      {
        id: "ent-chuanyu",
        name: "川渝味道",
        stage: "diagnosis",
        profile: { industry: "连锁餐饮", city: "成都", employees: 180, stores: 12, owner: "刘总", since: "2026-08" },
        metrics: {
          "2026-06": { revenue: 460, gross_margin: 0.62, stores: 12 },
          "2026-07": { revenue: 445, gross_margin: 0.60, stores: 12 },
        },
        cognition: [
          { date: "2026-08", type: "访谈纪要", text: "8 场访谈完成：店长层普遍认为标准化手册「写了没人看」，与总部说法矛盾" },
        ],
        people: [
          { name: "刘总", role: "创始人", style: "直觉决策，重感情", relation: "建立中" },
        ],
        actions: [
          { item: "剩余 4 场店长访谈", owner: "陈鹰", due: "2026-09-08", status: "on_track" },
        ],
        value_ledger: [],
      },
      {
        id: "ent-xinglan",
        name: "星澜科技",
        stage: "audit",
        profile: { industry: "SaaS 初创", city: "杭州", employees: 45, funding: "A 轮", owner: "张总", since: "2026-08-30" },
        metrics: {},
        cognition: [
          { date: "2026-08-30", type: "体检报告", text: "快照快扫完成：销售漏斗转化断层在中demo→POC 环节（转化率 11% vs 行业 25%）" },
        ],
        people: [{ name: "张总", role: "CEO", style: "技术出身，语速快", relation: "初识" }],
        actions: [{ item: "体检报告解读会", owner: "陈鹰", due: "2026-09-03", status: "on_track" }],
        value_ledger: [],
      },
    ],
    // 数字CEO 宪章（D21，演示：主理人已完成深度授权 → 试用期第 2 天）
    charter: {
      version: 1,
      mode: "trial",
      identity: { name: "总参谋长", persona: "严谨稳健型" },
      autonomy: { quote_cap: 20000, procurement_cap: 3000, content_cap: 2000 },
      escalate: ["任何诊断结论/人员评价外发", "合同金额超 10 万或非标条款", "涉密专家对接", "客户数据外发", "围栏规则放宽（任何放宽）", "对外公开承诺", "宪章变更"],
      briefing: { daily: "08:30", weekly: "Mon 09:00", monthly: "1st 10:00", channel: "both" },
      circuit_breaker: { window_days: 14, kpi_floor: { approval_pass_rate: 0.6 }, tightened: false },
      grant: {
        event_id: "E-GRANT-EAGLE01", granted_by: "MEM-E01",
        granted_at: new Date(Date.now() - 9 * 86400e3).toISOString(),
        disclosure_version: "risk-v1",
        clauses: ["夜班监测与研究自治", "草拟类自治（外发必审）", "试用降档规则", "AI 非法律责任主体·授权人承担咨询责任"],
        shadow_days: 3, trial_days: 7,
        trial_ends_at: new Date(Date.now() + 5 * 86400e3).toISOString(),
        retain_until: null,
      },
      updated_at: new Date().toISOString(),
    },
    service_standard: {
      tone: "专业克制，结论先行，每条建议挂依据",
      response_sla: { workday_hours: 2, night_urgent_minutes: 15 },
      confidentiality: ["客户数据不外发第三方（C-R9）", "员工个人信息必脱敏（C-R5）", "AI 不代替咨询师出席高信任场景（C-R4）"],
      banned_words: ["保证见效", "百分百成功", "业界第一"],
    },
    // 巡检只读快照（M9/F9.1 探针输入：客户指标异动/行动项逾期/续约窗口）
    inspection: {
      client_metrics: [
        { client: "恒昌机械", metric: "月营收", value: 1302, mom: -0.06, level: "p1" },
        { client: "恒昌机械", metric: "毛利率", value: 0.25, mom: -0.02, level: "p1" },
        { client: "川渝味道", metric: "月营收", value: 445, mom: -0.033, level: "p2" },
      ],
      action_items: [
        { client: "恒昌机械", item: "交付周期月度复盘", status: "overdue_2d", level: "p2" },
      ],
      renewal_windows: [
        { client: "恒昌机械", contract_end: "2026-12-31", level: "p2" },
      ],
      violations: [],
    },
    sop: ["诊断结论必过红队", "月报 5 日前送达", "高信任场景 AI 不替身", "每条建议挂依据链"],
    forbidden: [
      { rule: "AI 不得以咨询师身份进行首次会面/访谈/谈判", scope: "lead" },
      { rule: "客户 PII 未脱敏不得入库或外发", scope: "enterprise" },
      { rule: "客户敏感数据不得外发任何第三方", scope: "enterprise" },
      { rule: "涉密领域专家对接一律拦截", scope: "expert" },
    ],
  };
}

/* ================= 事件剧本生成 ================= */

interface SeedEvent {
  event_id: string;
  who: { type: "human" | "agent" | "system"; id: string; version?: string };
  context: {
    tenant_id: string;
    workspace_id: string;
    time: string;
    channel?: string;
    stage?: string;
    store?: string;
    [k: string]: unknown;
  };
  object: { type: string; id?: string; [k: string]: unknown };
  decision: {
    action: string;
    before?: unknown;
    after?: unknown;
    basis?: string[];
    memory_refs?: string[];
    [k: string]: unknown;
  };
  rule_impact: Array<{ rule_id: string; version: string; result: string }>;
  receipt?: { synced?: boolean; snapshot_uri?: string; verified_at?: string };
  model_trace?: { model_id: string; tier?: string; window?: string; credits?: number };
  links?: string[];
  [k: string]: unknown;
}

const CLIENTS = [
  { id: "ent-hengchang", name: "恒昌机械", stage: "retainer" },
  { id: "ent-chuanyu", name: "川渝味道", stage: "diagnosis" },
  { id: "ent-xinglan", name: "星澜科技", stage: "audit" },
] as const;

/** 生成一条剧本事件（按序号轮转场景，保证 C-R 系列规则均有命中样本） */
function makeEvent(i: number, time: Date, presets: Preset[]): SeedEvent {
  const id = `E-SEED-${EVENT_BASE + i}`;
  const scene = i % 10;
  const client = pick(CLIENTS);
  const baseCtx = {
    tenant_id: TENANT_ID,
    workspace_id: WS_ID,
    time: iso(time),
    stage: client.stage,
    store: WS_NAME,
    client: client.name,
  };
  const hour = time.getHours();
  const window = hour >= 22 || hour < 8 ? "off-peak" : "peak";
  const mt = (tier: "standard" | "flagship") => ({
    model_id: "mock-consulting-001",
    tier,
    window,
    credits: tier === "flagship" ? 2 : 1,
  });
  const receipt = (t: Date) => ({
    synced: true,
    snapshot_uri: `data/snapshots/${id.toLowerCase()}.png`,
    verified_at: iso(new Date(t.getTime() + 45_000)),
  });
  const agentWho = (key: string) => {
    const p = presets.find((x) => x.preset_key === key)!;
    return { type: "agent" as const, id: p.preset_key, version: p.version };
  };

  switch (scene) {
    case 0: {
      // C-R1 小额标准报价自动（pass）：星澜科技深度诊断标准报价 ¥15,000
      return {
        event_id: id,
        who: agentWho("proposal-architect"),
        context: { ...baseCtx, channel: "inapp", client: "星澜科技", stage: "audit" },
        object: { type: "contract", id: `QT-${int(1000, 9999)}`, label: "星澜科技·深度诊断报价" },
        decision: {
          action: "quote.send",
          params: { amount: 15000, standard_price: true },
          after: { quote: "深度诊断（标准包）¥15,000，含 8 场访谈与诊断报告", client: "星澜科技" },
          basis: ["标准价目表：深度诊断（标准）", "工作量测算：8 场访谈 × 1.5 人天 + 报告 3 人天"],
        },
        rule_impact: [{ rule_id: "C-R1", version: FENCE_VERSION, result: "pass" }],
        receipt: receipt(time),
        model_trace: mt("standard"),
      };
    }
    case 1: {
      // C-R2 诊断结论类内容外发必审（review → 挂起）：恒昌机械 8 月月报含结论
      return {
        event_id: id,
        who: agentWho("companion-keeper"),
        context: { ...baseCtx, channel: "inapp", client: "恒昌机械", stage: "retainer" },
        object: { type: "deliverable", id: `MR-2026-08-${int(10, 99)}`, label: "恒昌机械 8 月月度观察报告" },
        decision: {
          action: "report.send",
          params: { contains_conclusion: true, contains_personnel_eval: false, contains_org_advice: true },
          after: { draft: "8 月营收环比 -6%、毛利率降至 25%：判断为原材料涨价+低毛利订单占比上升双重挤压，建议启动报价复盘……" },
          basis: ["经营仪表盘 2026-08 月度序列", "价值台账 2026-07 毛利预警记录"],
          memory_refs: ["mem-monthly-report-sop"],
        },
        rule_impact: [{ rule_id: "C-R2", version: FENCE_VERSION, result: "review" }],
        model_trace: mt("standard"),
      };
    }
    case 2: {
      // 夜班访谈转写与纪要（auto）：川渝味道店长访谈
      return {
        event_id: id,
        who: agentWho("interview-secretary"),
        context: { ...baseCtx, channel: "夜班", client: "川渝味道", stage: "diagnosis" },
        object: { type: "interview", id: `IV-${int(100, 999)}`, label: "川渝味道·店长访谈" },
        decision: {
          action: "doc.transcribe",
          params: { pii_desensitized: true },
          after: { duration_min: 72, words: 9800, memo: "事实/观点/情绪/矛盾点四栏纪要初稿已生成，矛盾点 ×2 已标注" },
          basis: ["转写引擎回执", "脱敏管线回执（C-R5 前置）"],
        },
        rule_impact: [{ rule_id: "C-R5", version: FENCE_VERSION, result: "pass" }],
        receipt: receipt(time),
        model_trace: mt("standard"),
      };
    }
    case 3: {
      // 夜班情报研究（只读）：恒昌机械所在行业原材料价格扫描
      return {
        event_id: id,
        who: agentWho("intel-researcher"),
        context: { ...baseCtx, channel: "夜班", client: "恒昌机械", stage: "retainer" },
        object: { type: "research_task", id: `RS-${int(1000, 9999)}` },
        decision: {
          action: "web.research",
          after: { card: "装备制造原材料周报", finding: "冷轧板卷环比 +3.2%，连续 5 周上行", relevance: "恒昌机械成本侧直接相关" },
          basis: ["公开行情源 ×3 交叉验证", "频次自律：请求间隔 ≥3s（L3.3）"],
        },
        rule_impact: [],
        model_trace: mt("standard"),
      };
    }
    case 4: {
      // 人类审批手势（陈鹰 批准月报外发）
      return {
        event_id: id,
        who: { type: "human", id: "MEM-E01" },
        context: { ...baseCtx, channel: "inapp", client: "恒昌机械", stage: "retainer" },
        object: { type: "deliverable", id: `MR-2026-08-${int(10, 99)}` },
        decision: {
          action: "approval.gesture",
          after: { gesture: "approve", weight: 1 },
          basis: ["结论有数据支撑，建议部分已按我的口径改了两处措辞（编辑后采纳）"],
        },
        rule_impact: [],
      };
    }
    case 5: {
      // C-R3 大额合同必审（review）：川渝味道常年顾问年度合同 ¥117,600
      return {
        event_id: id,
        who: agentWho("proposal-architect"),
        context: { ...baseCtx, channel: "inapp", client: "川渝味道", stage: "proposal" },
        object: { type: "contract", id: `HT-${int(1000, 9999)}`, label: "川渝味道·常年顾问年度合同" },
        decision: {
          action: "quote.send",
          params: { amount: 117600, standard_price: true, nonstandard_terms: false },
          basis: ["常年顾问（月）¥9,800 × 12 个月", "诊断期交付满意度达标后转常流"],
        },
        rule_impact: [{ rule_id: "C-R3", version: FENCE_VERSION, result: "review" }],
        model_trace: mt("standard"),
      };
    }
    case 6: {
      // 守夜巡检：客户指标异动 P1（恒昌机械营收环比 -6%）
      return {
        event_id: id,
        who: agentWho("night-watch"),
        context: { ...baseCtx, channel: "巡检", client: "恒昌机械", stage: "retainer" },
        object: { type: "metric", id: "revenue-monthly", label: "恒昌机械·月营收" },
        decision: {
          action: "inspection.scan",
          after: { level: "p1", finding: "恒昌机械 8 月营收 1302 万，环比 -6%，连续 2 个月下行；已联动情报卡（原材料 +3.2%）" },
          basis: ["经营仪表盘月度序列", "阈值规则：环比降幅 >5% 触发 P1"],
        },
        rule_impact: [],
        model_trace: mt("standard"),
      };
    }
    case 7: {
      // C-R4 熔断（blocked）：AI 试图代替咨询师进行首次澄清会
      return {
        event_id: id,
        who: agentWho("lead-concierge"),
        context: { ...baseCtx, channel: "wechat", client: "星澜科技", stage: "audit" },
        object: { type: "lead", id: `LD-${int(1000, 9999)}`, label: "星澜科技张总" },
        decision: {
          action: "meeting.attend",
          params: { as_consultant: true },
          basis: ["张总临时改约今晚视频，陈鹰在另一场汇报会上"],
        },
        rule_impact: [{ rule_id: "C-R4", version: FENCE_VERSION, result: "blocked" }],
        model_trace: mt("standard"),
      };
    }
    case 8: {
      // C-R5 熔断（blocked）：访谈纪要未脱敏试图入库
      return {
        event_id: id,
        who: agentWho("interview-secretary"),
        context: { ...baseCtx, channel: "夜班", client: "川渝味道", stage: "diagnosis" },
        object: { type: "interview", id: `IV-${int(100, 999)}` },
        decision: {
          action: "archive.write",
          params: { pii_desensitized: false },
          after: { attempted: "含店长薪酬明细的原始纪要直写入档" },
          basis: ["夜班批量入库流程绕过脱敏管线（异常路径）"],
        },
        rule_impact: [{ rule_id: "C-R5", version: FENCE_VERSION, result: "blocked" }],
        model_trace: mt("standard"),
      };
    }
    default: {
      // 系统事件：夜班状态机迁移 / 记忆固化 / 红队反证留痕
      const sysAction = pick(["night.run.start", "night.package.deliver", "memory.consolidate"]);
      return {
        event_id: id,
        who: { type: "system", id: "night-shift" },
        context: { ...baseCtx, channel: "夜班" },
        object: { type: "enterprise", id: WS_ID },
        decision: {
          action: sysAction,
          after: { note: "夜班状态机推进（F4.8）：研究/转写/监测批量任务谷时执行" },
        },
        rule_impact: [],
      };
    }
  }
}

/* ================= 主流程 ================= */

async function main(): Promise<void> {
  const presets = loadPresets();
  const fences = loadFences();
  const skillsDocs = loadSkills();
  console.log(`✓ Bundle 资产读取：${presets.length} preset / ${fences.length} 围栏 / ${skillsDocs.length} 技能`);

  const owner = new pg.Client({ connectionString: DATABASE_URL });
  await owner.connect();
  const q = (text: string, params: unknown[]) => owner.query(text, params);

  // 工作区（租户 tenant-demo 已由 hotel 种子创建；此处幂等兜底）
  await q(
    `INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, "演示租户（Demo）"],
  );
  await q(
    `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
     VALUES ($1,$2,$3,$4,'consulting','retainer',$5) ON CONFLICT (id) DO NOTHING`,
    [
      WS_ID, TENANT_ID, WS_NAME, WS_SLUG,
      JSON.stringify({ enabled: true, candidateTime: "18:00", startTime: "22:00", packageTime: "08:30", timezone: "Asia/Shanghai" }),
    ],
  );
  console.log("✓ 租户与工作区：demo / 鹰眼咨询所（consulting · 常年顾问期）");

  for (const m of MEMBERS) {
    await q(
      `INSERT INTO members (id, workspace_id, member_no, name, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, member_no) DO NOTHING`,
      [`${m.id.toLowerCase()}-id`, WS_ID, m.id, m.name, m.role],
    );
  }
  console.log(`✓ 人类成员 ×${MEMBERS.length}（${MEMBERS.map((m) => `${m.name}/${m.role}`).join("、")}）`);

  for (const p of presets) {
    await q(
      `INSERT INTO agents (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        `agt-${p.preset_key}`,
        WS_ID,
        p.preset_key,
        p.name,
        p.version,
        p.kind,
        p.readonly,
        JSON.stringify(p.fence_bindings),
        JSON.stringify(p.skills),
        JSON.stringify({
          description: p.description,
          night_shift: p.night_shift,
          high_risk: p.high_risk,
          tools: p.tools,
          prompt: p.prompt,
          write_back: p.write_back,
        }),
      ],
    );
  }
  console.log(`✓ Agent 实例 ×${presets.length}（12 数字员工班组；未声明 fence_bindings 禁写 F2.10）`);

  const archive = { ...eagleArchive(), dataMode: "simulated" };
  await q(
    `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
     VALUES ($1,$2,'consulting',$3,$4,NULL)
     ON CONFLICT (workspace_id) DO UPDATE SET archive = EXCLUDED.archive, forbidden = EXCLUDED.forbidden, updated_at = now()`,
    [WS_ID, TENANT_ID, JSON.stringify(archive), JSON.stringify(archive.forbidden)],
  );
  console.log("✓ 一企一档 ×3（恒昌机械/川渝味道/星澜科技；forbidden 硬约束 ×4 与 C-R4/C-R5/C-R8/C-R9 同源）");

  for (const r of fences) {
    await q(
      `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','system:seed')
       ON CONFLICT (rule_id, version, workspace_id) DO NOTHING`,
      [
        `fr-${r.rule_id.toLowerCase().replace(/-/g, "")}-v1-${WS_ID}`,
        r.rule_id,
        FENCE_VERSION,
        WS_ID,
        r.name,
        r.level,
        JSON.stringify({ ...r.match, when: r.when }),
        JSON.stringify({ result: r.level === "auto" ? "pass" : r.level === "review" ? "review" : "blocked", note: r.note ?? "" }),
        r.is_baseline,
      ],
    );
  }
  console.log(`✓ 基线围栏装载 ×${fences.length}（${FENCE_VERSION}，active；default_level=review 偏紧）`);

  for (const s of skillsDocs) {
    const skillId = `skill-${s.name}`;
    await q(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'official','consulting',$2,'1.0.0',$3,$4,$5,false)
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, version = EXCLUDED.version,
                                      fence_bindings = EXCLUDED.fence_bindings
       WHERE skills.version IS DISTINCT FROM EXCLUDED.version`,
      [skillId, s.name, s.description, JSON.stringify(s.fenceBindings), s.body],
    );
    await q(
      `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
       SELECT s.id, $2, 'MEM-E01', s.fence_bindings, s.version FROM skills s WHERE s.id = $1
       ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
      [skillId, WS_ID],
    );
  }
  console.log(`✓ 官方技能 ×${skillsDocs.length} 已安装（围栏绑定随安装生效）`);

  // 团队技能 + 行业共享技能（P6 装备库三区演示数据）
  await q(
    `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
     VALUES ('skill-t-ws-eagle-renewal-season-kit','team','consulting','续约季价值报告周检','1.1.0',
             '续约窗口前 60 天起，每周一自动核查：价值台账完整度/月报送达率/行动项闭环率，产出续约风险与弹药清单（本工作区自建）。',
             '[]',
             '# 续约季价值报告周检\n\n## 触发（何时用）\n续约窗口前 60 天起，每周一 08:00。\n\n## 步骤（怎么做）\n1. 核查该客户价值台账行数与证据链完整度（只读）。\n2. 核查月报送达率与行动项闭环率。\n3. 产出续约风险评级与弹药清单进 P4 待审。\n\n## 边界（什么不做）\n不直接联系客户、不生成对外承诺。',
             false)
     ON CONFLICT (id) DO NOTHING`,
  );
  await q(
    `INSERT INTO skill_installs (skill_id, workspace_id, installed_by, fence_bindings_snapshot, installed_version)
     SELECT s.id, $1, 'MEM-E02', s.fence_bindings, s.version FROM skills s
     WHERE s.id = 'skill-t-ws-eagle-renewal-season-kit'
     ON CONFLICT (skill_id, workspace_id) DO NOTHING`,
    [WS_ID],
  );
  await q(
    `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
     VALUES ('skill-i-manufacturing-lean-diagnosis','industry','east-china-consulting-alliance','制造业精益诊断包','2.0.0',
             '华东咨询联盟共享：中小制造业诊断打法包（交付周期/库存/排产三快扫 + 访谈提纲模板），89 家机构在用；上架前已脱敏（L8.1 ✓）。',
             '["C-R2"]',
             '# 制造业精益诊断包\n\n## 触发（何时用）\n制造业客户深度诊断期。\n\n## 步骤（怎么做）\n1. 三快扫：交付周期/库存周转/排产规则化程度。\n2. 访谈提纲按角色分层（老板/厂长/计划/班组长）。\n3. 结论素材包组装（定调留给人，C-R2 管辖）。\n\n## 边界（什么不做）\n不替客户下诊断结论、不评价具体个人。',
             true)
     ON CONFLICT (id) DO NOTHING`,
  );
  console.log(`✓ 团队技能 ×1（已装）+ 行业共享技能 ×1（已脱敏待装）`);

  const triggers = [
    { id: "tg-eagle-inspection-0700", name: "每日 07:00 客户指标只读巡检", kind: "cron", schedule: "0 7 * * *", action: { dispatch: "night-watch", template: "inspection.daily" } },
    { id: "tg-eagle-night-2200", name: "夜班 22:00 战队出征", kind: "cron", schedule: "0 22 * * *", action: { dispatch: "night-shift", template: "night.run.start" } },
    { id: "tg-eagle-ceo-brief-0830", name: "总参谋长 晨报 08:30", kind: "cron", schedule: "30 8 * * *", action: { beat: "daily" } },
    { id: "tg-eagle-ceo-queue-2h", name: "总参谋长 裁决巡检 2h", kind: "cron", schedule: "7 */2 * * *", action: { beat: "queue" } },
    { id: "tg-eagle-ceo-deviation", name: "总参谋长 目标偏差扫描", kind: "cron", schedule: "15 */4 * * *", action: { beat: "deviation" } },
    { id: "tg-eagle-ceo-breaker", name: "总参谋长 自治熔断巡检", kind: "cron", schedule: "45 23 * * *", action: { beat: "breaker" } },
  ];
  for (const t of triggers) {
    await q(
      `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,'MEM-E01') ON CONFLICT (id) DO NOTHING`,
      [t.id, WS_ID, t.name, t.kind, t.schedule, JSON.stringify(t.action)],
    );
  }
  console.log("✓ 触发器 ×6（巡检/夜班 + 总参谋长节拍 ×4）");

  const threads = [
    { id: "T-201", title: "恒昌机械 8 月月度观察报告（含毛利异动结论）", mode: "quest", status: "pending_review", done: 4, total: 5, agent: "agt-companion-keeper", by: "MEM-E01" },
    { id: "T-202", title: "川渝味道诊断期访谈转写与矛盾点核对", mode: "quest", status: "running", done: 8, total: 12, agent: "agt-interview-secretary", by: "MEM-E01" },
    { id: "T-203", title: "星澜科技体检报告解读会准备", mode: "agent", status: "running", done: 1, total: 4, agent: "agt-intel-researcher", by: "MEM-E02" },
  ];
  for (const t of threads) {
    await q(
      `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, progress_done, progress_total, created_by, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [t.id, TENANT_ID, WS_ID, t.title, t.mode, t.status, t.done, t.total, t.by, t.agent],
    );
  }
  console.log(`✓ 演示线程 ×${threads.length}（pending_review / running）`);

  for (const c of [
    { id: "cred-wecom-channel", provider: "wecom", ref_key: "eagle/wecom" },
    { id: "cred-expert-network", provider: "expert-network", ref_key: "eagle/experts" },
  ]) {
    await q(
      `INSERT INTO credentials (id, workspace_id, provider, ref_key, secret_enc, scopes, health)
       VALUES ($1,$2,$3,$4,'demo-placeholder-ciphertext',$5,'unknown') ON CONFLICT (id) DO NOTHING`,
      [c.id, WS_ID, c.provider, c.ref_key, JSON.stringify(["read", "write"])],
    );
  }
  console.log("✓ 凭据引用 ×2（企微通道/专家网络，占位密文）");

  // —— 事件写入：切 gateway 角色（F1.2 唯一可 INSERT biz_events）
  await owner.end();
  const gw = new pg.Client({ connectionString: GATEWAY_URL });
  await gw.connect();
  await gw.query("BEGIN");
  await gw.query("SELECT set_config('app.workspace_id', $1, true)", [WS_ID]);
  await gw.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);

  const last = await gw.query(
    `SELECT hash FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT 1`,
    [TENANT_ID, WS_ID],
  );
  let prevHash = (last.rows[0]?.hash as string) ?? GENESIS_HASH;

  const times = demoTimeline();
  const sessionOf = (scene: number): string | null =>
    scene === 1 || scene === 4 ? "T-201" : scene === 2 || scene === 8 ? "T-202" : scene === 3 ? "T-203" : null;

  const eventExists = async (eventId: string): Promise<boolean> => {
    const r = await gw.query(
      `SELECT 1 FROM biz_events WHERE tenant_id=$1 AND event_id=$2`,
      [TENANT_ID, eventId],
    );
    return (r.rowCount ?? 0) > 0;
  };

  let inserted = 0;
  let dupSkipped = 0;
  for (let i = 1; i <= EVENT_COUNT; i++) {
    const ev = makeEvent(i, times[i - 1] as Date, presets);
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) {
      throw new Error(`种子事件 ${ev.event_id} 未过附录 E 校验：${checked.error.message}`);
    }
    if (await eventExists(ev.event_id)) {
      dupSkipped += 1;
      continue;
    }
    const payload = JSON.stringify(checked.data);
    const hash = eventHash(prevHash, checked.data);
    const res = await gw.query<{ seq: string | null; inserted: boolean }>(
      `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev.event_id, TENANT_ID, WS_ID, sessionOf(i % 10), payload, prevHash, hash, ev.context.time],
    );
    if (res.rows[0]?.inserted) {
      prevHash = hash;
      inserted += 1;
    } else {
      dupSkipped += 1;
    }
  }
  console.log(`✓ 五元事件：新写入 ${inserted} 条，幂等丢弃 ${dupSkipped} 条（L1.4）`);

  // 总参谋长晨报事件（剧场汇报气泡/董事长视图简报流的数据源；幂等键 E-SEED-9799，避开 98xx 场景事件段）
  {
    const ev = {
      event_id: "E-SEED-9799",
      who: { type: "agent", id: "captain", version: "v1.0" },
      context: { tenant_id: TENANT_ID, workspace_id: WS_ID, time: new Date().toISOString(), stage: "retainer", store: WS_NAME },
      object: { type: "enterprise", id: WS_ID, label: WS_NAME },
      decision: {
        action: "ceo.briefing",
        after: { text: "主理人，早报已备：昨夜班组完成 9 项作业（恒昌毛利异动已联动情报卡，川渝 2 场访谈纪要待您过目，星澜解读会材料就绪）；4 件待您拍板——8 月月报外发、年度合同报价、专家对接请求、诊断段落措辞；1 件需介入：王总昨夜 23:40 语音留言，情绪偏低，已先行安抚并整理要点。试用期边界降一档执行中。" },
        basis: ["CEO Loop 日频晨报 08:30"],
      },
      rule_impact: [],
      receipt: { synced: true, snapshot_uri: "data/snapshots/e-seed-9799.png", verified_at: new Date().toISOString() },
      model_trace: { model_id: "mock-consulting-001", tier: "standard", window: "peak", credits: 1 },
    };
    const checked = safeParseReplayAwareEvent(ev as never);
    if (!checked.success) throw new Error(`晨报事件未过校验：${checked.error.message}`);
    if (await eventExists(ev.event_id)) {
      console.log("✓ 总参谋长晨报事件（已存在，幂等跳过）");
    } else {
      const payload = JSON.stringify(checked.data);
      const hash = eventHash(prevHash, checked.data);
      const res = await gw.query<{ seq: string | null; inserted: boolean }>(
        `SELECT * FROM append_event_insert($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ev.event_id, TENANT_ID, WS_ID, null, payload, prevHash, hash, ev.context.time],
      );
      if (res.rows[0]?.inserted) prevHash = hash;
      console.log("✓ 总参谋长晨报事件（剧场汇报气泡数据源）");
    }
  }

  // 审批样例：取最近两条 review 结果事件挂审批（一 pending 一 approved）
  const reviewEvents = await gw.query(
    `SELECT event_id, payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2
       AND payload->'rule_impact' @> '[{"result":"review"}]'::jsonb
     ORDER BY seq DESC LIMIT 2`,
    [TENANT_ID, WS_ID],
  );
  for (const [idx, row] of reviewEvents.rows.entries()) {
    const p = row.payload as SeedEvent;
    const status = idx === 0 ? "pending" : "approved";
    await gw.query(
      `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, gesture, snapshot, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,'inapp',$5,$6,$7,$8,$9)
       ON CONFLICT (event_id, channel) DO NOTHING`,
      [
        `apr-${row.event_id.toLowerCase()}`,
        TENANT_ID,
        WS_ID,
        row.event_id,
        status,
        status === "approved" ? JSON.stringify({ type: "approve", weight: 1 }) : null,
        JSON.stringify({
          before: p.decision.before ?? null,
          after: p.decision.after ?? null,
          action: p.decision.action,
          params: p.decision.params ?? {},
          base_price: (p.decision.params as Record<string, unknown> | undefined)?.amount ?? null,
          expires_at: iso(new Date(Date.now() + 24 * 3600 * 1000)),
        }),
        status === "approved" ? "MEM-E01" : null,
        status === "approved" ? new Date().toISOString() : null,
      ],
    );
  }
  console.log(`✓ 审批样例 ×${reviewEvents.rows.length}（pending/approved 各一）`);

  // 昨夜夜班班次（package_generated，决策包统计三栏）
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const runDate = yesterday.toISOString().slice(0, 10);
  await gw.query(
    `INSERT INTO night_runs (id, workspace_id, run_date, status, fence_snapshot_version, candidate_count, stats, started_at, package_event_id)
     VALUES ($1,$2,$3,'package_generated',$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING`,
    [
      `nr-${WS_ID}-${runDate}`,
      WS_ID,
      runDate,
      FENCE_VERSION,
      16,
      JSON.stringify({ done: 9, pending: 4, need_human: 1, credits_used: 88, credits_est: 112 }),
      new Date(yesterday.setHours(22, 0, 0, 0)).toISOString(),
      `E-SEED-${EVENT_BASE + EVENT_COUNT}`,
    ],
  );
  console.log(`✓ 夜班班次 nr-${WS_ID}-${runDate}（package_generated，围栏快照 ${FENCE_VERSION}）`);

  // 组织记忆 + 归因（F1.4）
  const memories = [
    { id: "mem-monthly-report-sop", kind: "sop", content: "月度观察报告结构：结论先行→数据异动→原因判断→建议动作→下月关注；每条结论挂数据出处，5 日前送达", source: ["E-SEED-9802"] },
    { id: "mem-wangzong-preference", kind: "preference", content: "恒昌机械王总偏好：先看结论和数字，厌恶形容词；报告超过 2 页要有摘要", source: ["E-SEED-9804"] },
    { id: "mem-forbidden-ai-meeting", kind: "forbidden", content: "任何情况下 AI 不代替陈鹰进行首次会面、访谈与谈判——高信任场景必须人到场", source: ["E-SEED-9807"] },
  ];
  for (const m of memories) {
    await gw.query(
      `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, source_events, confidence)
       VALUES ($1,$2,$3,'workspace',$4,$5,$6,0.7)
       ON CONFLICT (memory_id) DO NOTHING`,
      [m.id, TENANT_ID, WS_ID, m.kind, m.content, m.source],
    );
    await gw.query(
      `INSERT INTO memory_usage (memory_id, event_id, workspace_id) VALUES ($1,$2,$3)
       ON CONFLICT (memory_id, event_id) DO NOTHING`,
      [m.id, m.source[0], WS_ID],
    );
  }
  console.log(`✓ 组织记忆 ×${memories.length}（SOP/偏好/forbidden，含来源事件归因）`);

  // —— 验收（附录 H-1）：回读本批次 100 条，逐条过 zod
  const check = await gw.query(
    `SELECT payload FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2 AND event_id >= $3 AND event_id <= $4
     ORDER BY seq`,
    [TENANT_ID, WS_ID, `E-SEED-${EVENT_BASE + 1}`, `E-SEED-${EVENT_BASE + EVENT_COUNT}`],
  );
  let valid = 0;
  for (const row of check.rows) {
    if (safeParseReplayAwareEvent(row.payload as never).success) valid += 1;
  }
  const rate = check.rowCount ? valid / check.rowCount : 0;
  console.log(`✓ 验收（H-1）：回读 ${check.rowCount} 条，五元字段完整 ${valid} 条，完整率 ${(rate * 100).toFixed(1)}%`);
  if (check.rowCount !== EVENT_COUNT || rate !== 1) {
    throw new Error(`验收失败：期望 ${EVENT_COUNT} 条且完整率 100%（实际 ${check.rowCount} 条 / ${(rate * 100).toFixed(1)}%）`);
  }

  // ============ AI 服务前台 · 咨询服务运行态（企业客户视角，含多模态场景） ============
  const svcQ = (text: string, params: unknown[]) => gw.query(text, params);

  // C 端用户（三家企业客户的关键人）
  await svcQ(
    `INSERT INTO c_users (id, workspace_id, channel, openid, nickname, member_id, created_at)
     VALUES
       ('cu-wanghc', $1, 'wechat-mini', 'openid-wanghc', '王总（恒昌机械）', 'ENT-HC-001', $2),
       ('cu-liucy', $1, 'wechat-mini', 'openid-liucy', '刘总（川渝味道）', 'ENT-CY-002', $3),
       ('cu-zhangxl', $1, 'h5', 'fp-zhangxl-5e2b', '张总（星澜科技）', NULL, $4)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 400 * 86400000).toISOString(), new Date(Date.now() - 25 * 86400000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString()],
  );

  // 知识库：咨询服务目录 + FAQ（数据源 bundles/consulting/service-front）
  await svcQ(
    `INSERT INTO kb_collections (id, workspace_id, name, description)
     VALUES ('kbc-consulting-service', $1, '咨询服务目录', '服务项/SLA/预约与报告通道')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );
  await svcQ(
    `INSERT INTO kb_collections (id, workspace_id, name, description)
     VALUES ('kbc-consulting-faq', $1, '客户常见问答', '服务范围/保密与数据安全/收费合作/资料配合四类高频问题')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID],
  );

  interface FaqFile { categories: Array<{ key: string; name: string; docTitle: string; items: Array<{ q: string; a: string }> }> }
  interface CatalogItem { name: string; category: string; sla?: string; note?: string; channel?: string }
  interface CatalogFile { categories: Array<{ key: string; name: string }>; items: CatalogItem[] }
  const SF_DIR = join(BUNDLE_DIR, "service-front");
  const faq = JSON.parse(readFileSync(join(SF_DIR, "faq.json"), "utf-8")) as FaqFile;
  const serviceCat = JSON.parse(readFileSync(join(SF_DIR, "service-catalog.json"), "utf-8")) as CatalogFile;

  // ① FAQ 全量入库
  let faqChunks = 0;
  for (const cat of faq.categories) {
    const docId = `kbd-cfaq-${cat.key}`;
    const md = [`# ${cat.docTitle}`, ...cat.items.map((it) => `## ${it.q}\n${it.a}`)].join("\n\n");
    await svcQ(
      `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
       VALUES ($1, $2, 'kbc-consulting-faq', $3, 'manual', NULL, 1, 'active', $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [docId, WS_ID, cat.docTitle, md, `seed-hash-cfaq-${cat.key}`, new Date(Date.now() - 15 * 86400000).toISOString()],
    );
    for (let i = 0; i < cat.items.length; i++) {
      const it = cat.items[i]!;
      const r = await svcQ(
        `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (SELECT 1 FROM kb_chunks WHERE document_id=$2 AND chunk_index=$3)`,
        [WS_ID, docId, i, it.q, it.a],
      );
      faqChunks += (r as unknown as { rowCount: number }).rowCount ?? 0;
    }
  }

  // ② 服务目录入库
  {
    const catName = (k: string) => serviceCat.categories.find((c) => c.key === k)?.name ?? k;
    const groups = new Map<string, CatalogItem[]>();
    for (const it of serviceCat.items) {
      const arr = groups.get(it.category) ?? [];
      arr.push(it);
      groups.set(it.category, arr);
    }
    const md = ["# 咨询服务目录", ...[...groups.entries()].map(([k, arr]) =>
      `## ${catName(k)}\n${arr.map((i) => `- ${i.name}（SLA：${i.sla ?? "即时"}${i.note ? `，${i.note}` : ""}）`).join("\n")}`,
    )].join("\n\n");
    await svcQ(
      `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
       VALUES ('kbd-csvc-catalog', $1, 'kbc-consulting-service', '咨询服务目录', 'manual', NULL, 1, 'active', $2, 'seed-hash-service-catalog', $3)
       ON CONFLICT (id) DO NOTHING`,
      [WS_ID, md, new Date(Date.now() - 15 * 86400000).toISOString()],
    );
    let idx = 0;
    for (const [k, arr] of groups) {
      const content = arr.map((i) => `${i.name}：SLA ${i.sla ?? "即时"}${i.note ? `；${i.note}` : ""}`).join("。");
      await svcQ(
        `INSERT INTO kb_chunks (workspace_id, document_id, chunk_index, heading, content)
         SELECT $1, 'kbd-csvc-catalog', $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM kb_chunks WHERE document_id='kbd-csvc-catalog' AND chunk_index=$2)`,
        [WS_ID, idx++, catName(k), content],
      );
    }
  }
  await svcQ(
    `INSERT INTO kb_sources (id, workspace_id, url, fingerprint, last_crawled_at, schedule_cron, status)
     VALUES ('kbs-eagle-site', $1, 'https://www.eagle-consulting.example', 'fp-e77c', $2, '0 3 * * *', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 86400000).toISOString()],
  );
  console.log(`✓ 知识库全量预置：FAQ ${faq.categories.length} 类（新入库 ${faqChunks} 块）+ 服务目录 ${serviceCat.items.length} 项`);

  // 会话 1：王总（常年顾问）——月报问答（高置信带引用）
  await svcQ(
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel, status, created_at, last_message_at)
     VALUES ('cv-eagle-001', $1, 'cu-wanghc', 'wechat-mini', 'open', $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 5 * 3600000).toISOString(), new Date(Date.now() - 5 * 3600000 + 90000).toISOString()],
  );
  const conv1Msgs: [string, string, string, number, string, number][] = [
    ['user', '这个月月报什么时候能看？', '', 0, '[]', 0],
    ['assistant', '王总早。8 月月度观察报告初稿昨夜已生成，今早已经随清晨决策包送陈鹰老师审核（结论涉及毛利异动，按规矩必须他本人拍板）。预计今天中午前推送给您。先说结论：营收环比 -6%，毛利率降到 25%，主要是原材料涨价加低毛利订单占比上升。', 'kb_qa', 0.94, JSON.stringify([{ documentTitle: '服务范围与方式', heading: '常年顾问和一次性咨询有什么区别？', content: '常年顾问是认知常流：指标异动、行业变化、行动项逾期都会被及时发现，每月有观察报告。' }]), 26],
    ['user', '我们厂的交付周期现在多少天了？', '', 0, '[]', 0],
    ['assistant', '【行动账本】交付周期专项：7 月均值 31 天（专项启动时 42 天）。当前进行中行动项 2 项：排产规则 V2 试运行（9/15 到期，正常）；交付周期月度复盘（已逾期 2 天，已自动升级提醒计划部）。', 'kb_qa', 0.92, '[]', 22],
  ];
  for (let i = 0; i < conv1Msgs.length; i++) {
    const m = conv1Msgs[i]!;
    await svcQ(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms, created_at)
       SELECT $1,'cv-eagle-001',$2,$3,$4,$5,$6::jsonb,$7,$8
       WHERE NOT EXISTS (SELECT 1 FROM c_messages WHERE conversation_id='cv-eagle-001' AND content=$3)`,
      [WS_ID, m[0], m[1], m[2] || null, m[3] || null, m[4], m[5] || null, new Date(Date.now() - 5 * 3600000 + i * 30000).toISOString()],
    );
  }

  // 会话 2：刘总（诊断期）——多模态：发报表截图，系统自动解析归档
  await svcQ(
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel, status, created_at, last_message_at)
     VALUES ('cv-eagle-002', $1, 'cu-liucy', 'wechat-mini', 'open', $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 9 * 3600000).toISOString(), new Date(Date.now() - 9 * 3600000 + 120000).toISOString()],
  );
  const conv2Msgs: [string, string, string, number, string, number][] = [
    ['user', '[图片] 8月各门店营收汇总表截图.xlsx 拍照版', '', 0, '[]', 0],
    ['assistant', '收到，已为您解析这张报表截图：12 家门店 8 月合计营收 445 万（环比 -3.3%）。两处与历史口径对不上，已自动标注：①春熙路店 8 月数据缺失；②双流店环比 -18%，与店长访谈中「客流稳定」的说法矛盾，已列入陈鹰老师下次访谈的追问清单。资料已脱敏归档进贵司企业档案（文件库分区）。', 'kb_qa', 0.91, '[]', 34],
    ['user', '剩下的访谈什么时候安排？', '', 0, '[]', 0],
    ['assistant', '【诊断期进度】访谈 8/12 场已完成，剩余 4 场店长访谈计划 9 月 8 日前完成。提纲已按角色分层拟好，会提前 24 小时发您确认。纪要对外版默认脱敏。', 'kb_qa', 0.93, '[]', 21],
  ];
  for (let i = 0; i < conv2Msgs.length; i++) {
    const m = conv2Msgs[i]!;
    await svcQ(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms, created_at)
       SELECT $1,'cv-eagle-002',$2,$3,$4,$5,$6::jsonb,$7,$8
       WHERE NOT EXISTS (SELECT 1 FROM c_messages WHERE conversation_id='cv-eagle-002' AND content=$3)`,
      [WS_ID, m[0], m[1], m[2] || null, m[3] || null, m[4], m[5] || null, new Date(Date.now() - 9 * 3600000 + i * 40000).toISOString()],
    );
  }

  // 会话 3：张总（体检期）——体检报告进度 + 紧急留言（夜间第一响应示例）
  await svcQ(
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel, status, created_at, last_message_at)
     VALUES ('cv-eagle-003', $1, 'cu-zhangxl', 'h5', 'open', $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [WS_ID, new Date(Date.now() - 30 * 3600000).toISOString(), new Date(Date.now() - 2 * 3600000).toISOString()],
  );
  const conv3Msgs: [string, string, string, number, string, number][] = [
    ['user', '我们的体检报告出来了吗？', '', 0, '[]', 0],
    ['assistant', '张总好，贵司的快速体检报告已生成：核心发现是销售漏斗在 demo→POC 环节转化 11%（行业参考 25%）。报告解读会已排在 9 月 3 日，会前材料已备好。', 'kb_qa', 0.95, '[]', 19],
    ['user', '[语音] 深夜留言：明天董事会要看这个数据，我心里没底……', '', 0, '[]', 0],
    ['assistant', '张总，我在。您的留言已收到并转写存档。这类董事会汇报场景按规矩需要陈鹰老师亲自支持——我已将您的诉求标记为紧急并同步叫醒他，同时先为您整理了三页「董事会问答预案」要点放在会话里。他会在明早 7 点前回复您确认。', 'service_request', 0.9, '[]', 28],
  ];
  for (let i = 0; i < conv3Msgs.length; i++) {
    const m = conv3Msgs[i]!;
    await svcQ(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms, created_at)
       SELECT $1,'cv-eagle-003',$2,$3,$4,$5,$6::jsonb,$7,$8
       WHERE NOT EXISTS (SELECT 1 FROM c_messages WHERE conversation_id='cv-eagle-003' AND content=$3)`,
      [WS_ID, m[0], m[1], m[2] || null, m[3] || null, m[4], m[5] || null, new Date(Date.now() - 30 * 3600000 + i * 40000).toISOString()],
    );
  }

  // 工单 ×3（预约深谈/资料提交已办结/紧急呼叫升级）
  const tickets: [string, string, string | null, string, string, string, string, string | null, string | null, number][] = [
    ['tck-eagle-001', 'cu-wanghc', 'cv-eagle-001', 'meeting', '预约下周季度复盘会（视频）', 'assigned', 'normal', '客户成功', '林助理', 3],
    ['tck-eagle-002', 'cu-liucy', 'cv-eagle-002', 'material', '8 月门店营收报表截图已归档', 'done', 'normal', '访谈秘书', 'agt-interview-secretary', 9],
    ['tck-eagle-003', 'cu-zhangxl', 'cv-eagle-003', 'urgent', '深夜紧急：董事会汇报预案支持', 'done', 'high', '主理咨询师', '陈鹰', 26],
  ];
  for (const t of tickets) {
    await svcQ(
      `INSERT INTO c_tickets (id, workspace_id, c_user_id, conversation_id, kind, title, payload, status, priority, dept, assignee, sla_due_at, result, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (id) DO NOTHING`,
      [t[0], WS_ID, t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8],
       new Date(Date.now() + 2 * 3600000).toISOString(),
       t[5] === 'done' ? JSON.stringify({ text: t[3] === 'material' ? '报表截图已解析、矛盾点已标注并归档入企业档案。' : '陈鹰已回电确认预案，董事会汇报支持完成。', rating: { score: 5 } }) : null,
       `seed-${t[0]}`, new Date(Date.now() - t[9] * 3600000).toISOString()],
    );
  }
  const tl: [string, string, string, string, string, number][] = [
    ['tck-eagle-001', 'create', 'c_user', 'cu-wanghc', '对话中预约复盘会', 180],
    ['tck-eagle-001', 'assign', 'agent', 'agt-service-desk', '智能分派 → 客户成功', 179],
    ['tck-eagle-002', 'create', 'c_user', 'cu-liucy', '发送报表截图自动建单', 540],
    ['tck-eagle-002', 'assign', 'agent', 'agt-service-desk', '智能分派 → 访谈秘书（多模态解析）', 539],
    ['tck-eagle-002', 'complete', 'agent', 'agt-interview-secretary', '解析完成：2 处口径异常已标注入档', 520],
    ['tck-eagle-003', 'create', 'c_user', 'cu-zhangxl', '深夜语音留言触发紧急通道', 1560],
    ['tck-eagle-003', 'assign', 'agent', 'agt-night-watch', '守夜巡检第一响应：安抚+信息收集', 1558],
    ['tck-eagle-003', 'start', 'staff', '陈鹰', '已升级叫醒主理，回电确认', 1540],
    ['tck-eagle-003', 'complete', 'staff', '陈鹰', '董事会问答预案支持完成', 1500],
    ['tck-eagle-003', 'rate', 'c_user', 'cu-zhangxl', '满意度 5 星', 1400],
  ];
  for (const e of tl) {
    await svcQ(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail, created_at)
       SELECT $1,$2,$3,$4,$5,$6::jsonb,$7
       WHERE NOT EXISTS (SELECT 1 FROM c_ticket_events WHERE ticket_id=$2 AND action=$3 AND actor_id=$4)`,
      [WS_ID, e[0], e[1], e[2], e[3], JSON.stringify({ note: e[4] }), new Date(Date.now() - e[5] * 60000).toISOString()],
    );
  }

  // 推送箱：受理 + 办结 + 月报推送 + 续约季价值报告预告
  const notifs: [string, string, string, string, number][] = [
    ['ntf-eagle-001', 'cu-wanghc', 'report.monthly', '您的《恒昌机械 8 月月度观察报告》已送达：营收环比 -6%、毛利率 25%，含 2 条建议动作与下月关注清单。', 60],
    ['ntf-eagle-002', 'cu-liucy', 'ticket.completed', '您的资料「8 月门店营收报表截图」已处理：2 处口径异常已标注，已归档进企业档案。', 510],
    ['ntf-eagle-003', 'cu-zhangxl', 'ticket.accepted', '您的紧急事项已受理：守夜班组已先行响应，陈鹰将于明早 7 点前亲自回复。', 1555],
    ['ntf-eagle-004', 'cu-wanghc', 'report.annual.preview', '续约季预告：您的《年度价值报告》草稿已生成（交付周期 42→31 天、避免无效投入 80 万、毛利预警挽回 35 万/年），陈鹰将在复盘会与您逐条核对。', 30],
  ];
  for (const n of notifs) {
    await svcQ(
      `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status, created_at)
       SELECT $1,$2,'wechat-mini',$3,$4::jsonb,'mock','delivered',$5
       WHERE NOT EXISTS (SELECT 1 FROM c_notifications WHERE c_user_id=$2 AND kind=$3 AND payload->>'text'=$6)`,
      [WS_ID, n[1], n[2], JSON.stringify({ text: n[3], mock: true }), new Date(Date.now() - n[4] * 60000).toISOString(), n[3]],
    );
  }
  console.log("✓ 咨询服务前台运行态：客户用户×3 / 知识库（FAQ+目录+配合指引）/ 会话×3（含多模态截图+语音）/ 工单×3 / 通知×4");

  // 客户会员与服务合同（沿用 demo_members / demo_orders 通用结构，咨询语义）
  await svcQ(
    `INSERT INTO demo_members (workspace_id, member_id, name, tier, points)
     VALUES
       ($1, 'ENT-HC-001', '恒昌机械·王总', '常年顾问客户', 0),
       ($1, 'ENT-CY-002', '川渝味道·刘总', '诊断期客户', 0)
     ON CONFLICT (workspace_id, member_id) DO NOTHING`,
    [WS_ID],
  );
  await svcQ(
    `INSERT INTO demo_orders (workspace_id, order_id, member_id, room_type, check_in, check_out, amount_fen, status)
     VALUES
       ($1, 'HT-2025-HC-001', 'ENT-HC-001', '常年顾问·年度', $2, $3, 11760000, '服务中'),
       ($1, 'HT-2026-CY-001', 'ENT-CY-002', '深度诊断·标准', $4, $5, 6800000, '服务中')
     ON CONFLICT (workspace_id, order_id) DO NOTHING`,
    [WS_ID,
      new Date(Date.now() - 400 * 86400000).toISOString(), new Date(Date.now() + 122 * 86400000).toISOString(),
      new Date(Date.now() - 25 * 86400000).toISOString(), new Date(Date.now() + 35 * 86400000).toISOString()],
  );

  // L2 收口：显式 COMMIT
  await gw.query("COMMIT");
  await gw.end();
  console.log("eagle 鹰眼咨询种子数据完成 ✅（鹰眼咨询所演示数据集就绪）");
}

main().catch((err) => {
  console.error("seed-consulting 失败：", err?.message ?? err);
  process.exit(1);
});
