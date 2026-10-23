#!/usr/bin/env node
/** 使用载荷自身的精确运行依赖启动 preview；不连接数据库、不调用模型。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少 ${name}`);
  return process.argv[index + 1];
}

const runtime = realpathSync(resolve(arg('--runtime')));
const node = realpathSync(resolve(arg('--node')));
const web = join(runtime, 'apps/web');
const vite = join(runtime, 'node_modules/vite/bin/vite.js');
const html = readFileSync(join(web, 'dist/index.html'), 'utf8');
assert.ok(existsSync(vite), '载荷缺少 Vite preview');
assert.match(html, /<title data-workloom-product-title>/u, '载荷缺少受控产品标题');
const listener = createServer();
await new Promise((done, reject) => {
  listener.once('error', reject);
  listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, done);
});
const address = listener.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
await new Promise((done, reject) => listener.close((error) => error ? reject(error) : done()));
let output = '';
let spawnError;
const child = spawn(node, [vite, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: web,
  env: { ...process.env, WEB_PORT: String(port), BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.on('error', (error) => { spawnError = error; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
  output = (output + chunk.toString('utf8')).slice(-65536);
});
const exited = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
let passed = false;
try {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`载荷 preview 提前退出：${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), html, 'preview 必须读取当前载荷 dist/index.html');
      passed = true;
      break;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!passed) throw new Error(`载荷 preview 未在 20 秒内就绪：${output}`);
  console.log('✅ 正式载荷 preview 实际启动并返回当前生产首页（仅运行依赖）');
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([exited, new Promise((done) => { timer = setTimeout(() => done('timeout'), 5000); })]);
  clearTimeout(timer);
  if (result === 'timeout' && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
