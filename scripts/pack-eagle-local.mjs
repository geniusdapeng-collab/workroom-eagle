#!/usr/bin/env node
/** 本机验收专用自包含客户端；不上传、不公证，不改变正式发行的签名与供应链门禁。 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstalledRuntimeTarget } from './runtime-deps-lock.mjs';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; }
const outArg = arg('--out');
const sourceArg = arg('--runtime-source');
if (!outArg || !sourceArg || process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('本机专用用法：node scripts/pack-eagle-local.mjs --runtime-source <已安装运行时根，仅复制node/pg/nats> --out <独立构建目录>；本轮只验证macOS arm64');
}
const OUT = resolve(outArg);
const SOURCE = realpathSync(sourceArg);
if (OUT === ROOT || ROOT.startsWith(`${OUT}/`) || OUT === SOURCE || SOURCE.startsWith(`${OUT}/`) || OUT.startsWith(`${SOURCE}/`)) throw new Error('构建输出不得覆盖仓库或已有运行时');
const product = JSON.parse(readFileSync(join(ROOT, 'product.manifest.json'), 'utf8'));
if (product.productId !== 'workroom-eagle') throw new Error('当前脚本只服务鹰眼本机验收');
for (const file of ['node/bin/node', 'pg/bin/postgres', 'pg/bin/initdb', 'pg/bin/pg_ctl', 'pg/lib/postgresql/vector.dylib', 'nats/nats-server']) {
  if (!existsSync(join(SOURCE, file))) throw new Error(`已有运行时缺少${file}`);
}
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...options });
const capture = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceCommit = capture('git', ['rev-parse', 'HEAD']);
const dirty = Boolean(capture('git', ['status', '--porcelain']));
const version = `local-${sourceCommit.slice(0, 12)}-${Date.now()}`;
mkdirSync(OUT, { recursive: true });
const payload = join(OUT, 'payload');
if (existsSync(payload)) rmSync(payload, { recursive: true });
mkdirSync(payload);
console.log('构建鹰眼本机客户端：正式空白工作区、真实模型，原安装数据目录保持不变。');
run('pnpm', ['-C', 'apps/web', 'build']);
const runtime = join(payload, 'runtime');
mkdirSync(runtime, { recursive: true });
const copy = (from, to) => cpSync(from, to, { recursive: true, dereference: false, filter: (file) => !file.split('/').includes('node_modules') });
for (const file of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'product.manifest.json', '.env.example']) copy(join(ROOT, file), join(runtime, file));
cpSync(join(ROOT, '.env.example'), join(runtime, '.env.defaults'));
if (existsSync(join(ROOT, 'AGENT-CAPABILITIES.md'))) cpSync(join(ROOT, 'AGENT-CAPABILITIES.md'), join(runtime, 'AGENT-CAPABILITIES.md'));
for (const path of ['apps/server', 'apps/web/src', 'apps/web/public', 'apps/web/dist', 'apps/web/index.html', 'apps/web/package.json', 'apps/web/vite.config.ts', 'apps/web/tsconfig.json', 'packages', 'bundles']) {
  copy(join(ROOT, path), join(runtime, path));
}
mkdirSync(join(runtime, 'scripts'), { recursive: true });
for (const file of ['migrate.ts', 'desktop-bootstrap-db.mjs', 'product-runtime.mjs', 'vite-product.mjs', 'seed-production.ts', 'agent-capabilities.mjs', 'agent-capabilities.core.json', 'agent-client-config.mjs', ...readdirSync(join(ROOT, 'scripts')).filter((name) => /^workloom-agent.*\.mjs$/.test(name))]) {
  cpSync(join(ROOT, 'scripts', file), join(runtime, 'scripts', file));
}
mkdirSync(join(runtime, 'docs'));
if (!existsSync(join(ROOT, 'docs/EAGLE-AGENT-GUIDE.md'))) throw new Error('Agent引导文档缺失，拒绝交付残缺安装包');
cpSync(join(ROOT, 'docs/EAGLE-AGENT-GUIDE.md'), join(runtime, 'docs/EAGLE-AGENT-GUIDE.md'));
for (const file of ['EAGLE-PRODUCTION-INSTALL.md', 'CONSULTING-LIVE-EVALUATION.md']) {
  if (existsSync(join(ROOT, 'docs', file))) cpSync(join(ROOT, 'docs', file), join(runtime, 'docs', file));
}
writeFileSync(join(runtime, 'VERSION'), `${version}\n`);
writeFileSync(join(payload, 'PAYLOAD_VERSION'), `${version}\n`);
const depStage = join(OUT, 'runtime-dependencies');
run(join(SOURCE, 'node/bin/node'), [join(ROOT, 'scripts/runtime-deps-lock.mjs'), 'stage', depStage, '--os', 'darwin', '--cpu', 'arm64']);
const deps = verifyInstalledRuntimeTarget(depStage, 'darwin', 'arm64');
cpSync(join(depStage, 'node_modules'), join(runtime, 'node_modules'), { recursive: true, dereference: false });
for (const directory of readdirSync(join(ROOT, 'packages'))) {
  const manifestFile = join(ROOT, 'packages', directory, 'package.json');
  if (!existsSync(manifestFile)) continue;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.name) copy(join(ROOT, 'packages', directory), join(runtime, 'node_modules', manifest.name));
}
// 只复制三个运行时二进制目录；绝不复制原客户的pgdata、.env、日志或业务资料。
for (const part of ['node', 'pg', 'nats']) cpSync(join(SOURCE, part), join(payload, part), { recursive: true, dereference: false });
// 开发依赖存在时的源码构建不能证明运行载荷可启动；归档前用载荷自身依赖实际起预览。
run(process.execPath, [join(ROOT, 'scripts/verify-desktop-preview.mjs'), '--runtime', runtime, '--node', join(payload, 'node/bin/node')]);
// 本机验收专用签名，只封装staged载荷；私钥仅内存/子进程env，绝不落盘或修改源Bundle。
const trustFile = join(OUT, 'bundle-trust.json');
if (existsSync(trustFile)) rmSync(trustFile);
const { privateKey } = generateKeyPairSync('ed25519');
run(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'scripts/bundle-governance.mts'), '--refresh-digests', '--release'], {
  env: { ...process.env, BUNDLES_ROOT: join(runtime, 'bundles'), BUNDLE_TRUST_OUTPUT: trustFile,
    BUNDLE_SIGNING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    BUNDLE_SIGNING_KEY_ID: `eagle-local-acceptance-${sourceCommit.slice(0, 12)}` },
});
const archive = join(OUT, 'payload.tar.gz');
run('tar', ['-czf', archive, '-C', payload, '.']);
const configFile = join(OUT, 'electron-builder.local.json');
const officialConfig = YAML.parse(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'));
writeFileSync(configFile, JSON.stringify({
  ...officialConfig,
  directories: { ...officialConfig.directories, output: join(OUT, 'app') },
  electronDist: dirname(realpathSync(join(ROOT, 'node_modules/electron/path.txt'))),
  extraResources: [
    { from: trustFile, to: 'bundle-trust.json' },
    { from: archive, to: 'payload.tar.gz' },
    { from: join(payload, 'PAYLOAD_VERSION'), to: 'payload/PAYLOAD_VERSION' },
  ],
  mac: { ...officialConfig.mac, identity: null, notarize: false },
  publish: null,
}, null, 2) + '\n');
// Electron 二进制由仓库精确依赖安装；electronDist应指向其dist目录。
const config = JSON.parse(readFileSync(configFile, 'utf8'));
config.electronDist = join(dirname(realpathSync(join(ROOT, 'node_modules/electron/path.txt'))), 'dist');
writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
run('pnpm', ['exec', 'electron-builder', '--dir', '--mac', '--arm64', '--config', configFile], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
const finalCommit = capture('git', ['rev-parse', 'HEAD']);
const finalDirty = Boolean(capture('git', ['status', '--porcelain']));
if (finalCommit !== sourceCommit || (!dirty && finalDirty)) throw new Error('构建期间源码基线发生变化，拒绝签发干净制品回执');
const receipt = {
  schemaVersion: 'eagle.local-client-build/v1', environment: 'client-runtime',
  sourceCommit, sourceDirty: dirty || finalDirty, payloadVersion: version, platform: process.platform, arch: process.arch,
  distribution: 'local-unsigned-not-notarized', payloadSha256: sha(archive), runtimeInventory: deps,
  bundleSignatureSource: 'local-acceptance-ephemeral-ed25519', bundleTrustSha256: sha(trustFile),
  binaries: ['node/bin/node', 'pg/bin/postgres', 'nats/nats-server'].map((file) => ({ file, sha256: sha(join(payload, file)) })),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(OUT, 'local-client-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`鹰眼本机自包含客户端已打包：${join(OUT, 'app')}（本机未公证制品）`);
