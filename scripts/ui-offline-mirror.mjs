import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** A byte-identical transport mirror; canonical release identity remains in artifact. */
export function resolveUiTransport(repoPath, state) {
  if (state.offlineMirror === undefined) return state.artifact.url;
  const mirror = state.offlineMirror;
  const expectedPath = `vendor/workloom-ui-${state.version}.tgz`;
  if (!mirror || typeof mirror !== "object" || Array.isArray(mirror)
    || Object.keys(mirror).sort().join(",") !== "canonicalUrl,path,sha512"
    || mirror.path !== expectedPath || mirror.canonicalUrl !== state.artifact.url
    || mirror.sha512 !== state.artifact.sha512) throw new Error("UI offlineMirror 必须精确绑定原版本、canonical URL 与原 SHA-512");
  const root = realpathSync(resolve(repoPath));
  let cursor = root;
  for (const part of expectedPath.split("/")) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("UI offlineMirror 路径禁止符号链接");
  }
  const stat = lstatSync(cursor);
  if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024 * 1024) throw new Error("UI offlineMirror 必须是仓内非空普通制品文件");
  const digest = "sha512-" + createHash("sha512").update(readFileSync(cursor)).digest("base64");
  if (digest !== state.artifact.sha512) throw new Error("UI offlineMirror 与原始 SHA-512 不一致");
  // Read a single archive member without extracting any path into the filesystem.
  let manifest;
  try { manifest = JSON.parse(execFileSync("tar", ["-xOf", cursor, "package/package.json"], { maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8")); }
  catch { throw new Error("UI offlineMirror 无法读取唯一 package/package.json"); }
  if (manifest.name !== state.package || manifest.version !== state.version) throw new Error("UI offlineMirror 内部包名或版本与原契约不一致");
  return `file:${expectedPath}`;
}
