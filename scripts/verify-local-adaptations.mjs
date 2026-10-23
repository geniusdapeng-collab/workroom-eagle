#!/usr/bin/env node
/** Explicit, reviewable consumer adaptations. Original foundation/governance state is never rewritten. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_ADAPTATIONS_FILE = ".workloom-local-adaptations.json";
export const LOCAL_ADAPTATIONS_SCHEMA = "workloom.local-adaptations/v1";
export const PROTECTED_ADAPTATION_STATES = Object.freeze([".workloom-client-foundation.json", ".workloom-ui-governance.json"]);
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_ENTRIES = 100;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value, keys) => plain(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));

function git(root, args) {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
}
function safePath(root, path, { allowState = false } = {}) {
  if (typeof path !== "string" || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)
    || path.split("/").some((part) => [".", "..", ".git"].includes(part)) || /(?:^|\/)\.env(?:$|\.(?!example$))/.test(path)
    || (!allowState && (PROTECTED_ADAPTATION_STATES.includes(path) || path === LOCAL_ADAPTATIONS_FILE))) throw new Error(`非法或受保护的适配路径：${String(path)}`);
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new Error(`适配路径越界：${path}`);
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    // lstat also detects dangling symlinks, which existsSync intentionally does not.
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`适配路径禁止符号链接：${path}`); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
  }
  return target;
}
function currentFile(root, path, options) {
  const file = safePath(root, path, options); const stat = lstatSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) throw new Error(`适配必须是非空普通文件且不超过 8 MiB：${path}`);
  const mode = stat.mode & 0o777;
  if (![0o644, 0o755].includes(mode)) throw new Error(`适配文件模式必须精确为 0644/0755：${path}`);
  return { sha256: sha256(readFileSync(file)), mode };
}
function baselineFile(root, commit, path) {
  const entry = git(root, ["ls-tree", commit, "--", path]).toString("utf8").trim();
  if (!entry) return null;
  const match = /^(100644|100755) blob [a-f0-9]+\t(.+)$/.exec(entry);
  if (!match || match[2] !== path) throw new Error(`审计基线文件不是允许的普通 blob：${path}`);
  const bytes = git(root, ["show", `${commit}:${path}`]);
  return { sha256: sha256(bytes), mode: match[1] === "100755" ? 0o755 : 0o644 };
}
function resolvedBaseline(root, commit) {
  if (!COMMIT.test(commit ?? "")) throw new Error("本地适配基线必须是完整 40 位消费者提交");
  if (git(root, ["rev-parse", "--verify", `${commit}^{commit}`]).toString("utf8").trim() !== commit) throw new Error("本地适配基线不可解析");
  const relation = spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, stdio: "pipe" });
  if (relation.error || relation.status !== 0) throw new Error("本地适配基线必须属于当前消费者历史");
  return commit;
}
export function canonicalLocalDiff(root, baselineCommit, path, added = false) {
  safePath(root, path);
  const config = ["-c", "diff.algorithm=myers", "-c", "diff.indentHeuristic=false", "-c", "core.quotePath=true", "-c", "core.autocrlf=false"];
  const options = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", "--unified=3", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/"];
  const args = [...config, ...options, ...(added ? ["--no-index", "--", "/dev/null", path] : [baselineCommit, "--", path])];
  const result = spawnSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`无法复算适配补丁：${path}`);
  if (!result.stdout?.length) throw new Error(`适配没有相对基线的真实补丁：${path}`);
  return result.stdout;
}
function taskErrors(task) {
  const errors = [];
  if (!sameKeys(task, ["id", "issue", "reason"]) || !/^T-\d{4}-\d{4}-\d{4}$/.test(task?.id ?? "")
    || typeof task?.reason !== "string" || task.reason.trim().length < 16) errors.push("本地适配必须绑定任务号、真实问题链接与具体必要性说明");
  try {
    const url = new URL(task?.issue);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !((url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/.test(url.pathname))
        || (url.hostname === "cnb.cool" && /\/issues\/[1-9]\d*$/.test(url.pathname)))) throw new Error();
  } catch { errors.push("本地适配问题链接必须是明确的 HTTPS issue，不能带凭据或查询参数"); }
  return errors;
}
function validFingerprint(value) { return sameKeys(value, ["sha256", "mode"]) && SHA.test(value.sha256 ?? "") && [0o644, 0o755].includes(value.mode); }

export function loadLocalAdaptations(repoPath, { manifestFile = LOCAL_ADAPTATIONS_FILE } = {}) {
  const root = realpathSync(resolve(repoPath)); const errors = []; const entries = new Map();
  const context = { root, active: false, errors, manifest: null, entries };
  let manifestPath;
  try { manifestPath = safePath(root, manifestFile, { allowState: true }); }
  catch (error) { context.active = true; errors.push(error.message); return context; }
  if (!existsSync(manifestPath)) return context;
  context.active = true;
  let manifest;
  try {
    const info = lstatSync(manifestPath);
    if (!info.isFile() || info.size === 0 || info.size > 128 * 1024 || (info.mode & 0o777) !== 0o644) throw new Error("文件类型、模式或大小非法");
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")); context.manifest = manifest;
  } catch { errors.push("本地适配清单必须是仓内非空、非符号链接的有效 JSON 普通文件"); return context; }
  if (!sameKeys(manifest, ["schemaVersion", "baselineConsumerCommit", "originalStates", "task", "files"]) || manifest.schemaVersion !== LOCAL_ADAPTATIONS_SCHEMA) errors.push("本地适配清单 schema/字段无效");
  errors.push(...taskErrors(manifest.task));
  try { resolvedBaseline(root, manifest.baselineConsumerCommit); }
  catch (error) { errors.push(error.message); return context; }
  if (!sameKeys(manifest.originalStates, PROTECTED_ADAPTATION_STATES)) errors.push("本地适配必须绑定且仅绑定两份原始基座/governance state");
  for (const path of PROTECTED_ADAPTATION_STATES) {
    try {
      const baseline = baselineFile(root, manifest.baselineConsumerCommit, path);
      const actual = currentFile(root, path, { allowState: true });
      if (!baseline || !SHA.test(manifest.originalStates?.[path] ?? "") || baseline.sha256 !== manifest.originalStates[path] || actual.sha256 !== baseline.sha256 || actual.mode !== baseline.mode) {
        errors.push(`原始 state 被修改、来源不符或指纹不匹配：${path}`);
      }
    } catch (error) { errors.push(`${path}：${error.message}`); }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_ENTRIES) { errors.push("本地适配必须显式列出 1–100 个文件，不能用 glob"); return context; }
  for (const entry of manifest.files) {
    const path = entry?.path;
    try {
      if (!sameKeys(entry, ["path", "kind", "before", "after", "canonicalGitDiffSha256", "reason"]) || !["modified", "added"].includes(entry.kind)
        || !validFingerprint(entry.after) || !SHA.test(entry.canonicalGitDiffSha256 ?? "")
        || typeof entry.reason !== "string" || entry.reason.trim().length < 12) throw new Error("适配条目字段、散列、模式或具体修补理由无效");
      safePath(root, path);
      if (entries.has(path)) throw new Error("适配路径重复");
      entries.set(path, entry);
      const baseline = baselineFile(root, manifest.baselineConsumerCommit, path);
      if (entry.kind === "added" ? baseline !== null || entry.before !== null : !validFingerprint(entry.before) || !baseline
        || baseline.sha256 !== entry.before.sha256 || baseline.mode !== entry.before.mode) throw new Error("适配原始 blob/模式或新增文件的基线不存在证明不匹配");
      const actual = currentFile(root, path);
      if (actual.sha256 !== entry.after.sha256 || actual.mode !== entry.after.mode) throw new Error("适配后文件内容或模式与声明不符");
      if (entry.before && actual.sha256 === entry.before.sha256 && actual.mode === entry.before.mode) throw new Error("适配条目没有实际改动");
      if (sha256(canonicalLocalDiff(root, manifest.baselineConsumerCommit, path, entry.kind === "added")) !== entry.canonicalGitDiffSha256) throw new Error("适配的 canonical Git diff SHA256 不符");
    } catch (error) { errors.push(`${String(path)}：${error.message}`); }
  }
  return context;
}

export function resolveLocalAdaptation(context, path, original) {
  const entry = context.entries.get(path);
  if (!entry || context.errors.length) return { ...original, adapted: false };
  if (entry.kind !== "modified" || entry.before.sha256 !== original.sha256 || (original.mode !== undefined && entry.before.mode !== original.mode)) {
    throw new Error(`本地适配不能覆盖另一份原始受管指纹：${path}`);
  }
  return { sha256: entry.after.sha256, ...(original.mode !== undefined ? { mode: entry.after.mode } : {}), adapted: true };
}
export function isDeclaredLocalAddition(context, path) {
  return context.errors.length === 0 && context.entries.get(path)?.kind === "added";
}

export function buildLocalAdaptationsManifest(repoPath, spec) {
  const root = realpathSync(resolve(repoPath));
  if (!sameKeys(spec, ["baselineConsumerCommit", "task", "files"]) || taskErrors(spec.task).length || !Array.isArray(spec.files) || !spec.files.length || spec.files.length > MAX_ENTRIES) throw new Error("seal 需要明确 baseline/task 与逐文件 path/reason，不能自动放行所有改动");
  const baselineConsumerCommit = resolvedBaseline(root, spec.baselineConsumerCommit);
  const originalStates = {};
  for (const path of PROTECTED_ADAPTATION_STATES) {
    const original = baselineFile(root, baselineConsumerCommit, path); const current = currentFile(root, path, { allowState: true });
    if (!original || current.sha256 !== original.sha256 || current.mode !== original.mode) throw new Error(`seal 拒绝修改原始 state：${path}`);
    originalStates[path] = original.sha256;
  }
  const seen = new Set(); const files = [];
  for (const item of spec.files) {
    if (!sameKeys(item, ["path", "reason"]) || typeof item.reason !== "string" || item.reason.trim().length < 12) throw new Error("seal 文件必须含明确 path 与具体 reason");
    safePath(root, item.path); if (seen.has(item.path)) throw new Error(`seal 路径重复：${item.path}`); seen.add(item.path);
    const before = baselineFile(root, baselineConsumerCommit, item.path); const after = currentFile(root, item.path);
    if (before && before.sha256 === after.sha256 && before.mode === after.mode) throw new Error(`seal 拒绝无改动条目：${item.path}`);
    files.push({ path: item.path, kind: before ? "modified" : "added", before, after,
      canonicalGitDiffSha256: sha256(canonicalLocalDiff(root, baselineConsumerCommit, item.path, !before)), reason: item.reason });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { schemaVersion: LOCAL_ADAPTATIONS_SCHEMA, baselineConsumerCommit, originalStates, task: spec.task, files };
}

function main() {
  const args = process.argv.slice(2); const command = args[0] === "seal" ? args.shift() : "verify";
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--repo", "--spec"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("用法：verify-local-adaptations.mjs [seal --spec <explicit.json>] [--repo <repo>]");
    options[args[i]] = args[i + 1];
  }
  const root = resolve(options["--repo"] ?? ".");
  if (command === "seal") {
    if (!options["--spec"]) throw new Error("seal 缺少显式 --spec 文件");
    const manifest = buildLocalAdaptationsManifest(root, JSON.parse(readFileSync(resolve(options["--spec"]), "utf8")));
    const target = safePath(realpathSync(root), LOCAL_ADAPTATIONS_FILE, { allowState: true });
    writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  } else if (options["--spec"]) throw new Error("--spec 仅可用于显式 seal");
  const context = loadLocalAdaptations(root);
  if (context.errors.length) { for (const error of context.errors) console.error(error); process.exitCode = 1; return; }
  console.log(context.active ? `本地适配清单已核验：${context.entries.size} 个明确文件；原始基座状态完整保留，当前并非零漂移。` : "没有本地适配清单：继续按原基座严格指纹与新增文件规则验收。");
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`本地适配校验失败：${error.message}`); process.exitCode = 1; }
}
