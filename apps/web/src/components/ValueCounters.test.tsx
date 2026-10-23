// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValueCounters } from "./ValueCounters";

const api = vi.hoisted(() => ({ status: vi.fn(), theater: vi.fn() }));
vi.mock("../lib/trpc", () => ({
  ensureDemoLogin: vi.fn(async () => {}),
  trpc: { onboarding: { status: { query: api.status } }, captain: { theater: { query: api.theater } } },
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.theater.mockResolvedValue({ pendingByTier: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("业务产物计数", () => {
  it("两个欢迎事件不冒充两项完成作业，正式空安装显示零份草稿", async () => {
    api.status.mockResolvedValue({ workspace: { events: 2, verifiedArtifacts: 0, agents: 22 } });
    await act(async () => root.render(<ValueCounters />));
    expect(host.textContent).toContain("可复核草稿0份");
    expect(host.textContent).toContain("团队成员22人");
    expect(host.textContent).not.toContain("已自主完成");
  });
  it("服务未提供产物统计时显示未知，不回落到事件总数", async () => {
    api.status.mockResolvedValue({ workspace: { events: 99, agents: 22 } });
    await act(async () => root.render(<ValueCounters />));
    expect(host.textContent).toContain("可复核草稿—份");
    expect(host.textContent).not.toContain("99");
  });
  it("读取失败显示错误与重试，恢复后只呈现真实统计", async () => {
    api.status.mockRejectedValueOnce(new Error("server unavailable")).mockResolvedValueOnce({ workspace: { verifiedArtifacts: 3, agents: 22 } });
    await act(async () => root.render(<ValueCounters />));
    expect(host.textContent).toContain("统计暂不可用");
    expect(host.textContent).not.toContain("0份");
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("重试统计");
    await act(async () => button.click());
    expect(host.textContent).toContain("可复核草稿3份");
    expect(host.textContent).not.toContain("统计暂不可用");
  });
});
