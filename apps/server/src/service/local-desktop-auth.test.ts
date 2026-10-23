import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalDesktopAuth, demoAuthenticationAllowed } from './local-desktop-auth.js';

const identity = { memberId: 'owner-id', memberNo: 'OWNER', name: '本机负责人', role: 'owner' as const, tenantId: 'tenant-production', workspaceId: 'ws-production', plan: 'pro' as const };
const secret = 'a'.repeat(64);
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const loadOwner = vi.fn(async () => identity);
  const sign = vi.fn(async () => 'signed-formal-token');
  const app = createLocalDesktopAuth({ secret: () => secret, loadOwner, sign });
  const request = (headers: Record<string, string> = {}) => app.request('http://127.0.0.1/session', { method: 'POST', headers });
  return { loadOwner, sign, request };
}

describe('本机正式会话', () => {
  it('拒绝无凭据、错误凭据以及浏览器 Origin，拒绝时不查库也不签 token', async () => {
    const fx = fixture();
    expect((await fx.request()).status).toBe(401);
    expect((await fx.request({ 'x-workloom-desktop-secret': 'b'.repeat(64) })).status).toBe(401);
    expect((await fx.request({ 'x-workloom-desktop-secret': secret, origin: 'http://evil.example' })).status).toBe(403);
    expect(fx.loadOwner).not.toHaveBeenCalled();
    expect(fx.sign).not.toHaveBeenCalled();
  });
  it('只用受保护的固定 owner 事实，响应禁止缓存且不泄漏安装 secret', async () => {
    const fx = fixture();
    const response = await fx.request({ 'x-workloom-desktop-secret': secret });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { token: string; identity: { memberNo: string } };
    expect(body.token).toBe('signed-formal-token');
    expect(body.identity.memberNo).toBe('OWNER');
    expect(JSON.stringify(body)).not.toContain(secret);
  });
  it('正式工作区缺失时保留错误，不能降级游客或示例成员', async () => {
    const app = createLocalDesktopAuth({ secret: () => secret, loadOwner: async () => null, sign: vi.fn() });
    const response = await app.request('http://127.0.0.1/session', { method: 'POST', headers: { 'x-workloom-desktop-secret': secret } });
    expect(response.status).toBe(503);
  });
  it('production 永不允许演示认证，开发必须显式开关', () => {
    expect(demoAuthenticationAllowed({ NODE_ENV: 'production', WORKLOOM_ALLOW_DEMO_AUTH: '1' })).toBe(false);
    expect(demoAuthenticationAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(demoAuthenticationAllowed({ NODE_ENV: 'test', WORKLOOM_ALLOW_DEMO_AUTH: '1' })).toBe(true);
  });
});
