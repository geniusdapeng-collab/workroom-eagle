import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/build-desktop.yml"), "utf8");
const builder = readFileSync(resolve(root, "electron-builder.yml"), "utf8");
const siteZh = readFileSync(resolve(root, "apps/site/index.html"), "utf8");
const siteEn = readFileSync(resolve(root, "apps/site/en.html"), "utf8");
const product = JSON.parse(readFileSync(resolve(root, "product.manifest.json"), "utf8"));

test("tag 发布显式选择 unsigned，手动发布保留 signed/unsigned 两条路径", () => {
  assert.match(workflow, /platform_signing:[\s\S]*options: \[signed, unsigned\][\s\S]*default: unsigned/u);
  assert.match(workflow, /PLATFORM_SIGNING: \$\{\{ github\.event_name == 'push' && 'unsigned' \|\| inputs\.platform_signing \}\}/u);
  assert.match(workflow, /if: env\.PLATFORM_SIGNING == 'signed'/u);
  assert.match(workflow, /if: env\.PLATFORM_SIGNING == 'unsigned'/u);
});

test("平台 unsigned 不放松内部 Bundle 签名与信任环", () => {
  assert.ok((workflow.match(/BUNDLE_SIGNING_PRIVATE_KEY/g) ?? []).length >= 4);
  assert.ok((workflow.match(/pnpm bundle:release/g) ?? []).length >= 2);
  assert.ok((workflow.match(/test -s build\/bundle-trust\.json/g) ?? []).length >= 2);
  assert.ok((workflow.match(/test -s "\$RES\/bundle-trust\.json"/g) ?? []).length >= 3);
  assert.match(builder, /from: build\/bundle-trust\.json[\s\S]*to: bundle-trust\.json/u);
});

test("清洁依赖安装后先构建行业契约再构建 Web", () => {
  const buildJobs = workflow.split("pnpm install --frozen-lockfile").slice(1);
  assert.equal(buildJobs.length, 2);
  for (const job of buildJobs) {
    const contractBuild = job.indexOf("pnpm -C packages/industry-contract build");
    const webBuild = job.indexOf("pnpm -C apps/web build");
    assert.ok(contractBuild >= 0 && contractBuild < webBuild);
  }
});

test("三平台 unsigned 打包关闭自动证书发现并只在 signed 模式验签", () => {
  assert.ok((workflow.match(/CSC_IDENTITY_AUTO_DISCOVERY: "false"/g) ?? []).length >= 3);
  assert.ok((workflow.match(/-c\.mac\.notarize=false/g) ?? []).length >= 2);
  assert.match(workflow, /if \[ "\$PLATFORM_SIGNING" = "signed" \]; then[\s\S]*codesign --verify --deep --strict[\s\S]*xcrun stapler validate/u);
  assert.match(workflow, /if \[ "\$PLATFORM_SIGNING" = "signed" \]; then[\s\S]*Get-AuthenticodeSignature/u);
});

test("Windows 冒烟隔离构建态服务端口并从同一临时根留存三段诊断", () => {
  for (const [name, port] of [
    ["WORKLOOM_PG_PORT", "55432"],
    ["WORKLOOM_SERVER_PORT", "58787"],
    ["WORKLOOM_WEB_PORT", "55173"],
    ["WORKLOOM_NATS_PORT", "54222"],
  ]) {
    assert.match(workflow, new RegExp(`${name}: ["']${port}["']`, "u"));
  }
  for (const rootName of ["wl-smoke", "wl-app-smoke", "wl-render-default"]) {
    assert.match(workflow, new RegExp(`RUNNER_TEMP/${rootName}`, "u"));
    assert.match(workflow, new RegExp(`runner\\.temp \\}\\}/${rootName}/logs`, "u"));
    assert.match(workflow, new RegExp(`runner\\.temp \\}\\}/${rootName}/install-state\\.json`, "u"));
  }
  assert.doesNotMatch(workflow, /\$\{TEMP\}\/wl-(?:smoke|app-smoke|render-default)/u);
  assert.match(workflow, /锁定源安装 17\.11\.0/u);
  assert.doesNotMatch(workflow, /锁定源安装 17\.2\.0/u);
});

test("产品身份、端口与固定下载资产名保持一致", () => {
  assert.equal(product.displayName, "鹰眼 AI 咨询管理系统");
  assert.equal(product.desktop.portOffset, 110);
  assert.equal(product.release.artifactPrefix, "Workroom.Eagle");
  assert.equal(product.release.workflow, ".github/workflows/build-desktop.yml");
  assert.match(builder, /productName: 鹰眼 AI 咨询管理系统/u);
  assert.match(builder, /workloomPortOffset: 110/u);
  assert.match(builder, /artifactName: "Workroom\.Eagle-\$\{os\}-\$\{arch\}\.\$\{ext\}"/u);
});

test("Release 明确披露未签名安装步骤", () => {
  assert.match(workflow, /平台签名状态/u);
  assert.match(workflow, /未签名、未 Apple 公证/u);
  assert.match(workflow, /xattr -cr/u);
  assert.match(workflow, /SmartScreen/u);
  assert.equal((workflow.match(/tag_name: \$\{\{ env\.VERSION \}\}/g) ?? []).length, 2);
});

test("官网固定下载入口与真实 DMG 资产一致，不保留历史 ZIP 死链", () => {
  for (const site of [siteZh, siteEn]) {
    assert.doesNotMatch(site, /WorkLoom-macOS\.zip/u);
    assert.match(site, /releases\/latest\/download\/Workroom\.Eagle-mac-arm64\.dmg/u);
    assert.doesNotMatch(site, /Workroom%20Eagle-/u);
  }
});
