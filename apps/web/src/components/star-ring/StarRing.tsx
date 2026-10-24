/**
 * 织伴 StarRing · 全局唯一对话框（右侧固定通栏 AskRail 形态；AI 原生工作空间 · 交互层）
 *
 * 交互策略（2026-08-25 定稿）：
 *  - PC 端：右侧固定通栏对话框——贴界面最右、从顶到底的瘦长完整对话模块，任何页面常驻；
 *    可收起为 56px 图标条（收起后随时展开，不是隐藏）
 *  - 移动端 B 端：底部 Tab 首个即对话（生产移动壳落地时按此口径；demo 已镜像）
 *  - 栏内构成：头部（AI 助手 + 收起）/ 消息流 / 情境快捷钮 / 输入栏
 *  - 上下文感知：useLocation 读当前路由预置情境 chips（/p22 服务前台、/p13 订单、/p15 口碑等）
 *  - 输入分流：问句走 ask（threads.dispatch 意图路由 → ask 即时应答，P2 同口径）；明确任务走 quest（立项 → P2）
 *  - 2026-09-21 产品所有者口径（本机单人运行）：基座通用审批环节已移除——不再显示待审批角标、
 *    不再提供框内一键批准；业务链路自带的关卡（如视频管线 G1–G10、定妆照确认）由各自业务页面就地放行
 *  - ⌘K / Ctrl+K 聚焦输入框；调用失败优雅降级（✗ 回执上屏，输入保留可重试 §9.3）
 *  - 布局协作：经 window 自定义事件 askrail-width 通知 Bridge 预留右侧空间（320px / 56px）
 *
 * 三合一合并（2026-09-20，产品方案「一个框、四种落点」）：
 *  - 唯一入口：夜班中心底部「班组留言」输入与小织浮层「聊聊」面板全部下线，输入并入本栏；
 *  - 四种落点（全部复用既有后端，不新造语义）：
 *      问   → threads.dispatch(ask)：即时应答，不建任务；
 *      派   → threads.dispatch(quest/agent)：立项回执 + 去任务中心；
 *      留言 → 夜班上下文走 nightShift.note、任务线程上下文走 threads.note：只写账本，不派活不回答；
 *      推进 → threads.run：仅任务线程上下文可用（带权限/围栏/回执三态）；
 *      个人 → service.secretary.chat：记事/提醒/找人的「我的」域（原小织面板能力）。
 *  - 落点可见：每条消息气泡带落点标签与回执三态；分类不确定时给「问 / 派 / 留言」确认条，可一键纠正；
 *  - 外部唤起：其它页面通过 window 事件 `workloom:assistant-intent`
 *      （detail: { intent, domain?, presetText?, focus? }）把用户送进本栏，页面不再自带输入框。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentAvatar } from "../AgentAvatar";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AgentActionMessage, HumanBubble } from "../hud/messages";
import { AIFeedback } from "../AIFeedback";
import {
  Icon,
  clientChineseText,
  clientIdentifierText,
  isNavigationActive,
  useManagedSurface,
} from "@workloom/ui";
import { clientNaturalText } from "../../lib/clientText";
import { NAV_ENTRIES } from "../../shell/NavMenu";
import { COMMON_STATUS_TEXT, dictText, THREAD_MODE_TEXT } from "../../lib/display";
import { sharedLayoutPixels } from "../../lib/useAskRail";
import { useNavigationAccess } from "../../shell/NavigationAccess";
import { operationFailure } from "../../lib/ui-state";
import {
  beginDispatchAttempt, finishSettledDispatch, readDispatchAttempt, updateDispatchAttempt,
  type DispatchAttempt,
} from "../../extensions/consulting/dispatch-attempt";
import { consultingTaskStatusText, type ConsultingTaskView } from "../../extensions/consulting/task-client";

/** 路由 → 情境快捷钮（前缀匹配；越靠上越优先） */
const CONTEXT_CHIPS: Array<[prefix: string, chips: string[]]> = [
  ["/service", ["试试知识库检索", "今天工单有什么超时风险"]],
  ["/p22", ["试试知识库检索", "今天工单有什么超时风险"]],
  ["/tasks/", ["这项任务卡在哪一步", "预估剩余积分消耗"]],
  ["/p2", ["这线程卡在哪一步", "预估剩余积分消耗"]],
  ["/tasks", ["昨夜经营有什么异常", "今天优先级最高的三件事"]],
  ["/p1", ["昨夜经营有什么异常", "今天优先级最高的三件事"]],
];
const DEFAULT_CHIPS = ["汇报当前经营概况", "今天有哪些业务关卡需要我确认"];

interface RingMsg {
  id: number;
  role: "human" | "agent";
  /** 文本气泡内容；纯卡片消息（长任务）可为空 */
  text?: string;
  action?: string;
  refId?: string;
  receipt?: "synced" | "unverified" | "failed";
  linkTo?: string;
  /** 落点标签（三合一方案的「结果可见」）：问/派/留言/推进/个人 */
  intent?: RailIntent;
  /** 长周期任务卡片（派活即出卡，轮询与员工头顶任务状态同源同步） */
  card?: TaskCard;
  /** ask 应答的原始提问（👎 升级重答入参，v3.0 反馈环） */
  prompt?: string;
}

/** 长周期任务卡片：右栏窄，故只放「图标 + 标题 + 状态徽标 + 一行摘要 + 跳转」 */
interface TaskCard {
  threadId: string;
  title: string;
  status: string;
  mode?: string;
  stepsDone?: number;
  stepsTotal?: number;
  updatedAt?: string;
  summary?: string;
  /** GR-15 ③：派遣时的连接器覆盖度提示（无连接器 → 将以未核实收尾） */
  warnings?: string[];
  /** GR-17：执行失败原因（工具异常/无回执等）——卡片直接可见，不用进任务页才知道 */
  error?: string;
  /**
   * X-02（第四轮实测，P0）：挂起步骤的审批号——服务端一直在返回，前端此前**零消费**，
   * 于是"卡片显示待您拍板、却点哪里都不知道"（客户现场"任务卡住"投诉的直接来源）。
   */
  approvalId?: string;
  /** 熔断告警（围栏 block）——与失败原因同面展示 */
  blockedBy?: string;
  /** 未核实步骤（无回执，E3.7） */
  unverified?: string[];
  /** 归属岗位（举一反三/X-06：卡片上就能看出活派给了谁） */
  presetKey?: string;
  currentAction?: string;
  executionSource?: "consulting-report" | "generic";
  consultingStatus?: string;
  artifactAvailable?: boolean;
  sourceCount?: number;
  detailLoaded?: boolean;
  readError?: string;
}

