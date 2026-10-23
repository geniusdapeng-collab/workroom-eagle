import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml-governance";
import { resolveUiTransport } from "./ui-offline-mirror.mjs";
import { uiLockfileIntegrityErrors } from "./verify-ui-consumer.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "eagle-ui-mirror-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = JSON.parse(readFileSync(join(repo, ".workloom-ui.json"), "utf8"));
  mkdirSync(join(root, "vendor"));
  copyFileSync(join(repo, state.offlineMirror.path), join(root, state.offlineMirror.path));
  const lock = YAML.parse(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8"));
  const save = () => writeFileSync(join(root, "pnpm-lock.yaml"), YAML.stringify(lock));
  save(); return { root, state, lock, save };
}
test("original byte-identical tar and exact frozen contract pass", (t) => {
  const f = fixture(t);
  assert.equal(resolveUiTransport(f.root, f.state), "file:vendor/workloom-ui-0.1.19.tgz");
  assert.deepEqual(uiLockfileIntegrityErrors(f.root, f.state), []);
});
test("canonical transport remains supported without a mirror", (t) => {
  const f = fixture(t); delete f.state.offlineMirror;
  assert.equal(resolveUiTransport(f.root, f.state), f.state.artifact.url);
});
for (const [name, mutate] of [
  ["traversal", (f) => { f.state.offlineMirror.path = "../vendor/workloom-ui-0.1.19.tgz"; }],
  ["different canonical source", (f) => { f.state.offlineMirror.canonicalUrl = "https://example.invalid/fork.tgz"; }],
  ["different SRI", (f) => { f.state.offlineMirror.sha512 = "sha512-" + Buffer.alloc(64).toString("base64"); }],
  ["unknown fields", (f) => { f.state.offlineMirror.skipVerification = true; }],
  ["tampered tar", (f) => { writeFileSync(join(f.root, f.state.offlineMirror.path), "tampered"); }],
  ["symlinked archive", (f) => { rmSync(join(f.root, f.state.offlineMirror.path)); symlinkSync(join(repo, f.state.offlineMirror.path), join(f.root, f.state.offlineMirror.path)); }],
  ["symlinked parent", (f) => { rmSync(join(f.root, "vendor"), { recursive: true }); symlinkSync(join(repo, "vendor"), join(f.root, "vendor")); }],
]) test(`reject ${name}`, (t) => { const f = fixture(t); mutate(f); assert.throws(() => resolveUiTransport(f.root, f.state)); assert.notEqual(uiLockfileIntegrityErrors(f.root, f.state).length, 0); });
for (const [name, mutate] of [
  ["duplicate resolution", (f) => { f.lock.packages["@workloom/ui@0.0.1"] = {}; }],
  ["lock SRI drift", (f) => { Object.values(f.lock.packages).find((x) => x.resolution?.tarball?.startsWith("file:vendor/workloom-ui")).resolution.integrity = "sha512-wrong"; }],
  ["conflicting override", (f) => { f.lock.overrides["@workloom/ui@0.1.1"] = "file:vendor/old.tgz"; }],
  ["importer escape", (f) => { f.lock.importers["apps/web"].dependencies["@workloom/ui"].specifier = "file:../../../different.tgz"; }],
]) test(`reject ${name}`, (t) => { const f = fixture(t); mutate(f); f.save(); assert.notEqual(uiLockfileIntegrityErrors(f.root, f.state).length, 0); });
