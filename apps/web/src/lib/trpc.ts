/**
 * tRPC client（v11，httpBatchLink；类型由 @workloom/server 端到端推导——总纲 §2.4）
 * 轮询口径（F3.4/D6）：线程/夜班 5s，其余 10–15s（P1 接线起生效）
 * 鉴权：演示身份 JWT（B5）——token 存 localStorage；无 token 时 P1 以种子成员自动登录
 * （演示口径；真实登录页/多端登录在后续任务卡落地，JWT_SECRET 由部署方配置）
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@workloom/server/router";
import { DEMO_MEMBER, DEMO_WORKSPACE, storageKey } from "./product";

const TOKEN_KEY = storageKey("access-token");
// 身份切换代次：显式登录开始后，较早发出的游客请求不得再覆盖正式令牌。
let identityRevision = 0;
let formalLoginEpoch = 0;
let formalLoginsInFlight = 0;

function announceIdentityChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("workloom:identity-changed"));
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  identityRevision += 1;
  localStorage.setItem(TOKEN_KEY, token);
  // setToken 只用于正式身份；游客令牌必须通过 setGuestToken 原子写入身份标记。
  localStorage.removeItem(GUEST_KEY);
  announceIdentityChange();
}
export function clearToken(): void {
  identityRevision += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(GUEST_KEY);
  announceIdentityChange();
}

const REFRESH_KEY = storageKey("refresh-token");
export function getRefreshToken(): string | null { return localStorage.getItem(REFRESH_KEY); }
export function setRefreshToken(token: string): void { localStorage.setItem(REFRESH_KEY, token); }

/* 历史游客标记仅用于升级时清除；正式安装不再创建游客身份。 */
const GUEST_KEY = storageKey("guest");
export function isGuest(): boolean { return localStorage.getItem(GUEST_KEY) === "1"; }
export function clearGuestFlag(): void { localStorage.removeItem(GUEST_KEY); }


let validatedToken: string | null = null;
let guestSessionPromise: Promise<void> | null = null;

/** 桌面升级可能轮换本机 JWT 密钥；不能只凭 localStorage 中“有字符串”判断会话有效。 */
async function validateStoredSession(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  if (validatedToken === token) return true;
  const requestRevision = identityRevision;
  try {
    const access = await trpc.access.me.query() as { subject?: { kind?: string } };
    if (access?.subject?.kind === "guest") {
      if (identityRevision === requestRevision) clearToken();
      return false;
    }
    // 校验返回期间身份已变化时，结果只属于旧令牌；保留新身份并阻止游客降级。
    if (identityRevision !== requestRevision || getToken() !== token) return getToken() !== null;
    validatedToken = token;
    return true;
  } catch {
    // 旧令牌的迟到失败不能清掉并发登录刚写入的新令牌。
    if (identityRevision === requestRevision && getToken() === token) {
      clearToken();
      if (validatedToken === token) validatedToken = null;
    }
    return false;
  }
}

/** 兼容历史挂载调用名：无令牌时只从可信桌面 IPC 建立正式会话，禁止降级游客。 */
export async function ensureGuestSession(): Promise<void> {
  if (formalLoginsInFlight > 0) return;
  if (guestSessionPromise) return guestSessionPromise;
  guestSessionPromise = (async () => {
    if (isGuest()) clearToken();
    if (await validateStoredSession()) return;
    if (formalLoginsInFlight > 0 || getToken()) return;
    const desktop = (window as unknown as { workloomDesktop?: { session: () => Promise<{ token: string; identity: { memberNo: string } }> } }).workloomDesktop;
    if (!desktop) throw new Error("请使用已安装的鹰眼客户端，或通过正式账号登录。游客与演示入口已关闭。");
    const requestRevision = identityRevision;
    const result = await desktop.session();
    if (!result.token || result.identity?.memberNo === "GUEST") throw new Error("正式本机会话未建立");
    if (formalLoginsInFlight > 0 || identityRevision !== requestRevision || getToken()) return;
    setToken(result.token);
    validatedToken = result.token;
  })();
  try { await guestSessionPromise; } finally { guestSessionPromise = null; }
}

export const trpc: ReturnType<typeof createTRPCClient<AppRouter>> = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/trpc",
      headers: () => {
        const token = getToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});

/**
 * 演示身份自动登录（演示/开发便利；生产部署用真实登录替代）。
 * 工作区与成员均可经 VITE_DEMO_WORKSPACE / VITE_DEMO_MEMBER 覆盖——
 * 不写死在调用侧，客户自建工作区（非种子库默认工作区）时演示登录仍可用。
 *
 * 无参调用通过可信桌面 IPC 建立正式本机会话；
 * 仅显式传 memberNo 时才走旧的种子成员真身份登录（开发后门专用，生产不出现）。
 */
export const DEV_DEMO_MEMBER = DEMO_MEMBER;
export async function ensureDemoLogin(memberNo?: string): Promise<void> {
  if (memberNo) {
    // 先使并发中的游客请求失效；只允许最后一次显式登录写入正式身份。
    const loginEpoch = ++formalLoginEpoch;
    formalLoginsInFlight += 1;
    identityRevision += 1;
    try {
      if (!isGuest() && await validateStoredSession()) return;
      if (isGuest()) clearToken();
      const r = await trpc.auth.loginAs.mutate({ workspaceSlug: DEMO_WORKSPACE, memberNo });
      if (loginEpoch !== formalLoginEpoch) return;
      setToken(r.token);
      validatedToken = r.token;
      return;
    } finally {
      formalLoginsInFlight = Math.max(0, formalLoginsInFlight - 1);
    }
  }
  return ensureGuestSession();
}
