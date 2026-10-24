// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StarRing } from "./StarRing";
import { webcrypto } from "node:crypto";

const api = vi.hoisted(() => ({ identityKey: "workspace:OWNER", bundleId: "consulting", pathname: "/tasks", dispatch: vi.fn(), dispatchRequest: vi.fn(), note: vi.fn(), run: vi.fn(), get: vi.fn(), taskView: vi.fn(), navigate: vi.fn() }));
vi.mock("../../lib/trpc", () => ({
  ensureDemoLogin: vi.fn(async () => {}),
  trpc: { threads: { dispatch: { mutate: api.dispatch }, dispatchRequest: { query: api.dispatchRequest }, note: { mutate: api.note }, run: { mutate: api.run }, get: { query: api.get } },
    consulting: { taskView: { query: api.taskView } } },
}));
vi.mock("react-router", async original => ({ ...(await original<typeof import("react-router")>()), useNavigate: () => api.navigate, useLocation: () => ({ pathname: api.pathname }) }));
vi.mock("../../shell/NavigationAccess", () => ({ useNavigationAccess: () => ({ identityKey: api.identityKey, status: "ready", bundle: { bundleId: api.bundleId }, canAction: () => true }) }));
vi.mock("../AIFeedback", () => ({ AIFeedback: () => null }));

