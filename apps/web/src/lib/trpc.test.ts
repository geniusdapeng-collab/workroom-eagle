// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeTrpc = vi.hoisted(() => ({
  access: { me: { query: vi.fn() } },
  accounts: { auth: { guestEnter: { mutate: vi.fn() } } },
  auth: { loginAs: { mutate: vi.fn() } },
}));
vi.mock("@trpc/client", () => ({ createTRPCClient: vi.fn(() => fakeTrpc), httpBatchLink: vi.fn(() => ({})) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function loadSessionModule() { vi.resetModules(); return import("./trpc"); }
const bridge = (session: unknown) => Object.defineProperty(window, "workloomDesktop", { value: { session }, writable: true, configurable: true });
beforeEach(() => {
  localStorage.clear();
  delete (window as unknown as { workloomDesktop?: unknown }).workloomDesktop;
  fakeTrpc.access.me.query.mockReset();
  fakeTrpc.accounts.auth.guestEnter.mutate.mockReset();
  fakeTrpc.auth.loginAs.mutate.mockReset();
});

describe("正式本机会话与身份切换", () => {
  it("首次装机仅通过桌面 IPC 自动建立正式 owner 会话，并发挂载只换一次身份", async () => {
    const invoke = vi.fn(async () => ({ token: "formal-owner-token", identity: { memberNo: "OWNER" } }));
    bridge(invoke);
    const session = await loadSessionModule();
    await Promise.all([session.ensureDemoLogin(), session.ensureDemoLogin(), session.ensureGuestSession()]);
    expect(session.getToken()).toBe("formal-owner-token");
    expect(session.isGuest()).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fakeTrpc.accounts.auth.guestEnter.mutate).not.toHaveBeenCalled();
    expect(fakeTrpc.auth.loginAs.mutate).not.toHaveBeenCalled();
  });
  it("没有桌面桥和正式会话时显示错误，不能自动进入游客或演示", async () => {
    const session = await loadSessionModule();
    await expect(session.ensureDemoLogin()).rejects.toThrow("游客与演示入口已关闭");
    expect(fakeTrpc.accounts.auth.guestEnter.mutate).not.toHaveBeenCalled();
    expect(session.getToken()).toBeNull();
  });
  it("桌面会话失败不会降级游客；可以修复后重试", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("启动尚未完成")).mockResolvedValueOnce({ token: "recovered", identity: { memberNo: "OWNER" } });
    bridge(invoke);
    const session = await loadSessionModule();
    await expect(session.ensureDemoLogin()).rejects.toThrow("启动尚未完成");
    await session.ensureDemoLogin();
    expect(session.getToken()).toBe("recovered");
    expect(fakeTrpc.accounts.auth.guestEnter.mutate).not.toHaveBeenCalled();
  });
  it("旧令牌校验迟到失败时保留并发写入的新正式令牌", async () => {
    const session = await loadSessionModule();
    const validation = deferred<never>();
    fakeTrpc.access.me.query.mockReturnValueOnce(validation.promise);
    session.setToken("old-token");
    const attempt = session.ensureGuestSession();
    await vi.waitFor(() => expect(fakeTrpc.access.me.query).toHaveBeenCalledTimes(1));
    session.setToken("new-formal-token");
    validation.reject(new Error("旧令牌已失效"));
    await attempt;
    expect(session.getToken()).toBe("new-formal-token");
    expect(session.isGuest()).toBe(false);
  });
  it("正式登录期间丢弃较早的桌面 owner 响应，不覆盖用户选择的账号", async () => {
    const desktop = deferred<{ token: string; identity: { memberNo: string } }>();
    const login = deferred<{ token: string }>();
    const invoke = vi.fn(() => desktop.promise);
    bridge(invoke);
    const session = await loadSessionModule();
    fakeTrpc.auth.loginAs.mutate.mockReturnValueOnce(login.promise);
    const desktopAttempt = session.ensureGuestSession();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const formalAttempt = session.ensureDemoLogin("MEM-001");
    await vi.waitFor(() => expect(fakeTrpc.auth.loginAs.mutate).toHaveBeenCalledTimes(1));
    desktop.resolve({ token: "late-owner-token", identity: { memberNo: "OWNER" } });
    await desktopAttempt;
    expect(session.getToken()).toBeNull();
    login.resolve({ token: "selected-formal-token" });
    await formalAttempt;
    expect(session.getToken()).toBe("selected-formal-token");
  });
});
