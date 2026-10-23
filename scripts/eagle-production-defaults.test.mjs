import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

test('正式默认禁止 mock 与演示 seed，默认初始化不批量扫描并执行 demo seeds', () => {
  const env = read('.env.example');
  assert.match(env, /^LLM_PROVIDER=deepseek$/m);
  assert.match(env, /^LLM_MODEL=deepseek-flash$/m);
  assert.match(env, /^DESKTOP_SEED_SCRIPT=scripts\/seed-production.ts$/m);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['db:seed'], /seed-production\.ts/);
  assert.doesNotMatch(pkg.scripts['db:seed'], /seed-consulting\.ts|scripts\/seed\.ts/);
  assert.doesNotMatch(read('scripts/bootstrap.sh'), /filter\(s=>\/\^db:seed/);
});

test('新装正式资料为空且 production seed 不制造事件、客户、会话、审批或定时任务', () => {
  const seed = read('scripts/seed-production.ts');
  assert.match(seed, /dataMode: ["']real["']/);
  assert.match(seed, /clients: \[\]/);
  assert.doesNotMatch(seed, /INSERT INTO (?:biz_events|threads|approvals|triggers|night_runs|c_users|c_conversations|c_tickets|demo_members|demo_orders)/i);
  assert.doesNotMatch(seed, /ON CONFLICT[^;]*DO UPDATE SET archive/s);
});

test('正式 preview 配置不能加载运行依赖锁之外的 Vitest，打包必须实际验证 preview', () => {
  const config = read('apps/web/vite.config.ts');
  const dependencies = JSON.parse(read('.workloom-runtime-deps/package.json')).dependencies;
  assert.equal(dependencies.vitest, undefined, '测试框架不进入正式运行依赖');
  assert.doesNotMatch(config, /from\s+["']vitest(?:\/[^"']*)?["']/u);
  assert.match(config, /from\s+["']vite["']/u);
  assert.match(read('scripts/pack-eagle-local.mjs'), /scripts\/verify-desktop-preview\.mjs/u);
  assert.match(read('scripts/pack-electron-payload.sh'), /scripts\/verify-desktop-preview\.mjs/u);
});