const TASK_STATUS_TEXT: Record<string, string> = {
  queued: "排队中", running: "进行中", pending_review: "等待业务关卡放行",
  completed: "已完成", failed: "失败", paused: "已暂停", cancelled: "已停止",
};

function taskStatusClass(status: string): string {
  if (status === "completed") return "border-go/50 text-go";
  if (status === "failed") return "border-alert/60 text-alert";
  if (status === "pending_review" || status === "paused") return "border-amber-500/60 text-amber-600";
  if (status === "running") return "border-gline text-gold";
  return "border-line text-ink3";
}

function taskCardSummary(card: TaskCard): string {
  if (card.consultingStatus === "draft_ready") return "内部报告草稿已生成，待人工审阅";
  if (card.consultingStatus) return consultingTaskStatusText(card.consultingStatus);
  if (card.summary) return card.summary;
  if (card.status === "completed") return `全部 ${card.stepsTotal ?? card.stepsDone ?? 0} 步已完成`;
  if (card.status === "failed") return "执行失败，可进入任务详情查看原因";
  if (card.status === "pending_review") return "有步骤正在等待业务关卡放行（在对应业务页面处理）";
  if (typeof card.stepsTotal === "number" && card.stepsTotal > 0) return `已执行 ${card.stepsDone ?? 0}/${card.stepsTotal} 步`;
  return "已派发，等待执行";
}

/** 三合一落点与域 */
type RailIntent = "ask" | "task" | "note" | "advance" | "personal";
type RailDomain = "work" | "mine";

const INTENT_LABEL: Record<RailIntent, string> = {
  ask: "问 · 应答",
  task: "派 · 立项",
  note: "留言 · 入账",
  advance: "推进",
  personal: "小织 · 我的",
};

/** 前端意图分类（确定性规则；模型分类仍由 threads.dispatch 的服务端路由兜底） */
export function classifyRailIntent(
  text: string,
  ctx: { domain: RailDomain; threadId: string | null; nightChannel: boolean },
): RailIntent {
  const t = text.trim();
  if (ctx.domain === "mine") return "personal";
  if (/^(记住|帮我记住|记一下|提醒我|帮我提醒)/.test(t)) return "personal";
  if (/(^|\s)(给.{0,10}留言|留言[:：]|留个言|记一笔|备注[:：])/.test(t) || /^(留言|备注)/.test(t)) return "note";
  if (ctx.threadId && /^(继续|接着|推进|下一步|往下)/.test(t)) return "advance";
  // 夜班频道里不带疑问句/动作词的陈述句，按「给班组的留言」处理（原底部输入框的语义）
  if (ctx.nightChannel && !isQuestion(t) && !hasActionVerb(t)) return "note";
  if (isQuestion(t)) return "ask";
  return "task";
}

const ACTION_VERB = /执行|处理|提交|同步|导入|导出|更新|生成|采集|取消|修改|调整|发布|创建|删除|安装|卸载|暂停|恢复|开启|派单|起草|撰写|做一|出一/;
function hasActionVerb(text: string): boolean { return ACTION_VERB.test(text); }
interface DispatchResult {
  kind?: string;
  question?: string | null;
  mode?: string;
  answer?: string;
  threadId?: string;
  status?: string;
  /** runImmediately 的 Quest 执行回执（步数/总数；pending_review=有步骤等待业务关卡放行） */
  stepsDone?: number;
  stepsTotal?: number;
  requestId?: string;
  executionSource?: "consulting-report" | "generic";
  error?: string;
  current_action?: string | null;
  warnings?: string[];
  pendingApprovalId?: string;
  presetKey?: string;
  blockedBy?: string;
  unverified?: string[];
}

function ClapperIcon({ size = 24 }: { size?: number }) {
  return <Icon name="play" size={size} />;
}

/**
 * 长周期任务卡片（右侧窄栏专用，2026-09-20）：
 *   图标（按状态）+ 主标题（任务名，单行截断）+ 状态徽标 + 一行摘要 + 步骤/时间 + 「查看任务 →」；
 *   整卡可点 → 任务详情（与员工头顶任务牌同一线程状态机）。
 *   2026-09-21 产品所有者口径（本机单人运行）：卡片不再附「批准并继续」按钮——基座通用审批环节已移除。
 */
