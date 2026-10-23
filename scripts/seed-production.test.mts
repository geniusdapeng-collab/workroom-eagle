import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeProduction, PRODUCTION_TENANT_ID } from './seed-production.js';

function fixture(injectedFailure = '') {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = { query: async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (injectedFailure && sql.includes(injectedFailure)) throw new Error('injected database failure');
    return { rows: sql.startsWith('SELECT tenant_id') ? [{ tenant_id: PRODUCTION_TENANT_ID, bundle_id: 'consulting', is_example: false }] : [] };
  } };
  return { client, calls };
}
test('正式安装仅生产元数据，无模拟业务内容，客户档案重复安装不覆盖', async () => {
  const fx = fixture();
  await initializeProduction(fx.client);
  assert.equal(fx.calls.at(-1)?.sql, 'COMMIT');
  assert.equal(fx.calls.filter((r) => r.sql.includes('INSERT INTO agents')).length, 22);
  assert.equal(fx.calls.filter((r) => r.sql.includes('INSERT INTO skills ')).length, 199);
  const profile = fx.calls.find((r) => r.sql.includes('INSERT INTO profiles'))!;
  const archive = JSON.parse(String(profile.params?.[2]));
  assert.equal(archive.dataMode, 'real');
  assert.deepEqual(archive.clients, []);
  assert.match(profile.sql, /ON CONFLICT \(workspace_id\) DO NOTHING/);
  assert.equal(fx.calls.some((r) => /INSERT INTO (biz_events|threads|approvals|triggers|c_users)/.test(r.sql)), false);
});
test('初始化中途数据库失败回滚，不提交半套数字员工或空档案', async () => {
  const fx = fixture('INSERT INTO agents');
  await assert.rejects(initializeProduction(fx.client), /injected database failure/);
  assert.equal(fx.calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(fx.calls.some((r) => r.sql === 'COMMIT'), false);
});
test('既有工作区身份冲突拒绝覆盖，并回滚所有新写入', async () => {
  const fx = fixture();
  fx.client.query = async (sql, params) => { fx.calls.push({ sql, params }); return { rows: sql.startsWith('SELECT tenant_id') ? [{ tenant_id: 'another-tenant', bundle_id: 'consulting', is_example: false }] : [] }; };
  await assert.rejects(initializeProduction(fx.client), /身份冲突/);
  assert.equal(fx.calls.at(-1)?.sql, 'ROLLBACK');
});
