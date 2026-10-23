"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function credentialFile(supportDir) { return path.join(supportDir, "deepseek-key.enc"); }
function requireSecureStorage(storage) {
  if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === "basic_text") {
    throw new Error("系统凭据加密服务不可用，拒绝以明文保存模型密钥");
  }
}
function readModelKey(supportDir, storage) {
  const file = credentialFile(supportDir);
  if (!fs.existsSync(file)) return "";
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("本机模型凭据文件无效");
  requireSecureStorage(storage);
  const key = storage.decryptString(fs.readFileSync(file));
  if (!/^sk-[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error("本机模型凭据解密后格式不合法");
  return key;
}
function writeModelKey(supportDir, key, storage) {
  if (!/^sk-[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error("模型密钥格式不合法");
  requireSecureStorage(storage);
  fs.mkdirSync(supportDir, { recursive: true, mode: 0o700 });
  const encrypted = storage.encryptString(key);
  const file = credentialFile(supportDir);
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function writeAgentToken(token, run = spawnSync) {
  if (!/^[A-Za-z0-9_.-]{40,8192}$/.test(token)) throw new Error("Agent 会话格式不合法");
  // security 的交互模式从 stdin 读命令；令牌不进入 argv、shell、明文文件或日志。
  const result = run("/usr/bin/security", ["-i", "-q"], {
    input: `add-generic-password -U -s com.workloom.eagle.agent-access -a local-owner -w ${token}\n`,
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
  });
  if (result.error || result.status !== 0 || /(?:failed|error|denied)/i.test(result.stderr || "")) {
    throw new Error("Agent 系统钥匙串写入失败");
  }
  const readback = run("/usr/bin/security", ["find-generic-password", "-s", "com.workloom.eagle.agent-access", "-a", "local-owner", "-w"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  });
  if (readback.error || readback.status !== 0 || String(readback.stdout || "").trim() !== token) {
    throw new Error("Agent 系统钥匙串写入后回读不一致");
  }
}
module.exports = { readModelKey, writeModelKey, credentialFile, writeAgentToken };
