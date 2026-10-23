import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockPushDriver, pushMessage, WechatSubscribePushDriver } from './push.js';
import type { Queryable } from '../service-kb/kb.js';

afterEach(() => vi.unstubAllEnvs());
function fixture(channel = 'wechat-mini') {
  const calls: string[] = [];
  const db = { query: async (sql: string) => { calls.push(sql); return { rows: sql.startsWith('SELECT') ? [{ channel, openid: 'real-authorized-openid' }] : [{ id: 1 }] }; } } as unknown as Queryable;
  return { db, calls };
}
const input = { workspaceId: 'real-workspace', cUserId: 'real-user', kind: 'message' as const, payload: { text: 'authorized message' } };

describe('正式渠道投递不模拟', () => {
  it('未配置真实驱动时明确失败，绝不回落mock或制造通知记录', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fx = fixture();
    await expect(pushMessage(fx.db, input)).rejects.toThrow(/真实推送驱动未配置/);
    expect(fx.calls.some((sql) => sql.startsWith('INSERT'))).toBe(false);
  });
  it('生产环境即使显式注入mock也拒绝，模拟盒无写入', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fx = fixture('h5');
    const box: Array<Record<string, unknown>> = [];
    await expect(pushMessage(fx.db, input, { drivers: { mock: new MockPushDriver(box) } })).rejects.toThrow(/禁止模拟推送/);
    expect(box).toHaveLength(0);
    expect(fx.calls.some((sql) => sql.startsWith('INSERT'))).toBe(false);
  });
  it('真实发送成功才记录sent；供应商失败不伪造已发送记录', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const success = fixture();
    const send = vi.fn(async () => {});
    await expect(pushMessage(success.db, input, { drivers: { 'wechat-subscribe': new WechatSubscribePushDriver(send) } })).resolves.toMatchObject({ mock: false, deliveryState: 'sent', status: 'delivered' });
    expect(send).toHaveBeenCalledOnce();
    const failure = fixture();
    await expect(pushMessage(failure.db, input, { drivers: { 'wechat-subscribe': new WechatSubscribePushDriver(async () => { throw new Error('provider unavailable'); }) } })).rejects.toThrow('provider unavailable');
    expect(failure.calls.some((sql) => sql.startsWith('INSERT'))).toBe(false);
  });
});
