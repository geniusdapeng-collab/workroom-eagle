#!/usr/bin/env node
/** 对已运行的正式客户端做无凭据负向验证，不写客户数据、不触发模型。 */
import assert from 'node:assert/strict';
const i = process.argv.indexOf('--base-url');
const target = new URL(i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:8897');
assert.equal(target.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), '仅允许本机验收目标');
assert.equal(target.username + target.password + target.search + target.hash, '');
const cases = [
  { path: '/trpc/auth.loginAs', body: { workspaceSlug: 'eagle-production', memberNo: 'OWNER' }, status: 403, name: '匿名指定OWNER不能签发正式身份' },
  { path: '/trpc/accounts.auth.guestEnter', body: {}, status: 403, name: '生产游客入口关闭' },
  { path: '/api/desktop/session', body: {}, status: 401, name: '缺少安装凭据不能建立正式会话' },
  { path: '/api/desktop/session', body: {}, headers: { 'x-workloom-desktop-secret': 'f'.repeat(64) }, status: 401, name: '错误安装凭据不能建立正式会话' },
  { path: '/api/desktop/session', body: {}, headers: { origin: 'http://untrusted.invalid' }, status: 403, name: '网页Origin不能使用安装会话入口' },
];
for (const item of cases) {
  const response = await fetch(new URL(item.path, target), { method: 'POST', headers: { 'content-type': 'application/json', ...item.headers }, body: JSON.stringify(item.body), signal: AbortSignal.timeout(10000), redirect: 'error' });
  const body = await response.text();
  assert.equal(response.status, item.status, `${item.name}: 实际HTTP ${response.status}`);
  assert.doesNotMatch(body, /"token"\s*:|"accessToken"\s*:/);
  console.log(`PASS ${item.name} (HTTP ${response.status})`);
}
console.log(`正式客户端认证负向验证通过：${cases.length}/${cases.length}`);