let host: HTMLDivElement;
let root: Root;
const reply = () => ({ kind: "routed", mode: "quest", threadId: "T-ui-dispatch", status: "failed", stepsDone: 0, stepsTotal: 4, executionSource: "generic" });
const detail = () => ({ id: "T-ui-dispatch", title: "制造业资料分析", mode: "quest", status: "failed", progress_done: 0, progress_total: 4,
  error: "档案读取未接通，尚无可核验回执", current_action: "读取授权制造业材料", executionSource: "generic" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function render() { await act(async () => root.render(<StarRing />)); }
function sendButton() { return [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === "发送")!; }
async function type(text: string) {
  const input = host.querySelector<HTMLInputElement>("input[data-workloom-assistant-input]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function settleInput() {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(sendButton()).toBeDefined();
  });
}
async function submit(text: string) { await type(text); await act(async () => sendButton().click()); await settleInput(); }
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); localStorage.clear();
  api.identityKey = "workspace:OWNER";
  api.bundleId = "consulting";
  api.pathname = "/tasks";
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true,
    value: vi.fn(() => ({ matches: false, media: "(max-width: 820px)", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true })) });
  HTMLElement.prototype.scrollTo = vi.fn();
  api.dispatch.mockResolvedValue(reply()); api.get.mockResolvedValue(detail()); api.taskView.mockResolvedValue(null);
  api.dispatchRequest.mockImplementation(async ({ requestId }: { requestId: string }) => ({ kind: "not-found", requestId }));
  api.note.mockResolvedValue({ threadId: "T-note-ui", receipt: { eventId: "E-880001", hash: "a".repeat(64), synced: true } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("助手任务卡与持久派单标识", () => {
  it("线程留言携带稳定UUID，验证真实线程事件回执后才显示已生效且不派活", async () => {
    api.pathname = "/tasks/T-note-ui";
    await render(); await submit("留言：保留原始统计口径，由顾问复核");
    expect(api.note).toHaveBeenCalledWith({ threadId: "T-note-ui", text: "留言：保留原始统计口径，由顾问复核",
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i) });
    expect(host.textContent).toContain("已给任务"); expect(host.textContent).toContain("已生效");
    expect(api.dispatch).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
  });

  it.each([
    { receipt: undefined }, { receipt: { eventId: "E-880001", hash: "a".repeat(64), synced: false } },
    { receipt: { eventId: "", hash: "a".repeat(64), synced: true } },
    { receipt: { eventId: "E-880001", hash: "bad-hash", synced: true } },
    { threadId: "T-another-ui", receipt: { eventId: "E-880001", hash: "a".repeat(64), synced: true } },
  ])("线程留言缺失/错误事件回执不宣称已生效，保留原输入 $receipt", async patch => {
    api.pathname = "/tasks/T-note-ui"; api.note.mockResolvedValue({ threadId: "T-note-ui", ...patch });
    await render(); await submit("留言：原始证据仍待复核");
    expect(host.textContent).not.toContain("已给任务"); expect(host.textContent).not.toContain("已生效");
    expect(host.querySelector<HTMLInputElement>("input[data-workloom-assistant-input]")!.value).toBe("留言：原始证据仍待复核");
    expect(api.dispatch).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
  });

  it("线程留言网络响应未知后同文本沿用原UUID，刷新也不另造键或重发", async () => {
    api.pathname = "/tasks/T-note-ui"; api.note.mockRejectedValueOnce(new Error("network response lost"));
    await render(); await submit("留言：应复核原始凭证");
    const first = api.note.mock.calls[0]![0].idempotencyKey;
    expect(first).toMatch(/^[a-f0-9-]{36}$/i);
    await act(async () => root.unmount()); root = createRoot(host); await render();
    expect(api.note).toHaveBeenCalledTimes(1);
    await submit("留言：应复核原始凭证");
    expect(api.note.mock.calls[1]![0].idempotencyKey).toBe(first);
    expect(host.textContent).toContain("已给任务");
    const persisted = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)).join(" ");
    expect(persisted).not.toContain("应复核原始凭证");
  });

  it("线程留言明确无权限时保留输入、不改成派单或推进", async () => {
    api.pathname = "/tasks/T-note-ui";
    api.note.mockRejectedValue(Object.assign(new Error("forbidden"), { data: { code: "FORBIDDEN" } }));
    await render(); await submit("留言：待主管核对");
    expect(host.textContent).toContain("当前角色没有执行此操作的权限");
    expect(host.textContent).not.toContain("已生效");
    expect(host.querySelector<HTMLInputElement>("input[data-workloom-assistant-input]")!.value).toBe("留言：待主管核对");
    expect(api.dispatch).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
  });

  it("留言恢复标识无法保存或已损坏时在提交前拒绝，不临时换键重试", async () => {
    api.pathname = "/tasks/T-note-ui"; await render();
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await submit("留言：仅保存证据链");
    expect(api.note).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("已生效");
    storage.mockRestore();
    api.note.mockRejectedValueOnce(new Error("network response lost"));
    await submit("留言：仅保存证据链");
    const noteKey = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).find(key => key.startsWith("workloom.thread-note.v1:"))!;
    localStorage.setItem(noteKey, "not-json");
    await submit("留言：仅保存证据链");
    expect(api.note).toHaveBeenCalledTimes(1); expect(host.textContent).not.toContain("已生效");
    expect(api.dispatch).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
  });

  it("留言摘要迟到且身份已经切换时不再用新身份提交旧留言", async () => {
    api.pathname = "/tasks/T-note-ui";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("identity-race-note-fixture"));
    const pending = deferred<ArrayBuffer>();
    const digestCall = vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(pending.promise);
    await render(); await type("留言：旧身份的待审证据");
    await act(async () => sendButton().click());
    await vi.waitFor(() => expect(digestCall).toHaveBeenCalledTimes(1));
    api.identityKey = "other-workspace:OWNER"; await render();
    await act(async () => pending.resolve(digest));
    expect(api.note).not.toHaveBeenCalled(); expect(api.dispatch).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("旧身份的待审证据");
  });

  it("咨询派单只入后台队列并立即展示可跟进卡片，不让HTTP等待完整报告执行", async () => {
    api.dispatch.mockResolvedValue({ ...reply(), status: "queued", executionSource: "consulting-report" });
    api.get.mockResolvedValue({ ...detail(), status: "queued", error: null, current_action: "等待后台调度", executionSource: "consulting-report" });
    api.taskView.mockResolvedValue({ threadId: "T-ui-dispatch", status: "queued", sources: [], finalArtifact: null });
    await render(); await submit("做一个制造业资料分析报告");
    expect(api.dispatch).toHaveBeenCalledWith(expect.objectContaining({ runImmediately: false }));
    expect(host.querySelector('[role="button"][title="打开任务详情"]')).not.toBeNull();
    expect(host.textContent).toContain("等待执行");
    expect(host.textContent).toContain("等待后台调度");
    expect(api.get).toHaveBeenCalledWith({ threadId: "T-ui-dispatch" });
  });

  it("其它行业明确派单保留原来的立即执行请求", async () => {
    api.bundleId = "hotel";
    await render(); await submit("做一个客诉处理分析报告");
    expect(api.dispatch).toHaveBeenCalledWith(expect.objectContaining({ runImmediately: true }));
  });

  it("立即失败的卡片也回读线程详情，显示实际错误和当前动作", async () => {
    await render(); await submit("做一个制造业资料分析报告");
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith({ threadId: "T-ui-dispatch" });
    expect(host.textContent).toContain("档案读取未接通，尚无可核验回执");
    expect(host.textContent).toContain("读取授权制造业材料");
    expect(host.textContent).not.toContain("渠道连接检查失败");
  });

  it("一次明确提交携带稳定UUID，连续双击只提交一次", async () => {
    const pending = deferred<unknown>(); api.dispatch.mockReturnValue(pending.promise);
    await render(); await type("做一个制造业资料分析报告");
    await act(async () => { sendButton().click(); sendButton().click(); });
    try {
      await act(async () => vi.waitFor(() => expect(api.dispatch).toHaveBeenCalledTimes(1)));
      expect(api.dispatch).toHaveBeenCalledTimes(1);
      expect(api.dispatch.mock.calls[0]![0].requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    } finally { await act(async () => pending.resolve(reply())); }
  });

  it("提交响应未知时先查询原requestId，同目标再提交保持原key", async () => {
    api.dispatch.mockRejectedValueOnce(new Error("network response lost")).mockResolvedValueOnce(reply());
    await render(); await submit("做一个制造业资料分析报告");
    const requestId = api.dispatch.mock.calls[0]![0].requestId;
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/i);
    await act(async () => sendButton().click());
    await settleInput();
    expect(api.dispatchRequest).toHaveBeenCalledWith({ requestId });
    expect(api.dispatch).toHaveBeenCalledTimes(2);
    expect(api.dispatch.mock.calls[1]![0].requestId).toBe(requestId);
  });

  it("同一未知请求重载后只查询恢复，不自动重新付费分类", async () => {
    api.dispatch.mockRejectedValueOnce(new Error("network response lost"));
    await render(); await submit("做一个制造业资料分析报告");
    const requestId = api.dispatch.mock.calls[0]![0].requestId;
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/i);
    await act(async () => root.unmount()); root = createRoot(host);
    api.dispatchRequest.mockResolvedValue({ kind: "dispatching", requestId });
    await render();
    expect(api.dispatchRequest).toHaveBeenCalledWith({ requestId });
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("正在确认原提交结果");
    const persisted = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)).join(" ");
    expect(persisted).not.toContain("制造业资料分析报告");
  });

  it("服务器已认领的同一请求只查询，不另造线程或可点击空卡", async () => {
    api.dispatch.mockResolvedValue({ kind: "dispatching", requestId: "11111111-1111-4111-8111-111111111111" });
    api.dispatchRequest.mockResolvedValue({ kind: "dispatching", requestId: "11111111-1111-4111-8111-111111111111" });
    await render(); await submit("做一个制造业资料分析报告");
    expect(host.textContent).toContain("正在确认原提交结果");
    expect(host.querySelector('[role="button"][title="打开任务详情"]')).toBeNull();
    expect(api.dispatch).toHaveBeenCalledTimes(1);
  });

  it("原请求未确认时另一个目标不能覆盖恢复标识或发出新请求", async () => {
    api.dispatch.mockRejectedValueOnce(new Error("network response lost"));
    await render(); await submit("做一个制造业资料分析报告");
    const original = localStorage.getItem(localStorage.key(0)!);
    await submit("做另一个不同目标的产业分析报告");
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(original);
    expect(host.textContent).toContain("上一项提交结果尚未确认");
  });

  it("恢复标识损坏或写入失败时停止提交，不把新key绕过恢复保护", async () => {
    localStorage.setItem("workloom.consulting.dispatch.v1:workspace%3AOWNER", "not-json");
    await render(); await submit("做一个制造业资料分析报告");
    expect(api.dispatch).not.toHaveBeenCalled();
    expect(host.textContent).toContain("恢复标识无法解析");
    localStorage.clear();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await submit("做一个制造业资料分析报告");
    expect(api.dispatch).not.toHaveBeenCalled();
    expect(host.textContent).toContain("本次尚未提交");
  });

  it("已结算的相同目标先回读原任务，明确新建后才取得新requestId", async () => {
    await render(); await submit("做一个制造业资料分析报告");
    const original = api.dispatch.mock.calls[0]![0].requestId;
    api.dispatchRequest.mockResolvedValue({ ...reply(), requestId: original });
    await submit("做一个制造业资料分析报告");
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    const create = [...host.querySelectorAll("button")].find(button => button.textContent === "新建任务")!;
    await act(async () => create.click());
    await submit("做一个制造业资料分析报告");
    expect(api.dispatch).toHaveBeenCalledTimes(2);
    expect(api.dispatch.mock.calls[1]![0].requestId).not.toBe(original);
  });

  it("切换身份后忽略上一身份的迟到提交响应", async () => {
    const pending = deferred<unknown>(); api.dispatch.mockReturnValue(pending.promise);
    await render(); await type("做一个制造业资料分析报告");
    await act(async () => sendButton().click());
    await act(async () => vi.waitFor(() => expect(api.dispatch).toHaveBeenCalledTimes(1)));
    api.identityKey = "other-workspace:OWNER"; await render();
    await act(async () => pending.resolve(reply()));
    expect(host.textContent).not.toContain("制造业资料分析报告");
    expect(host.querySelector('[role="button"][title="打开任务详情"]')).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("报告卡片读取行业描述后展示人审与来源数量，并用同一线程打开报告", async () => {
    api.dispatch.mockResolvedValue({ ...reply(), status: "completed", executionSource: "consulting-report" });
    api.get.mockResolvedValue({ ...detail(), status: "completed", executionSource: "consulting-report", error: null });
    api.taskView.mockResolvedValue({ threadId: "T-ui-dispatch", status: "draft_ready", sources: [{ id: "S1" }], finalArtifact: { sha256: "a".repeat(64), synced: true } });
    await render(); await submit("做一个制造业资料分析报告");
    expect(host.textContent).toContain("内部报告草稿已生成，待人工审阅");
    expect(host.textContent).toContain("已冻结 1 项来源");
    const report = [...host.querySelectorAll("button")].find(button => button.textContent === "打开报告")!;
    await act(async () => report.click());
    expect(api.navigate).toHaveBeenCalledWith("/tasks/T-ui-dispatch#report");
  });
});
