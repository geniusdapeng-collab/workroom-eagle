// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIFeedback } from "./AIFeedback";
const api = vi.hoisted(() => ({ bundleId: "consulting", submit: vi.fn(), escalate: vi.fn() }));
vi.mock("../lib/trpc", () => ({ trpc: { modelFeedback: { submit: { mutate: api.submit }, escalate: { mutate: api.escalate } } } }));
vi.mock("../shell/NavigationAccess", () => ({ useNavigationAccess: () => ({ identityKey: "workspace:OWNER", status: "ready", bundle: { bundleId: api.bundleId } }) }));
let host: HTMLDivElement; let root: Root;
async function render() { await act(async () => root.render(<AIFeedback scene="ask-synthesize" action="ask-synthesize" prompt="分析制造业企业" originalText="原始分析正文" />)); }
function down() { return host.querySelector<HTMLButtonElement>('button[aria-label^="这条回答没有帮助"]')!; }
function up() { return host.querySelector<HTMLButtonElement>('button[aria-label="这条回答有帮助"]')!; }
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); api.bundleId = "consulting";
  api.submit.mockResolvedValue({ ok: true });
  api.escalate.mockResolvedValue({ escalated: true, fromTier: "L2", toTier: "L3", freeEscalation: false, kind: "text", text: "升级分析正文", suggestHuman: false });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("咨询回答反馈与固定模型边界", () => {
  it("咨询不满意只提交质量反馈，不调用升级接口、不承诺更强模型或费用", async () => {
    await render(); await act(async () => down().click());
    expect(api.submit).toHaveBeenCalledWith({ scene: "ask-synthesize", action: "ask-synthesize", thumbs: "down", originalTier: "L2" });
    expect(api.escalate).not.toHaveBeenCalled();
    expect(host.textContent).toContain("已记录");
    expect(host.textContent).toContain("人工复核");
    for (const claim of ["更强大脑", "本次免费", "按倍率实扣", "升级版回答"]) expect(host.textContent).not.toContain(claim);
    expect(down().getAttribute("title")).not.toContain("更强");
  });
  it("咨询满意沿用反馈接口，仍记录up", async () => {
    await render(); await act(async () => up().click());
    expect(api.submit).toHaveBeenCalledWith({ scene: "ask-synthesize", action: "ask-synthesize", thumbs: "up", originalTier: "L2" });
    expect(api.escalate).not.toHaveBeenCalled();
    expect(host.textContent).toContain("已收到");
  });
  it("咨询不满意双击只写一次，加载中只表述反馈提交", async () => {
    let resolve!: (value: unknown) => void;
    api.submit.mockReturnValue(new Promise(yes => { resolve = yes; }));
    await render(); await act(async () => { down().click(); down().click(); });
    try {
      expect(api.submit).toHaveBeenCalledTimes(1);
      expect(down().disabled).toBe(true);
      expect(host.textContent).toContain("正在提交反馈");
      expect(host.textContent).not.toContain("更强大脑");
      expect(api.escalate).not.toHaveBeenCalled();
    } finally { await act(async () => resolve?.({ ok: true })); }
  });
  it("反馈失败显示未完成，允许明确重试且不触发模型调用", async () => {
    api.submit.mockRejectedValue(new Error("network unavailable"));
    await render(); await act(async () => down().click());
    expect(host.textContent).toContain("反馈暂时未能提交");
    expect(down().disabled).toBe(false);
    expect(api.escalate).not.toHaveBeenCalled();
  });
  it("其他行业的不满意保留既有升级调用语义", async () => {
    api.bundleId = "hotel"; await render(); await act(async () => down().click());
    expect(api.escalate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "分析制造业企业", fromTier: "L2" }));
    expect(api.submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("升级版回答");
  });
});
