import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildLocalAdaptationsManifest, isDeclaredLocalAddition, loadLocalAdaptations, LOCAL_ADAPTATIONS_FILE, resolveLocalAdaptation } from "./verify-local-adaptations.mjs";
import { verifyClientFoundationConsumer } from "./verify-client-foundation-consumer.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const managedPath = "apps/web/src/main.tsx";
const addedPath = "apps/web/src/local-auth.ts";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workloom-local-adaptation-unit-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text, mode = 0o644) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); chmodSync(file, mode); };
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const managedFiles = {};
  for (const path of [managedPath, "apps/webb/src/main.tsx", "apps/webc/src/main.tsx", "apps/webc/public/service-front.config.json"]) {
    const text = path.endsWith(".json") ? "{}\n" : "export const baseline = true;\n"; put(path, text); managedFiles[path] = { sha256: hash(text), mode: 0o644 };
  }
  const foundation = { schemaVersion: "workloom.client-foundation-state/v1", version: "0.1.19", sourceRef: "refs/tags/ui-v0.1.19", sourceCommit: "a".repeat(40), updatePolicy: "upgrade-pr-only",
    clients: { bPc: "apps/web", bMobile: "apps/webb", cMobile: "apps/webc" },
    allowedIndustryExtensionPaths: ["apps/*/src/extensions/**", "apps/*/src/projections/**", "apps/*/src/config/industry/**", "apps/*/src/theme/industry/**", "apps/*/public/industry/**"], managedFiles };
  put(".workloom-client-foundation.json", JSON.stringify(foundation, null, 2) + "\n");
  put(".workloom-ui-governance.json", JSON.stringify({ schemaVersion: "workloom.ui-governance-state/v1", files: {} }) + "\n");
  put(".workloom-ui.json", JSON.stringify({ version: "0.1.19" }) + "\n");
  git("init", "--quiet"); git("add", "."); git("-c", "user.name=Unit fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "baseline fixture");
  const baseline = git("rev-parse", "HEAD");
  const spec = { baselineConsumerCommit: baseline, task: { id: "T-2026-1023-0001", issue: "https://github.com/example/fixture/issues/21", reason: "正式安装所需的明确客户端身份与安全边界修补，逐文件审阅后保留上游来源。" },
    files: [{ path: managedPath, reason: "正式身份引导需要保留上游文件来源并加入受保护会话处理。" }] };
  const change = () => put(managedPath, "export const baseline = true;\nexport const protectedSession = true;\n");
  const seal = (input = spec) => { const manifest = buildLocalAdaptationsManifest(root, input); put(LOCAL_ADAPTATIONS_FILE, JSON.stringify(manifest, null, 2) + "\n"); return manifest; };
  return { root, put, git, foundation, baseline, spec, change, seal };
}

test("no manifest preserves the original strict hash and undeclared-file checks", (t) => {
  const f = fixture(t); assert.deepEqual(verifyClientFoundationConsumer(f.root), []); f.change();
  const context = loadLocalAdaptations(f.root); assert.equal(context.active, false); assert.deepEqual(context.errors, []);
  assert.deepEqual(resolveLocalAdaptation(context, managedPath, f.foundation.managedFiles[managedPath]), { ...f.foundation.managedFiles[managedPath], adapted: false });
  assert.equal(isDeclaredLocalAddition(context, addedPath), false);
  assert.ok(verifyClientFoundationConsumer(f.root).some((error) => error.includes("指纹漂移")));
});

test("a declared patch binds exact old/new blobs, modes and canonical diff while original source state stays unchanged", (t) => {
  const f = fixture(t); const state = readFileSync(join(f.root, ".workloom-client-foundation.json")); f.change(); const manifest = f.seal();
  const context = loadLocalAdaptations(f.root); assert.deepEqual(context.errors, []); assert.equal(context.active, true);
  const actual = resolveLocalAdaptation(context, managedPath, f.foundation.managedFiles[managedPath]);
  assert.equal(actual.adapted, true); assert.equal(actual.sha256, manifest.files[0].after.sha256); assert.equal(actual.mode, 0o644);
  assert.deepEqual(readFileSync(join(f.root, ".workloom-client-foundation.json")), state);
  assert.deepEqual(verifyClientFoundationConsumer(f.root), []);
});

test("only explicitly declared additions enter the client root and remain byte-bound", (t) => {
  const f = fixture(t); f.change(); f.put(addedPath, "export const safeLocalAuth = true;\n");
  f.seal({ ...f.spec, files: [...f.spec.files, { path: addedPath, reason: "新增正式身份适配模块，与原壳通过受控接口连接。" }] });
  const context = loadLocalAdaptations(f.root); assert.deepEqual(context.errors, []); assert.equal(isDeclaredLocalAddition(context, addedPath), true);
  assert.deepEqual(verifyClientFoundationConsumer(f.root), []);
  f.put("apps/web/src/undeclared.ts", "export const unrelated = true;\n");
  assert.ok(verifyClientFoundationConsumer(f.root).some((error) => error.includes("非白名单") && error.includes("undeclared.ts")));
  f.put(addedPath, "export const safeLocalAuth = false;\n");
  const changed = loadLocalAdaptations(f.root); assert.ok(changed.errors.length > 0); assert.equal(isDeclaredLocalAddition(changed, addedPath), false);
});