function TaskCardView({ card, onOpen, onReport, highlight = false }: {
  card: TaskCard;
  onOpen: () => void;
  onReport: () => void;
  /** 任务完成播报期间（小织的魔法棒指过来）卡片发光，视线落在同一处 */
  highlight?: boolean;
}) {
  const icon = card.status === "completed" ? "check"
    : card.status === "failed" ? "error"
      : card.status === "pending_review" ? "warning"
        : "rocket";
  const iconClass = card.status === "completed" ? "text-go"
    : card.status === "failed" ? "text-alert"
      : card.status === "pending_review" ? "text-amber-500" : "text-gold";
  const stamp = card.updatedAt ? new Date(card.updatedAt).toTimeString().slice(0, 5) : "";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); } }}
      title="打开任务详情"
      className={`cursor-pointer rounded-xl border bg-bg850/85 p-2.5 text-left transition-all hover:border-gline ${
        highlight ? "border-gold/70 shadow-[0_0_26px_rgba(255,214,138,.35)]" : "border-line"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={icon} size={15} className={iconClass} />
        {/* 截断必须给完整文本提示（基座 UI 治理门禁：截断/单行内容要有 title 兜底） */}
        <span className="min-w-0 flex-1 truncate text-body font-bold text-ink" title={card.title}>{card.title}</span>
        <span className={`min-w-0 max-w-[55%] shrink-0 break-words rounded border px-1.5 text-center text-body ${taskStatusClass(card.status)}`}>
          {/* 动态值必须先经中文映射（门禁：工程代号/原始字段不上屏） */}
          {card.consultingStatus ? consultingTaskStatusText(card.consultingStatus) : dictText(TASK_STATUS_TEXT, card.status)}
        </span>
      </div>
      <div className="mt-1 break-words text-body text-ink3">{taskCardSummary(card)}</div>
      {card.currentAction && <div className="mt-1 break-words text-body text-ink2">当前动作：{clientNaturalText(card.currentAction, "当前动作待确认")}</div>}
      {card.executionSource && <div className="mt-1 text-body text-ink3">执行来源：{card.executionSource === "consulting-report" ? "公开资料报告流程" : "通用任务流程"}{card.sourceCount !== undefined ? ` · 已冻结 ${card.sourceCount} 项来源` : ""}</div>}
      {card.readError && <div role="alert" className="mt-1 text-body text-alert">{card.readError} 保留最后已知状态，正在重新读取。</div>}
      {card.presetKey && (
        <div className="mt-0.5 text-body text-ink3">派给：{clientIdentifierText(card.presetKey)} · {card.mode === "agent" ? "逐步确认" : card.mode === "ask" ? "问答" : "自主执行"}</div>
      )}
      {/* GR-15/GR-17：连接器提示与失败原因直接上卡（不再"跑完才知道"） */}
      {card.warnings?.map((w) => (
        <div key={w} className="mt-1 flex items-center gap-1 rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-body text-warn">
          <Icon name="warning" size={12} label="提示" />{w}
        </div>
      ))}
      {card.blockedBy && (
        <div className="mt-1 flex items-center gap-1 rounded border border-alert/40 bg-alert/10 px-1.5 py-0.5 text-body text-alert">
          <Icon name="lock" size={12} label="围栏熔断" />围栏熔断：{card.blockedBy}
        </div>
      )}
      {card.unverified?.length ? (
        <div className="mt-1 flex items-center gap-1 rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-body text-warn">
          <Icon name="warning" size={12} label="未核实" />{card.unverified.join("/")} 无回执，标「未核实」（对账前不重发）
        </div>
      ) : null}
      {card.error && (
        <div className="mt-1 flex items-center gap-1 rounded border border-alert/40 bg-alert/10 px-1.5 py-0.5 text-body text-alert">
          <Icon name="error" size={12} label="失败" />{card.error}
        </div>
      )}
      {card.artifactAvailable && <button type="button" onClick={event => { event.stopPropagation(); onReport(); }} className="mt-2 w-full rounded border border-gline px-2 py-1 text-body text-gold hover:bg-gold/10">打开报告</button>}
      {/**
       * X-02（第四轮实测，P0）：挂起任务必须给出**可点的**下一秒动作——去审批直达。
       * 链接带 ?apr= 锚点，任务页据此高亮并滚动到该审批卡（GR-24）。
       */}
      {card.approvalId && card.status === "pending_review" && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className="mt-1.5 w-full rounded border border-amber-400/60 bg-amber-500/15 px-2 py-1 text-body font-bold text-amber-500 hover:bg-amber-500/25"
        >
          去审批（{card.approvalId.slice(-8)}）→
        </button>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2 text-body">
        <span className="text-ink3">
          {typeof card.stepsTotal === "number" && card.stepsTotal > 0
            ? `步骤 ${card.stepsDone ?? 0}/${card.stepsTotal}`
            : "任务"}
          {stamp ? ` · ${stamp}` : ""}
        </span>
        <span className="shrink-0 text-holo">查看任务 →</span>
      </div>
    </div>
  );
}

/** 布局事件：通知 Bridge 预留右侧空间（同时在 window 落一份当前值，供后挂载的页面初始化读取） */
function emitRailWidth(w: number) {
  (window as unknown as { __askRailW: number }).__askRailW = w;
  document.documentElement.style.setProperty("--workloom-ask-rail-width", `${w}px`);
  window.dispatchEvent(new CustomEvent("askrail-width", { detail: { width: w } }));
}

export function StarRing() {
  const { identityKey, status, bundle } = useNavigationAccess();
  return <ScopedStarRing key={`${identityKey}:${bundle?.bundleId ?? "pending"}`} identityKey={identityKey}
    accessReady={status === "ready"} queueTasks={bundle?.bundleId === "consulting"} />;
}

function ScopedStarRing({ identityKey, accessReady, queueTasks }: { identityKey: string; accessReady: boolean; queueTasks: boolean }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  // 首次提交就必须与当前视口一致；若等 useEffect 再收起，窄屏会先闪现一帧
  // 全宽助手，同时令主区从展开栏预留宽度跳到紧凑栏宽度。
  const [collapsed, setCollapsed] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [hidden, setHidden] = useState(false);
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [msgs, setMsgs] = useState<RingMsg[]>([]);
  const [attempt, setAttempt] = useState<DispatchAttempt | null>(null);
  const [dispatchNotice, setDispatchNotice] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** 三合一：域（工作区 / 我的）与下一条落点预设（由页面 chip / 小织头像唤起时注入） */
  const [domain, setDomain] = useState<RailDomain>("work");
  const [presetIntent, setPresetIntent] = useState<RailIntent | null>(null);
  /** 分类不确定时的落点确认条（误路由一键纠正） */
  const [confirm, setConfirm] = useState<{ text: string; options: RailIntent[] } | null>(null);
  const msgSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 供外部事件（页面 chip）拿到最新的发送函数（事件监听只挂一次，不能闭包旧 send） */
  const sendRef = useRef<((text: string, intent?: RailIntent) => Promise<void>) | null>(null);
  /** 页面 chip 可指定执行岗位（如任务中心的快捷目标） */
  const presetKeyRef = useRef<string | null>(null);
  /** GR-20：待用户补充的分流目标（clarify 往返用；下一条输入与其合并） */
  const pendingClarifyRef = useRef<string | null>(null);
  const collapsedTriggerRef = useRef<HTMLButtonElement | null>(null);
  const railSurface = useManagedSurface<HTMLDivElement>({
    open: !hidden && !collapsed,
    kind: "assistant-rail",
    onDismiss: () => setCollapsed(true),
    modal: compactViewport,
    focusOnOpen: compactViewport,
    restoreFocusOnClose: compactViewport,
    initialFocusRef: inputRef,
    returnFocusRef: collapsedTriggerRef,
  });

  const chips = CONTEXT_CHIPS.find(([p]) => pathname.startsWith(p))?.[1] ?? DEFAULT_CHIPS;
  const pageLabel = NAV_ENTRIES.find((entry) => isNavigationActive(entry, pathname))?.title ?? "当前页面";
  /** 上下文：任务线程 id（/tasks/:id）与夜班频道（/night）——决定「留言 / 推进」是否可用 */
  const ctxThreadId = (() => {
    const m = /^\/tasks\/([^/?#]+)/.exec(pathname);
    return m ? decodeURIComponent(m[1]!) : null;
  })();
  const nightChannel = pathname.startsWith("/night");

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => {
      setCompactViewport(query.matches);
      if (query.matches) setCollapsed(true);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const reset = () => {
      setHidden(false);
      setCollapsed(window.matchMedia("(max-width: 820px)").matches);
    };
    const setVisibility = (event: Event) => {
      const action = (event as CustomEvent<"show" | "hide" | "toggle">).detail;
      if (action === "show") { setHidden(false); setCollapsed(false); }
      else if (action === "hide") setHidden(true);
      else setHidden((value) => !value);
    };
    window.addEventListener("workloom:reset-layout", reset);
    window.addEventListener("workloom:assistant-visibility", setVisibility);
    return () => {
      window.removeEventListener("workloom:reset-layout", reset);
      window.removeEventListener("workloom:assistant-visibility", setVisibility);
    };
  }, []);

  /* ---------- 布局协作：挂载/收起状态变化时通知 Bridge ---------- */
  useEffect(() => {
    emitRailWidth(hidden ? 0 : sharedLayoutPixels(
      compactViewport || collapsed ? "--wl-assistant-compact" : "--wl-assistant-expanded",
    ));
  }, [collapsed, compactViewport, hidden]);
  useEffect(() => () => emitRailWidth(0), []);

  /* ---------- ⌘K / Ctrl+K 聚焦输入框 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHidden(false);
        setCollapsed(false);
        // 收起态先展开、输入框下一帧才挂载——两次重试保证 ⌘K 一定落到输入框
        setTimeout(() => inputRef.current?.focus(), 60);
        setTimeout(() => inputRef.current?.focus(), 240);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- 外部唤起：页面 chip / 小织头像把用户送进本栏并预置落点 ---------- */
  useEffect(() => {
    const onIntent = (event: Event) => {
      const detail = (event as CustomEvent<{ intent?: RailIntent; domain?: RailDomain; presetText?: string; presetKey?: string }>).detail ?? {};
      setHidden(false);
      setCollapsed(false);
      if (detail.domain) setDomain(detail.domain);
      if (detail.intent === "personal") setDomain("mine");
      if (detail.intent && detail.intent !== "personal") setPresetIntent(detail.intent);
      presetKeyRef.current = detail.presetKey ?? null;
      if (detail.presetText) {
        // 页面快捷 chip：直接以该落点发出（rails 的全部回执语义不变）
        setTimeout(() => void sendRef.current?.(detail.presetText!, detail.intent), 120);
      } else {
        setTimeout(() => inputRef.current?.focus(), 80);
      }
    };
    window.addEventListener("workloom:assistant-intent", onIntent);
    return () => window.removeEventListener("workloom:assistant-intent", onIntent);
  }, []);

  /* ---------- 新消息滚到底 ---------- */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, collapsed]);

  const pushMsg = useCallback((m: Omit<RingMsg, "id">) => {
    if (!alive.current) return;
    const id = ++msgSeq.current;
    setMsgs((cur) => [...cur, { ...m, id }]);
  }, []);

  const recordAttempt = useCallback((requestId: string, state: DispatchAttempt["state"], threadId?: string) => {
    const prior = readDispatchAttempt(identityKey);
    if (prior?.requestId !== requestId || (prior.state === "settled" && state !== "settled")) return;
    updateDispatchAttempt(identityKey, requestId, { state, ...(threadId ? { threadId } : {}) });
    if (alive.current) setAttempt(readDispatchAttempt(identityKey));
  }, [identityKey]);

  const showDispatchResult = useCallback((result: DispatchResult, requestId: string, text = "恢复的原提交") => {
    if (!alive.current) return;
    if (result.kind === "dispatching") {
      recordAttempt(requestId, "dispatching");
      setDispatchNotice("正在确认原提交结果；服务端已认领，当前只查询原请求，不会另建任务。");
      return;
    }
    if (result.kind === "not-found") {
      setDispatchNotice("正在确认原提交结果：暂未查询到服务端记录。请重新输入相同目标并提交，将沿用原请求标识。");
      return;
    }
    if (result.kind === "failed") {
      recordAttempt(requestId, "settled");
      setDispatchNotice(clientNaturalText(result.error, "原提交未完成，服务端尚未提供具体原因。请核对任务中心后明确新建任务。"));
      return;
    }
    if (result.kind === "clarify") {
      recordAttempt(requestId, "settled"); setDispatchNotice(null);
      setConfirm({ text, options: hasActionVerb(text) ? ["task", "note", "ask"] : ["ask", "note", "task"] });
      const routeContext = (result as { routeContext?: { goal?: string } }).routeContext;
      if (routeContext?.goal) pendingClarifyRef.current = routeContext.goal;
      pushMsg({ role: "agent", action: "落点待确认", receipt: "unverified",
        text: clientNaturalText(result.question, "请补充目标与时间；信息完整前不会创建任务。") });
      return;
    }
    if (result.mode === "ask") {
      recordAttempt(requestId, "settled", result.threadId); setDispatchNotice(null);
      pushMsg({ role: "agent", intent: "ask", action: INTENT_LABEL.ask, receipt: "unverified", refId: result.threadId,
        text: clientNaturalText(result.answer, "原提交已返回，尚无可展示的应答正文。"), ...(text !== "恢复的原提交" ? { prompt: text } : {}) });
      return;
    }
    if (!result.threadId) throw new Error("Dispatch result has no recoverable thread");
    recordAttempt(requestId, "settled", result.threadId); setDispatchNotice(null);
    const card: TaskCard = {
      threadId: result.threadId, title: text, status: result.status ?? "queued", mode: result.mode,
      stepsDone: result.stepsDone, stepsTotal: result.stepsTotal, updatedAt: new Date().toISOString(),
      warnings: result.warnings, error: result.error, currentAction: result.current_action ?? undefined,
      approvalId: result.pendingApprovalId, presetKey: result.presetKey, blockedBy: result.blockedBy,
      unverified: result.unverified, executionSource: result.executionSource, detailLoaded: false,
    };
    const id = ++msgSeq.current;
    setMsgs(current => current.some(message => message.card?.threadId === result.threadId)
      ? current : [...current, { id, role: "agent", intent: "task", card }]);
  }, [recordAttempt, pushMsg]);

  useEffect(() => {
    if (!accessReady) return;
    try { setAttempt(readDispatchAttempt(identityKey)); }
    catch (error) { setDispatchNotice(error instanceof Error ? error.message : "原提交恢复标识读取失败，尚未提交新任务。"); }
  }, [identityKey, accessReady]);

  useEffect(() => {
    if (!accessReady || !attempt?.requestId) return;
    const requestId = attempt.requestId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queryOriginal = async () => {
      try {
        if (sendingRef.current) { timer = setTimeout(() => void queryOriginal(), 5000); return; }
        const result = await trpc.threads.dispatchRequest.query({ requestId }) as DispatchResult;
        if (cancelled || !alive.current || sendingRef.current) return;
        showDispatchResult(result, requestId);
      } catch (error) {
        if (!cancelled && alive.current) setDispatchNotice(`${operationFailure(error, "原提交查询")} 保留原请求标识，不会自动重发。`);
      }
      if (!cancelled && alive.current) {
        try { if (readDispatchAttempt(identityKey)?.state !== "settled") timer = setTimeout(() => void queryOriginal(), 5000); }
        catch (error) { setDispatchNotice(error instanceof Error ? error.message : "请求标识读取失败。"); }
      }
    };
    void queryOriginal();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [accessReady, attempt?.requestId, identityKey, showDispatchResult]);

  /**
   * 发送（三合一：四种落点 + 我的域）：
   *   问 → threads.dispatch(ask) 即时应答；派 → threads.dispatch(quest/agent) 立项；
   *   留言 → 夜班 nightShift.note / 线程 threads.note（只留痕）；推进 → threads.run；
   *   个人 → service.secretary.chat（原小织面板能力）。
   * forcedIntent 用于确认条/预设落点；失败保留输入并可重试（§9.3）。
   */
  const send = useCallback(async (raw: string, forcedIntent?: RailIntent) => {
    /**
     * GR-20：clarify 续答——上一轮若在等用户回答（如"走营销片还是叙事片"），
     * 这次输入必须与原目标合并回传，否则"走营销片"会被当成全新目标、与原需求脱节。
     */
    if (sendingRef.current || !accessReady) return;
    const pendingGoal = pendingClarifyRef.current;
    const text = pendingGoal ? `${pendingGoal}（用户补充：${raw.trim()}）` : raw.trim();
    if (!text) return;
    sendingRef.current = true;
    pendingClarifyRef.current = null;
    const intent: RailIntent = forcedIntent
      ?? presetIntent
      ?? classifyRailIntent(text, { domain, threadId: ctxThreadId, nightChannel });
    setConfirm(null);
    setPresetIntent(null);
    setSending(true);
    pushMsg({ role: "human", text });
    setInput("");
    let activeRequestId: string | null = null;
    try {
      await ensureDemoLogin();
      if (!alive.current) return;
      const secretary = trpc.service as unknown as {
        secretary: { chat: { mutate: (i: { text: string }) => Promise<{ reply: string }> } };
      };
      const threads = trpc.threads as unknown as {
        note: { mutate: (i: { threadId: string; text: string }) => Promise<{ eventId: string; threadId: string }> };
      };
      // ① 我的域：记事 / 提醒 / 查任务 / 找人（原小织面板，铁律：不替用户做业务决策）
      if (intent === "personal") {
        const r = await secretary.secretary.chat.mutate({ text });
        pushMsg({
          role: "agent", intent, action: INTENT_LABEL.personal, receipt: "unverified",
          text: clientNaturalText(r.reply, "小织暂时没能整理出答复，请稍后再试。"),
        });
        return;
      }
      // ② 留言：只写账本，不派活、不回答、不推进
      if (intent === "note") {
        if (ctxThreadId) {
          const r = await threads.note.mutate({ threadId: ctxThreadId, text });
          pushMsg({
            role: "agent", intent, action: INTENT_LABEL.note, receipt: "synced", refId: r.eventId,
            text: `已给任务${clientIdentifierText(ctxThreadId)}留言，写入事件账本（${clientIdentifierText(r.eventId)}）；留言只留痕，不触发执行。`,
            linkTo: `/tasks/${encodeURIComponent(ctxThreadId)}`,
          });
          return;
        }
        if (nightChannel) {
          const r = await trpc.nightShift.note.mutate({ text });
          pushMsg({
            role: "agent", intent, action: INTENT_LABEL.note, receipt: "synced", refId: r.eventId,
            text: `已给夜班班组留言，写入事件账本（${clientIdentifierText(r.eventId)}）；触发的动作仍需经过围栏。`,
            linkTo: "/night",
          });
          return;
        }
        // 没有可留言的对象：不静默改语义，给落点确认条
        setConfirm({ text, options: ["ask", "task"] });
        pushMsg({
          role: "agent", intent, action: "留言 · 需要上下文", receipt: "unverified",
          text: "当前页面不是夜班频道、也不在任务线程里，没有可留言的对象。请选择改走「问」或「派」。",
        });
        return;
      }
      // ③ 推进：仅任务线程上下文
      if (intent === "advance") {
        if (!ctxThreadId) {
          setConfirm({ text, options: ["ask", "task"] });
          pushMsg({
            role: "agent", intent, action: "推进 · 需要任务上下文", receipt: "unverified",
            text: "「推进」只在任务详情页可用。请打开具体任务，或选择改走「问」「派」。",
          });
          return;
        }
        /**
         * N-06：不把用户这句口语当规划目标——续跑复用线程既定计划（GR-01 计划持久化），
         * 以前传 goal 会把计划按"继续/推进吧"重新洗一遍（漂移、空计划、误匹配都由此而来）。
         */
        const r = await trpc.threads.run.mutate({ threadId: ctxThreadId }) as {
          status?: string; stepsDone?: number; stepsTotal?: number; error?: string; current_action?: string;
        };
        pushMsg({
          role: "agent", intent, action: `${INTENT_LABEL.advance} · 状态已返回`, receipt: "unverified", refId: ctxThreadId,
          text: `任务${clientIdentifierText(ctxThreadId)}当前状态：${dictText(COMMON_STATUS_TEXT, r.status ?? "queued")}`
            + `（${r.stepsDone ?? 0}/${r.stepsTotal ?? 0} 步）。执行仍以围栏与回执为准。`
            + (r.error ? ` ${clientNaturalText(r.error, "任务执行未完成，具体原因待确认。")}` : ""),
          linkTo: `/tasks/${encodeURIComponent(ctxThreadId)}`,
        });
        return;
      }
      // ④ 问 / 派：统一走服务端意图路由（ask 应答 / quest·agent 立项 / clarify 反问）
      /**
       * 派活的执行路由（2026-09-20 真机修复）：
       *  - 视觉类目标（海报/配图/封面/生图…）默认派给「视觉设计师」岗位——它声明了
       *    visualwrite.* 工具，才会走真实视觉工位（bridge → Ark seedream）出图；
       *  - 咨询任务只入队并立即取得线程，由真实后台调度器执行，便于中途查看、转人工或停止；
       *    其它行业保留既有立即执行语义。客户端不会补发另一个 run 请求。
       */
      // 覆盖口语说法："生成一张…图 / 画一张 / 做一张…图"都要能落到视觉岗位
      const visualGoal = /海报|配图|封面|生图|出图|图片|视觉|主视觉|素材图|生成.{0,12}图|画一?[张幅].{0,12}图|做一?[张幅].{0,12}图/.test(text);
      const presetKey = presetKeyRef.current ?? (visualGoal ? "visual-designer" : undefined);
      presetKeyRef.current = null;
      const runImmediately = intent === "task" && !queueTasks;
      const begun = await beginDispatchAttempt(identityKey, { title: text, ...(presetKey ? { presetKey } : {}), runImmediately });
      if (!alive.current) return;
      activeRequestId = begun.attempt.requestId;
      setAttempt(begun.attempt);
      let result: DispatchResult | null = null;
      if (begun.reused) {
        const original = await trpc.threads.dispatchRequest.query({ requestId: activeRequestId }) as DispatchResult;
        if (!alive.current) return;
        if (original.kind !== "not-found") result = original;
        else if (begun.attempt.state === "settled") {
          setDispatchNotice("原提交已结算，但暂未读取到服务端结果。请先到任务中心核对；明确点击新建任务后才会生成新请求。");
          return;
        }
      }
      if (!result) {
        result = await trpc.threads.dispatch.mutate({
          title: text, ...(presetKey ? { presetKey } : {}), runImmediately, requestId: activeRequestId,
        }) as DispatchResult;
      }
      showDispatchResult(result, activeRequestId, text);
    } catch (error) {
      if (!alive.current) return;
      setInput(text);
      if (activeRequestId) {
        try { recordAttempt(activeRequestId, "unknown"); }
        catch (storageError) { setDispatchNotice(storageError instanceof Error ? storageError.message : "本机请求标识暂不可读，请先核对原任务。"); }
        pushMsg({ role: "agent", action: "提交结果待确认", receipt: "unverified",
          text: `${operationFailure(error, "任务提交")} 输入已保留；再次提交会先查询原请求并沿用同一标识。` });
      } else {
        pushMsg({ role: "agent", action: "操作未完成", receipt: "failed",
          text: error instanceof Error && /恢复标识|原提交|上一项|身份尚未/.test(error.message)
            ? error.message : `${operationFailure(error, "本次操作")} 输入已保留。` });
      }
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  }, [accessReady, identityKey, queueTasks, pushMsg, presetIntent, domain, ctxThreadId, nightChannel, recordAttempt, showDispatchResult]);

  /* 外部 chip 通过 sendRef 调用最新 send（事件监听常驻，不因依赖变化重挂） */
  useEffect(() => { sendRef.current = send; }, [send]);

  /**
   * 长周期任务卡片的状态同步（与经营主页剧场 5s 心跳同频）：
   * 卡片不发快照、只读线程状态机（threads.get）——与员工头顶任务牌**同源**，
   * 因此中间视图的"进行中/待您拍板/已完成"与右栏卡片永远一致。
   * 终态（completed/failed）后停止轮询；断线保留上次状态（不假装成功）。
   */
  const msgsRef = useRef<RingMsg[]>([]);
  msgsRef.current = msgs;
  const shouldReadCard = (card: TaskCard) => !card.detailLoaded || Boolean(card.readError)
    || !["completed", "failed", "cancelled"].includes(card.status);
  const pendingCardKey = msgs.filter(message => message.card?.threadId && shouldReadCard(message.card))
    .map(message => `${message.id}:${message.card!.threadId}`).join(",");
  useEffect(() => {
    if (!pendingCardKey) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const targets = msgsRef.current.filter(message => message.card?.threadId && shouldReadCard(message.card));
      await Promise.all(targets.map(async message => {
        const threadId = message.card!.threadId;
        try {
          await ensureDemoLogin();
          if (cancelled || !alive.current) return;
          const thread = await trpc.threads.get.query({ threadId }) as {
            title?: string; status?: string; progress_done?: number; progress_total?: number; updated_at?: string;
            error?: string | null; current_action?: string | null; executionSource?: "consulting-report" | "generic";
            pending_approval_id?: string | null; preset_key?: string | null;
          } | null;
          if (cancelled || !alive.current) return;
          if (!thread?.status) throw new Error("Thread detail unavailable");
          const consulting = thread.executionSource === "consulting-report"
            ? await trpc.consulting.taskView.query({ threadId }) as ConsultingTaskView | null : null;
          if (cancelled || !alive.current) return;
          if (thread.executionSource === "consulting-report" && (!consulting || consulting.threadId !== threadId)) throw new Error("Industry task detail unavailable");
          if (message.card?.status !== thread.status && ["completed", "failed"].includes(thread.status)) {
            window.dispatchEvent(new CustomEvent("workloom:task-settled", { detail: { threadId, title: thread.title ?? message.card?.title, status: thread.status } }));
          }
          setMsgs(current => current.map(item => item.id === message.id && item.card ? { ...item, card: {
            ...item.card, title: thread.title ?? item.card.title, status: thread.status!, detailLoaded: true, readError: undefined,
            stepsDone: typeof thread.progress_done === "number" ? thread.progress_done : item.card.stepsDone,
            stepsTotal: typeof thread.progress_total === "number" ? thread.progress_total : item.card.stepsTotal,
            updatedAt: thread.updated_at ?? item.card.updatedAt,
            error: thread.error ? clientNaturalText(thread.error, "任务执行未完成，具体原因待确认。")
              : thread.status === "failed" ? "任务执行未完成，服务端尚未提供具体失败原因。" : undefined,
            currentAction: thread.current_action ? clientNaturalText(thread.current_action, "当前动作待确认") : undefined,
            executionSource: thread.executionSource ?? "generic", approvalId: thread.pending_approval_id ?? undefined,
            presetKey: thread.preset_key ?? item.card.presetKey,
            consultingStatus: consulting?.status, sourceCount: consulting?.sources.length,
            artifactAvailable: consulting?.finalArtifact?.synced === true && /^[a-f0-9]{64}$/i.test(consulting.finalArtifact.sha256),
          } } : item));
        } catch (error) {
          if (!cancelled && alive.current) setMsgs(current => current.map(item => item.id === message.id && item.card
            ? { ...item, card: { ...item.card, readError: operationFailure(error, "任务状态读取") } } : item));
        }
      }));
      if (cancelled || !alive.current) return;
      const idle = targets.length > 0 && targets.every(message => ["pending_review", "paused"].includes(message.card!.status));
      timer = setTimeout(() => void tick(), idle ? 30000 : 5000);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [pendingCardKey]);

  const inputBar = (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        data-workloom-assistant-input="true"
        aria-label="织伴全局对话框输入（提问 / 派活 / 留言 / 推进）"
        value={input}
        maxLength={500}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
        placeholder={domain === "mine" ? "跟小织说点什么…（记事 / 提醒 / 查任务）" : "问一句、派个任务，或留言…（⌘K 唤起）"}
        className="min-w-0 flex-1 rounded-lg border border-gline bg-bg800 px-3 py-2 text-body text-ink outline-none placeholder:text-ink3"
      />
      <button
        type="button"
        disabled={!input.trim() || sending || !accessReady}
        onClick={() => void send(input)}
        className="shrink-0 cursor-pointer rounded-lg gold-grad px-3.5 py-2 text-body font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40"
      >
        {sending ? "执行中…" : "发送"}
      </button>
    </div>
  );

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => { setHidden(false); setCollapsed(false); }}
        className="fixed right-0 top-1/2 flex -translate-y-1/2 items-center rounded-l-xl border border-r-0 border-gline bg-bg900/95 px-2 py-3 text-body font-semibold text-gold shadow-xl"
        style={{ zIndex: "var(--wl-z-assistant)" }}
        aria-label="显示 AI 助手"
        title="显示 AI 助手（⌘/Ctrl+K）"
      >
        AI
      </button>
    );
  }

  /* ---------- 收起态：56px 图标条 ---------- */
  if (collapsed) {
    return (
      <div className="fixed inset-y-0 right-0 flex w-[var(--wl-assistant-compact)] flex-col items-center gap-3 border-l border-line bg-bg900/95 py-3 backdrop-blur-md" style={{ zIndex: "var(--wl-z-assistant)" }}>
        <div className="relative flex h-[calc(var(--wl-assistant-compact)-8px)] w-[calc(var(--wl-assistant-compact)-8px)] shrink-0 items-center justify-center">
          <button
            ref={collapsedTriggerRef}
            type="button"
            onClick={() => setCollapsed(false)}
            title="展开 AI 助手"
            aria-label="展开 AI 助手"
            className="flex h-[calc(var(--wl-assistant-compact)-12px)] w-[calc(var(--wl-assistant-compact)-12px)] cursor-pointer items-center justify-center rounded-full gold-grad shadow-[0_0_24px_rgba(255,160,60,.5)]"
          >
            <ClapperIcon />
          </button>
        </div>
        <div className="text-body tracking-[.25em] text-gold [writing-mode:vertical-rl]">AI 助手</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="cursor-pointer rounded border border-line px-1.5 py-1 text-body text-ink3 hover:border-gline hover:text-gold"
          title="展开（⌘K）"
          aria-label="展开 AI 助手"
        >
          <Icon name="chevron" size={16} />
        </button>
      </div>
    );
  }

  /* ---------- 展开态：320px 通栏对话框 ---------- */
  const rail = (
    <div
      {...(!compactViewport ? railSurface : {})}
      role={!compactViewport ? "complementary" : undefined}
      aria-label={!compactViewport ? "AI 助手" : undefined}
      className="fixed inset-y-0 right-0 flex flex-col border-l border-gline/60 bg-bg900/95 shadow-[-20px_0_60px_rgba(0,0,0,.45)] backdrop-blur-md"
      style={{
        zIndex: "var(--wl-z-assistant)",
        width: compactViewport
          ? "min(var(--wl-assistant-expanded), calc(100vw - var(--wl-assistant-compact)))"
          : "var(--wl-assistant-expanded)",
      }}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full gold-grad shadow-[0_0_16px_rgba(255,160,60,.45)]">
          <ClapperIcon size={18} />
        </span>
        <div className="min-w-0">
          {/* 头部文案与结构保持基座口径：UI 门禁（窄视口 + 200% 字号不溢出）与视觉基线
              都以本仓头部为基准；growth 侧多出的「工作区/我的」徽标会把 90px 容器撑破，
              域切换改由右侧按钮承担（功能不丢，布局不破）。 */}
          <div className="flex items-center gap-1.5">
            <AgentAvatar kind="Knight" size={22} title="数字负责人" />
            <span className="text-body font-black tracking-wider text-gold">AI 助手</span>
          </div>
          <div className="text-body text-ink3">正在协助：{pageLabel}</div>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setDomain((d) => (d === "work" ? "mine" : "work"))}
          title="切换「工作区 / 我的」域"
          aria-label={domain === "work" ? "切换到我的（个人秘书）" : "切换到工作区"}
          className={`cursor-pointer rounded border px-2 py-0.5 text-body ${domain === "mine" ? "border-gold/60 text-gold" : "border-line text-ink3 hover:text-ink"}`}
        >
          {domain === "work" ? "我的" : "工作区"}
        </button>
        <button type="button" onClick={() => setCollapsed(true)}
          title="收起为图标条"
          aria-label="收起 AI 助手"
          className="cursor-pointer rounded border border-line px-2 py-0.5 text-body text-ink3 hover:bg-card">
          <Icon className="rotate-180" name="chevron" size={16} />
        </button>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {msgs.length === 0 ? (
          <div className="mt-8 space-y-2 text-center text-body text-ink3">
            <div className="text-gold/80">一个框，四种落点：<br />问 → 直接回答 · 派 → 立项<br />留言 → 只写账本 · 推进 → 续跑当前任务</div>
            <div className="text-body">
              {domain === "mine"
                ? "「我的」域：记事、定时提醒、查任务、找人——不替您做业务决策"
                : ctxThreadId ? "当前在任务线程内：可直接「留言」或「推进」"
                  : nightChannel ? "当前在夜班频道：说一句给班组，默认按「留言」留痕"
                    : "选择下方常用问题，或直接输入内容开始"}
            </div>
          </div>
        ) : (
          msgs.map((m) => m.role === "human" ? (
            <HumanBubble key={m.id}>{m.text}</HumanBubble>
          ) : m.card ? (
            <TaskCardView
              key={m.id}
              card={m.card}
              onReport={() => nav(`/tasks/${encodeURIComponent(m.card!.threadId)}#report`)}
              onOpen={() => {
                if (!m.card?.threadId) return;
                // X-02：挂起卡直达审批锚点（任务页据 ?apr= 高亮并滚动）
                const apr = m.card.approvalId ? `?apr=${encodeURIComponent(m.card.approvalId)}` : "";
                nav(`/tasks/${encodeURIComponent(m.card.threadId)}${apr}`);
              }}
            />
          ) : (
            <AgentActionMessage
              key={m.id}
              sender="AI 助手"
              version=""
              action={m.action ?? "应答"}
              eventId={m.refId ?? "—"}
              receipt={m.receipt ?? "unverified"}
            >
              {m.intent && (
                <span className="mr-1 rounded border border-holo/40 px-1 text-body text-holo">{INTENT_LABEL[m.intent]}</span>
              )}
              {m.text}
              {m.linkTo && (
                <button type="button" onClick={() => nav(m.linkTo!)} className="ml-1 text-holo underline">→ 任务中心跟进</button>
              )}
              {m.prompt && (
                <AIFeedback
                  scene="ask-synthesize"
                  action="ask-synthesize"
                  prompt={m.prompt}
                  originalText={m.text ?? ""}
                  fromTier="L2"
                />
              )}
            </AgentActionMessage>
          ))
        )}
      </div>

      {/* 情境快捷钮 */}
      <div className="flex flex-wrap gap-1.5 border-t border-line/60 px-3 pt-2">
        {domain === "mine" ? (
          ["任务怎么样了", "明早八点提醒我看交付结果", "找总经理"].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => void send(c, "personal")}
              className="cursor-pointer rounded-md border border-gold/40 bg-gold/5 px-2 py-0.5 text-body text-gold/90 transition-colors hover:border-gline hover:text-gold"
            >
              <Icon name="lightning" size={13} /> {c}
            </button>
          ))
        ) : (
          <>
            {nightChannel && (
              <button
                type="button"
                onClick={() => setPresetIntent("note")}
                className={`cursor-pointer rounded-md border px-2 py-0.5 text-body transition-colors ${presetIntent === "note" ? "border-gold/60 text-gold" : "border-holo/35 bg-holo/5 text-holo hover:border-gline hover:text-gold"}`}
              >
                <Icon name="send" size={13} /> 给班组留言
              </button>
            )}
            {ctxThreadId && (
              <button
                type="button"
                onClick={() => setPresetIntent("advance")}
                className={`cursor-pointer rounded-md border px-2 py-0.5 text-body transition-colors ${presetIntent === "advance" ? "border-gold/60 text-gold" : "border-holo/35 bg-holo/5 text-holo hover:border-gline hover:text-gold"}`}
              >
                <Icon name="play" size={13} /> 继续推进本任务
              </button>
            )}
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => void send(c)}
                className="cursor-pointer rounded-md border border-holo/35 bg-holo/5 px-2 py-0.5 text-body text-holo transition-colors hover:border-gline hover:text-gold"
              >
                <Icon name="lightning" size={13} /> {c}
              </button>
            ))}
          </>
        )}
      </div>

      {/* 输入栏 */}
      <div className="px-3 py-3">
        {presetIntent && (
          <div className="mb-1.5 flex items-center gap-2 text-body text-gold/90">
            <span>下一条按「{INTENT_LABEL[presetIntent]}」处理</span>
            <button type="button" onClick={() => setPresetIntent(null)} className="cursor-pointer text-ink3 underline">取消</button>
          </div>
        )}
        {confirm && (
          <div className="mb-1.5 rounded-lg border border-gold/40 bg-gold/5 px-2 py-1.5 text-body text-ink2">
            <div className="mb-1">落点确认：「{confirm.text.slice(0, 40)}」</div>
            <div className="flex flex-wrap gap-1.5">
              {confirm.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => void send(confirm.text, option)}
                  className="cursor-pointer rounded border border-gline px-2 py-0.5 text-body text-gold hover:bg-gold/15"
                >
                  {INTENT_LABEL[option]}
                </button>
              ))}
              <button type="button" onClick={() => setConfirm(null)} className="cursor-pointer px-2 py-0.5 text-body text-ink3 underline">取消</button>
            </div>
          </div>
        )}
        {dispatchNotice && <div role="status" className="mb-2 break-words rounded border border-warn/40 bg-warn/5 p-2 text-body text-warn">{dispatchNotice}</div>}
        {attempt?.state === "settled" && <button type="button" disabled={sending} className="mb-2 text-body text-holo underline disabled:opacity-50" onClick={() => {
          try { finishSettledDispatch(identityKey); setAttempt(null); setDispatchNotice(null); pendingClarifyRef.current = null; inputRef.current?.focus(); }
          catch (error) { setDispatchNotice(error instanceof Error ? error.message : "新任务标识暂不可用。"); }
        }}>新建任务</button>}
        {inputBar}
      </div>
    </div>
  );

  return compactViewport ? (
    <div
      {...railSurface}
      role="dialog"
      aria-modal="true"
      aria-label="AI 助手"
      className="fixed inset-0"
      style={{ zIndex: "var(--wl-z-assistant)" }}
    >
      <button type="button" aria-label="收起 AI 助手" className="absolute inset-0 cursor-default bg-black/45" onClick={() => setCollapsed(true)} />
      {rail}
    </div>
  ) : rail;
}

function isQuestion(text: string): boolean {
  return /[?？]$/.test(text) || /吗$|呢$|怎么|如何|什么|哪|几|多少|是否|能不能|可不可以/.test(text);
}
