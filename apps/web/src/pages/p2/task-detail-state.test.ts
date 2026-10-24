// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import P2 from "./P2";
import type { ConsultingTaskView } from "../../extensions/consulting/task-client";

const api = vi.hoisted(() => ({
  threadId: "T-ui-failure", canDispatch: true,
  get: vi.fn(), list: vi.fn(), events: vi.fn(), run: vi.fn(),
  approvals: vi.fn(), decide: vi.fn(), taskView: vi.fn(), taskReport: vi.fn(), taskAction: vi.fn(),
}));
vi.mock("../../lib/trpc", () => ({
  ensureDemoLogin: vi.fn(async () => {}),
  trpc: {
    threads: { get: { query: api.get }, list: { query: api.list }, events: { query: api.events }, run: { mutate: api.run } },
    approvals: { list: { query: api.approvals }, decide: { mutate: api.decide } },
    consulting: { taskView: { query: api.taskView }, taskReport: { query: api.taskReport }, taskAction: { mutate: api.taskAction } },
  },
}));
vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  useParams: () => ({ threadId: api.threadId }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("../../shell/NavigationAccess", () => ({
  useNavigationAccess: () => ({
    identityKey: "workspace:OWNER", bundle: { bundleId: "consulting" },
    canAction: (permission: string) => api.canDispatch && permission === "task.dispatch",
  }),
}));
vi.mock("../../shell/Bridge", () => ({
  Bridge: ({ children, left, right }: { children: ReactNode; left?: ReactNode; right?: ReactNode }) =>
    createElement("div", null, createElement("aside", null, left), createElement("main", null, children), createElement("aside", null, right)),
}));
vi.mock("../../components/RejectDialog", () => ({ RejectDialog: () => null }));

let host: HTMLDivElement;
let root: Root;
const failedThread = () => ({
  id: api.threadId, title: "制造业资料分析", mode: "quest", status: "failed",
  progress_done: 0, progress_total: 4, agent_id: "a-reader", created_by: "OWNER",
  created_at: "2026-10-24T00:12:57.754Z", updated_at: "2026-10-24T00:12:59.233Z",
  error: "档案读取未接通，尚无可核验回执", current_action: "读取授权制造业材料",
  executionSource: "generic",
});
const failedEvent = () => ({
  event_id: "E-ui-step", who: { type: "agent", id: "a-reader", version: "v1.0" },
  context: { time: "2026-10-24T00:12:59.231Z" }, object: { type: "enterprise" },
  decision: { kind: "execute", tool: "archive.read", action: "data.export", effect: "read", step_id: "s1", after: { result: { state: "connector-required" } } },
  rule_impact: [], receipt: { synced: false, mode: "real" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render() { await act(async () => root.render(createElement(P2))); }
function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
  api.threadId = "T-ui-failure";
  api.canDispatch = true;
  api.get.mockResolvedValue(failedThread());
  api.list.mockResolvedValue([]);
  api.events.mockResolvedValue([failedEvent()]);
  api.approvals.mockResolvedValue([]);
  api.taskView.mockResolvedValue(null);
  api.run.mockResolvedValue({ status: "failed", stepsDone: 0, stepsTotal: 4 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("任务真实失败与恢复展示", () => {
  it("档案读取失败展示服务端错误与当前动作，不把任意失败说成渠道连接故障", async () => {
    await render();
    expect(host.textContent).toContain("档案读取未接通，尚无可核验回执");
    expect(host.textContent).toContain("读取授权制造业材料");
    expect(host.textContent).not.toContain("渠道连接检查失败");
    expect(host.textContent).not.toContain("已暂停所有外部操作");
  });

  it("服务端没有给出错误原因时明确未知，不虚构故障种类", async () => {
    api.get.mockResolvedValue({ ...failedThread(), error: null, current_action: null });
    api.events.mockResolvedValue([]);
    await render();
    expect(host.textContent).toContain("任务执行未完成");
    expect(host.textContent).toContain("尚未提供具体失败原因");
    expect(host.textContent).not.toContain("渠道连接检查失败");
  });

  it("没有服务端接管回执时，点击转人工也不能宣称已接管", async () => {
    const pending = deferred<unknown>(); api.taskAction.mockReturnValue(pending.promise);
    await render();
    const handoff = button("转人工");
    if (handoff && !handoff.disabled) await act(async () => handoff.click());
    expect(host.textContent).not.toContain("已标记为需要人工介入");
    expect(host.textContent).not.toContain("已开启人工接管通道");
    expect(api.run).not.toHaveBeenCalled();
  });

  it("失败页不提供伪回滚或未说明模型/费用的降级重试", async () => {
    await render();
    expect(button("回滚")).toBeUndefined();
    expect(button("降级重试")).toBeUndefined();
    expect(host.textContent).toContain("停止任务");
    expect(host.textContent).toContain("保留");
  });

  it("初次读取失败呈现重试入口，不把读取错误报成任务不存在", async () => {
    api.get.mockRejectedValue(new Error("network unavailable"));
    await render();
    expect(host.textContent).not.toContain("这个任务不存在，或已被清理");
    expect(button("重试读取任务")).toBeDefined();
    api.get.mockResolvedValue(failedThread());
    await act(async () => button("重试读取任务")!.click());
    expect(host.textContent).toContain("档案读取未接通");
  });

  it("只读身份不显示任何恢复或继续执行动作", async () => {
    api.canDispatch = false;
    await render();
    for (const label of ["转人工", "停止任务", "恢复执行", "降级重试", "回滚"]) expect(button(label)).toBeUndefined();
    expect(api.taskAction).not.toHaveBeenCalled();
  });

  it("线程切换后忽略旧线程迟到结果，不能把旧失败渲染到新任务", async () => {
    const pending = deferred<unknown>(); api.get.mockReturnValueOnce(pending.promise);
    await render();
    api.threadId = "T-new-scope";
    api.get.mockResolvedValue({ ...failedThread(), title: "新线程已核对", error: "新线程的实际错误" });
    await render();
    await act(async () => pending.resolve({ ...failedThread(), title: "旧线程迟到正文", error: "旧线程错误" }));
    expect(host.textContent).toContain("新线程已核对");
    expect(host.textContent).not.toContain("旧线程迟到正文");
    expect(host.textContent).not.toContain("旧线程错误");
  });

  it("通用任务继续执行防双击，沿用原线程而不重写目标，失败有真实反馈", async () => {
    api.get.mockResolvedValue({ ...failedThread(), status: "paused" });
    const pending = deferred<unknown>(); api.run.mockReturnValue(pending.promise);
    await render();
    const run = button("执行或从中断处继续")!;
    await act(async () => { run.click(); run.click(); });
    try {
      expect(api.run).toHaveBeenCalledTimes(1);
      expect(api.run).toHaveBeenCalledWith({ threadId: api.threadId });
      expect(run.disabled).toBe(true);
      expect(host.textContent).not.toContain("已续跑任务");
    } finally { await act(async () => pending.reject(new Error("network response lost"))); }
    expect(host.textContent).toContain("请先核对原任务");
    expect(api.run).toHaveBeenCalledTimes(1);
  });
});

const reportText = "# 制造业公开资料分析\n\n这是待人工审阅的内部草稿。\n\n## 来源与限制\n\n仅依据已冻结的公开资料，不能作为独立审计结论。\n";
const reportSha = createHash("sha256").update(reportText).digest("hex");
const ledgerHash = "b".repeat(64);
function reportView(): ConsultingTaskView {
  return {
    threadId: api.threadId, runId: "CR-" + "c".repeat(24), status: "draft_ready", phase: "draft_ready",
    stepsDone: 6, stepsTotal: 6, humanReviewRequired: true, sourceMode: "public-web",
    sources: [{ id: "source-1", title: "制造业公开统计", url: "https://www.example.gov.cn/manufacturing",
      publishedAt: "2026-10-20", retrievedAt: "2026-10-24T01:00:00.000Z", sha256: "a".repeat(64),
      excerptSha256: "d".repeat(64), excerptRanges: [{ startByte: 0, endByte: 64 }], fullBytes: 256, excerptBytes: 64 }],
    finalArtifact: { kind: "report", sha256: reportSha, bytes: Buffer.byteLength(reportText), eventId: "E-ui-report", hash: ledgerHash, synced: true },
    error: null,
    availableActions: { resume: { enabled: false, reason: "报告草稿已生成，无需恢复执行" }, handoff: { enabled: true, reason: null }, cancel: { enabled: false, reason: "任务已结束，无后续步骤可停止" } },
    lastReceipt: { eventId: "E-ui-report", hash: ledgerHash, synced: true },
  };
}
function useConsulting(view = reportView()) {
  api.get.mockResolvedValue({ ...failedThread(), status: view.status === "draft_ready" ? "completed" : "failed", error: view.error?.message ?? null, executionSource: "consulting-report" });
  api.taskView.mockResolvedValue(view);
  api.taskReport.mockResolvedValue({ threadId: api.threadId, runId: view.runId, content: reportText,
    sha256: reportSha, bytes: Buffer.byteLength(reportText), receipt: { eventId: "E-ui-report", hash: ledgerHash, synced: true }, humanReviewRequired: true });
}

describe("受控咨询报告与真实恢复动作", () => {
  it("报告完成态展示内部草稿、人审和来源，打开时仅按线程受控读取完整正文", async () => {
    useConsulting(); await render();
    expect(host.textContent).toContain("内部报告草稿");
    expect(host.textContent).toContain("待人工审阅");
    expect(host.textContent).toContain("平台积分计量");
    expect(host.textContent).toContain("平台积分不代表模型费用");
    expect(host.textContent).toContain("制造业公开统计");
    expect(host.querySelector('a[href="https://www.example.gov.cn/manufacturing"]')?.getAttribute("rel")).toContain("noopener");
    expect(api.taskReport).not.toHaveBeenCalled();
    expect(button("打开报告")).toBeDefined();
    await act(async () => button("打开报告")!.click());
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(host.querySelector('a[download$=".md"]')).not.toBeNull();
    });
    expect(api.taskReport).toHaveBeenCalledWith({ threadId: api.threadId });
    expect(host.textContent).toContain("仅依据已冻结的公开资料，不能作为独立审计结论。");
    expect(host.querySelector('a[download$=".md"]')).not.toBeNull();
    expect(host.textContent).not.toContain("交付完成 · 变更报告");
  });

  it("报告scope和声明字节数均有效时，同字节长度篡改仍因真实SHA校验失败而拒绝展示下载", async () => {
    const view = reportView(); const altered = reportText.replace("#", "*");
    expect(Buffer.byteLength(altered)).toBe(Buffer.byteLength(reportText));
    useConsulting(view); api.taskReport.mockResolvedValue({ threadId: api.threadId, runId: view.runId, content: altered,
      sha256: reportSha, bytes: Buffer.byteLength(reportText), receipt: { eventId: "E-ui-report", hash: ledgerHash, synced: true }, humanReviewRequired: true });
    await render(); await act(async () => button("打开报告")?.click());
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(host.textContent).toContain("报告校验未通过");
    });
    expect(host.textContent).toContain("报告校验未通过");
    expect(host.querySelector('article[aria-label="内部报告草稿正文"]')).toBeNull();
    expect(host.querySelector('a[download$=".md"]')).toBeNull();
  });

  it("描述和响应声明相同长度时，仍核对实际UTF8字节数并拒绝缺字节正文", async () => {
    const view = reportView(); view.finalArtifact!.bytes += 1;
    useConsulting(view); api.taskReport.mockResolvedValue({ threadId: api.threadId, runId: view.runId, content: reportText,
      sha256: reportSha, bytes: view.finalArtifact!.bytes, receipt: { eventId: "E-ui-report", hash: ledgerHash, synced: true }, humanReviewRequired: true });
    await render(); await act(async () => button("打开报告")!.click());
    expect(host.textContent).toContain("报告校验未通过");
    expect(host.querySelector('article[aria-label="内部报告草稿正文"]')).toBeNull();
    expect(host.querySelector('a[download$=".md"]')).toBeNull();
  });

  it("尚无最终报告时不制造打开入口，来源链接不接受可执行协议", async () => {
    const view = reportView();
    useConsulting({ ...view, status: "working", phase: "working", finalArtifact: null,
      sources: [{ ...view.sources[0]!, title: "来源正文<script>恶意脚本</script>", url: "javascript:alert(1)" }] } as ReturnType<typeof reportView>);
    await render();
    expect(host.textContent).toContain("尚未生成最终报告");
    expect(button("打开报告")).toBeUndefined();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.querySelector("script")).toBeNull();
  });

  it("转人工调用真实动作一次，等待持久化回执后展示人工处理状态", async () => {
    const view = { ...reportView(), status: "blocked", phase: "blocked", finalArtifact: null,
      error: { code: "SOURCE_UNAVAILABLE", message: "公开来源暂不可用" },
      availableActions: { resume: { enabled: false, reason: "来源失败尚未修复" }, handoff: { enabled: true, reason: null }, cancel: { enabled: true, reason: null } } };
    useConsulting(view as ReturnType<typeof reportView>);
    const pending = deferred<unknown>(); api.taskAction.mockReturnValue(pending.promise);
    await render();
    const transfer = button("转人工")!;
    expect(transfer).toBeDefined();
    await act(async () => { transfer.click(); transfer.click(); });
    try {
      expect(api.taskAction).toHaveBeenCalledTimes(1);
      expect(api.taskAction.mock.calls[0]![0]).toMatchObject({ threadId: api.threadId, action: "handoff" });
      expect(api.taskAction.mock.calls[0]![0].idempotencyKey).toMatch(/^[a-f0-9-]{36}$/i);
      expect(host.textContent).not.toContain("已记录转人工");
      expect(transfer.disabled).toBe(true);
    } finally {
      const next = { ...view, status: "human_required", phase: "human_required", actionReceipt: { eventId: "E-ui-handoff", hash: ledgerHash, synced: true } };
      api.taskView.mockResolvedValue(next); api.get.mockResolvedValue({ ...failedThread(), status: "paused", executionSource: "consulting-report" });
      await act(async () => pending.resolve(next));
    }
    expect(host.textContent).toContain("已记录转人工");
    expect(api.run).not.toHaveBeenCalled();
  });

  it("服务端禁用恢复时说明原因，停止只调用cancel且明确保留草稿和历史", async () => {
    const view = { ...reportView(), status: "blocked", phase: "blocked", finalArtifact: null,
      error: { code: "PROVIDER_UNKNOWN", message: "原模型请求结果未知" },
      availableActions: { resume: { enabled: false, reason: "原请求用量尚未核实，不能自动重发" }, handoff: { enabled: true, reason: null }, cancel: { enabled: true, reason: null } } };
    useConsulting(view as ReturnType<typeof reportView>);
    const cancelled = { ...view, status: "cancelled", phase: "cancelled", actionReceipt: { eventId: "E-ui-stop", hash: ledgerHash, synced: true } };
    api.taskAction.mockResolvedValue(cancelled);
    await render();
    expect(button("恢复执行")?.disabled).toBe(true);
    expect(host.textContent).toContain("原请求用量尚未核实，不能自动重发");
    expect(host.textContent).toContain("保留已生成草稿和历史记录");
    await act(async () => button("停止任务")!.click());
    expect(api.taskAction).toHaveBeenCalledWith(expect.objectContaining({ threadId: api.threadId, action: "cancel" }));
    expect(host.textContent).not.toContain("反向补偿");
    expect(api.run).not.toHaveBeenCalled();
  });

  it("原报告回执不能冒充本次动作回执；动作未知重载后沿用原UUID", async () => {
    const view: ConsultingTaskView = { ...reportView(), status: "blocked", phase: "blocked", finalArtifact: null };
    useConsulting(view); api.taskAction.mockResolvedValue(view);
    await render(); await act(async () => button("转人工")!.click());
    const original = api.taskAction.mock.calls[0]![0].idempotencyKey;
    expect(host.textContent).not.toContain("已记录转人工");
    expect(host.textContent).toContain("尚未提供可核验回执");
    await act(async () => root.unmount()); root = createRoot(host);
    api.taskAction.mockRejectedValue(new Error("network response lost"));
    await render(); await act(async () => button("转人工")!.click());
    expect(api.taskAction.mock.calls[1]![0].idempotencyKey).toBe(original);
    expect(host.textContent).toContain("操作结果尚未确认");
    expect(host.textContent).not.toContain("已记录转人工");
  });

  it("无动作回执时不接受mutation声称的人工状态，延迟只读核对期间保留旧状态", async () => {
    const view: ConsultingTaskView = { ...reportView(), status: "blocked", phase: "blocked", finalArtifact: null };
    useConsulting(view); await render();
    const readback = deferred<ConsultingTaskView>();
    api.taskView.mockReturnValue(readback.promise);
    api.taskAction.mockResolvedValue({ ...view, status: "human_required" });
    await act(async () => button("转人工")!.click());
    try {
      expect(host.textContent).not.toContain("等待人工处理");
      expect(host.textContent).toContain("任务执行未完成");
      expect(host.textContent).toContain("尚未提供可核验回执");
    } finally { await act(async () => readback.resolve(view)); }
  });

  it("动作前已发起的迟到轮询不能覆盖已持久化的人工处理状态", async () => {
    vi.useFakeTimers();
    const view: ConsultingTaskView = { ...reportView(), status: "blocked", phase: "blocked", finalArtifact: null };
    useConsulting(view); await render();
    const stale = deferred<ConsultingTaskView>();
    api.taskView.mockReturnValueOnce(stale.promise);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.taskView).toHaveBeenCalledTimes(2);
    const next: ConsultingTaskView = { ...view, status: "human_required", actionReceipt: { eventId: "E-new-handoff", hash: ledgerHash, synced: true } };
    api.taskView.mockResolvedValue(next); api.taskAction.mockResolvedValue(next);
    await act(async () => button("转人工")!.click());
    await act(async () => stale.resolve({ ...view, status: "working" }));
    expect(host.textContent).toContain("等待人工处理");
    expect(host.textContent).not.toContain("正在分析材料");
    expect(host.textContent).toContain("已记录转人工");
  });

  it("只读成员仍可读核验报告，但行业任务的所有写动作隐藏", async () => {
    api.canDispatch = false; useConsulting(); await render();
    expect(button("打开报告")).toBeDefined();
    for (const label of ["转人工", "停止任务", "恢复执行"]) expect(button(label)).toBeUndefined();
    expect(api.taskAction).not.toHaveBeenCalled();
  });

  it("报告读取失败保留任务与来源，提供再次打开入口且没有下载链接", async () => {
    useConsulting(); api.taskReport.mockRejectedValue(new Error("network unavailable"));
    await render(); await act(async () => button("打开报告")!.click());
    expect(host.textContent).toContain("报告打开未完成");
    expect(host.textContent).toContain("制造业公开统计");
    expect(button("打开报告")?.disabled).toBe(false);
    expect(host.querySelector('a[download$=".md"]')).toBeNull();
  });
});