test("after-seal drift, mode changes and deletion disable all adaptation allowances", (t) => {
  for (const mutation of [
    (f) => f.put(managedPath, "export const unauthorized = true;\n"),
    (f) => chmodSync(join(f.root, managedPath), 0o755),
    (f) => unlinkSync(join(f.root, managedPath)),
  ]) {
    const f = fixture(t); f.change(); f.seal(); mutation(f); const context = loadLocalAdaptations(f.root);
    assert.ok(context.errors.length > 0); assert.equal(resolveLocalAdaptation(context, managedPath, f.foundation.managedFiles[managedPath]).adapted, false);
  }
});

test("wrong old blob, wrong patch hash and wrong original-state hash are each rejected", (t) => {
  for (const mutate of [
    (manifest) => { manifest.files[0].before.sha256 = "0".repeat(64); },
    (manifest) => { manifest.files[0].canonicalGitDiffSha256 = "0".repeat(64); },
    (manifest) => { manifest.originalStates[".workloom-client-foundation.json"] = "0".repeat(64); },
  ]) {
    const f = fixture(t); f.change(); const manifest = f.seal(); mutate(manifest); f.put(LOCAL_ADAPTATIONS_FILE, JSON.stringify(manifest));
    assert.ok(loadLocalAdaptations(f.root).errors.length > 0);
  }
});

test("changing upstream sourceCommit or managed fingerprints cannot be sealed as a consumer adaptation", (t) => {
  const f = fixture(t); f.change(); f.seal();
  f.put(".workloom-client-foundation.json", JSON.stringify({ ...f.foundation, sourceCommit: "b".repeat(40) }));
  assert.throws(() => buildLocalAdaptationsManifest(f.root, f.spec), /原始 state/);
  assert.ok(loadLocalAdaptations(f.root).errors.some((error) => error.includes("原始 state")));
});

test("glob, traversal, absolute, secret and protected-state paths cannot enter the explicit manifest", (t) => {
  const f = fixture(t); f.change();
  for (const path of ["apps/web/**", "../escape.ts", "/tmp/escape.ts", "apps/web/.env", ".workloom-client-foundation.json", ".workloom-ui-governance.json", LOCAL_ADAPTATIONS_FILE]) {
    assert.throws(() => f.seal({ ...f.spec, files: [{ path, reason: "此路径不应通过任何形式的本地适配范围校验。" }] }), /路径|state/);
  }
});

test("duplicates, undeclared keys, empty files and false added/modified claims fail closed", (t) => {
  const f = fixture(t); f.change();
  assert.throws(() => f.seal({ ...f.spec, files: [f.spec.files[0], f.spec.files[0]] }), /重复/);
  assert.throws(() => f.seal({ ...f.spec, blanketAllow: true }), /明确/);
  f.put(addedPath, ""); assert.throws(() => f.seal({ ...f.spec, files: [{ path: addedPath, reason: "空文件不应作为真实完成的身份适配模块。" }] }), /非空/);
  const manifest = f.seal(); manifest.files[0].kind = "added"; manifest.files[0].before = null; f.put(LOCAL_ADAPTATIONS_FILE, JSON.stringify(manifest));
  assert.ok(loadLocalAdaptations(f.root).errors.some((error) => error.includes("原始 blob")));
});

test("file and parent symlinks, including dangling links, are rejected", (t) => {
  const f = fixture(t); f.change(); f.seal(); unlinkSync(join(f.root, managedPath)); symlinkSync("missing-file", join(f.root, managedPath));
  assert.ok(loadLocalAdaptations(f.root).errors.some((error) => error.includes("符号链接")));
  symlinkSync(f.root, join(f.root, "apps/web/src/linked"));
  assert.throws(() => f.seal({ ...f.spec, files: [{ path: "apps/web/src/linked/a.ts", reason: "父目录符号链接不得作为适配白名单的间接逃逸。" }] }), /符号链接/);
});

test("a resolver cannot substitute a declaration for another original governance hash", (t) => {
  const f = fixture(t); f.change(); f.seal(); const context = loadLocalAdaptations(f.root);
  assert.throws(() => resolveLocalAdaptation(context, managedPath, { sha256: "0".repeat(64) }), /另一份原始/);
});

test("canonical patch hashes ignore local color, diff algorithm and indentation settings", (t) => {
  const f = fixture(t); f.change(); f.seal();
  f.git("config", "color.ui", "always"); f.git("config", "diff.algorithm", "histogram"); f.git("config", "diff.indentHeuristic", "true"); f.git("config", "core.quotePath", "false");
  assert.deepEqual(loadLocalAdaptations(f.root).errors, []);
});

test("a nonexistent or non-ancestor baseline and unsafe issue URL do not become valid provenance", (t) => {
  const f = fixture(t); f.change();
  assert.throws(() => f.seal({ ...f.spec, baselineConsumerCommit: "0".repeat(40) }));
  assert.throws(() => f.seal({ ...f.spec, task: { ...f.spec.task, issue: "https://token@example.invalid/issue?secret=bad" } }), /明确/);
});
