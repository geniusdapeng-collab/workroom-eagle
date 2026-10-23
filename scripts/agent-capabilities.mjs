/**
 * Agent capability transport shared by WorkLoom CLI and stdio MCP.
 *
 * The manifest is a reviewed repository asset, never a client supplied route.
 * All mutations still pass through the existing service side authorization,
 * tenant, fence and receipt code. A client response is not execution proof.
 */
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const CATALOG_SCHEMA = "workloom.agent-capabilities/v1";
export const RESULT_SCHEMA = "workloom.capability-result/v1";
const OPERATIONS = new Set(["read", "preview", "execute", "receipt"]);
const RISKS = new Set(["low", "moderate", "review"]);
const DATA_MODES = new Set(["real", "simulated", "provided-unverified", "unverified"]);
const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const TRPC_PATH = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
const BUNDLE_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export class CapabilityError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function reject(code, message, exitCode = 2) {
  throw new CapabilityError(code, message, exitCode);
}

async function jsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    reject("CATALOG_INVALID", "无法读取或解析能力清单 " + file + "：" + error.message);
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDescriptor(item, bundleId) {
  if (!object(item) || !CAPABILITY_ID.test(item.id ?? "")) {
    reject("CATALOG_INVALID", "能力 ID 无效：" + String(item?.id));
  }
  if (!/^\d+\.\d+\.\d+$/u.test(item.version ?? "")) {
    reject("CATALOG_INVALID", item.id + " 缺少语义版本");
  }
  for (const key of ["title", "description"]) {
    if (typeof item[key] !== "string" || !item[key].trim()) {
      reject("CATALOG_INVALID", item.id + " 缺少 " + key);
    }
  }
  if (!OPERATIONS.has(item.operation) || !RISKS.has(item.risk) || !DATA_MODES.has(item.dataMode)) {
    reject("CATALOG_INVALID", item.id + " 的操作、风险或数据模式无效");
  }
  if (!object(item.inputSchema) || item.inputSchema.type !== "object") {
    reject("CATALOG_INVALID", item.id + " 必须声明 object inputSchema");
  }
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
    reject("CATALOG_INVALID", item.id + " enabled 必须为 boolean");
  }
  if (item.enabled === false && (typeof item.disabledReason !== "string" || !item.disabledReason.trim())) {
    reject("CATALOG_INVALID", item.id + " 禁用时必须说明原因");
  }
  const t = item.transport;
  if (!object(t)) reject("CATALOG_INVALID", item.id + " 缺少 transport");
  if (t.timeoutMs !== undefined && (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 1000 || t.timeoutMs > 120000)) {
    reject("CATALOG_INVALID", item.id + " 传输超时须为 1000–120000 毫秒");
  }
  if (t.kind === "trpc") {
    if (!TRPC_PATH.test(t.path ?? "") || !["query", "mutation"].includes(t.method)) {
      reject("CATALOG_INVALID", item.id + " tRPC 过程声明无效");
    }
    if (/^(auth|accounts|system)\./u.test(t.path)) {
      reject("CATALOG_INVALID", item.id + " 不可把登录或系统过程登记为业务能力");
    }
  } else if (t.kind === "c-service") {
    if (typeof t.path !== "string" || !/^\/c\/[A-Za-z0-9_/{}/.-]+$/u.test(t.path)
        || t.path.includes("..") || !["GET", "POST"].includes(t.method)) {
      reject("CATALOG_INVALID", item.id + " C 服务路径/方法无效");
    }
  } else if (t.kind === "local") {
    const prefix = "bundles/" + bundleId + "/capabilities/";
    if (bundleId === "core" || typeof t.module !== "string"
        || !t.module.startsWith(prefix) || !/\.mjs$/u.test(t.module)
        || t.module.includes("..") || !/^[A-Za-z_$][\w$]*$/u.test(t.export ?? "")) {
      reject("CATALOG_INVALID", item.id + " 本地模块必须位于本行业 capabilities/ 下");
    }
    if (item.operation === "execute") {
      reject("CATALOG_INVALID", item.id + " 本地模块不可执行写操作");
    }
  } else {
    reject("CATALOG_INVALID", item.id + " transport.kind 无效");
  }
  if (item.operation === "execute" && !Array.isArray(item.inputSchema.required)) {
    reject("CATALOG_INVALID", item.id + " 执行能力必须声明必填字段");
  }
  if (item.operation === "execute" && !item.inputSchema.required.includes("idempotencyKey")) {
    reject("CATALOG_INVALID", item.id + " 执行能力必须要求 idempotencyKey");
  }
  return Object.freeze(item);
}

function validateManifest(manifest, expectedBundle) {
  if (!object(manifest) || manifest.schemaVersion !== CATALOG_SCHEMA
      || manifest.bundleId !== expectedBundle || !Array.isArray(manifest.capabilities)) {
    reject("CATALOG_INVALID", expectedBundle + " 能力清单 schemaVersion/bundleId/capabilities 无效");
  }
  return manifest.capabilities.map((item) => validateDescriptor(item, expectedBundle));
}

export async function loadCatalog(root = process.cwd(), bundleOverride) {
  const repositoryRoot = resolve(root);
  const product = await jsonFile(join(repositoryRoot, "product.manifest.json"));
  const bundle = bundleOverride ?? process.env.WORKLOOM_BUNDLE ?? product.defaultBundle;
  if (!BUNDLE_NAME.test(bundle ?? "")) reject("CATALOG_INVALID", "默认行业包名称无效");
  const core = validateManifest(
    await jsonFile(join(import.meta.dirname, "agent-capabilities.core.json")), "core");
  let industry = [];
  const industryFile = join(repositoryRoot, "bundles", bundle, "agent-capabilities.json");
  try {
    await readFile(industryFile);
    industry = validateManifest(await jsonFile(industryFile), bundle);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = new Map();
  const toolNames = new Set();
  for (const item of [...core, ...industry]) {
    if (entries.has(item.id)) reject("CATALOG_INVALID", "能力 ID 重复：" + item.id);
    if (toolNames.has(toolName(item))) reject("CATALOG_INVALID", "MCP 工具名称冲突：" + item.id);
    toolNames.add(toolName(item));
    entries.set(item.id, item);
  }
  return { root: repositoryRoot, product, bundle, entries };
}

function schemaIssue(value, schema, at) {
  if (!object(schema)) return at + " 的 schema 无效";
  const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? "object"];
  const actual = value === null ? "null" : Array.isArray(value) ? "array"
    : Number.isInteger(value) ? "integer" : typeof value;
  if (!types.some((type) => type === actual || (type === "number" && actual === "integer"))) {
    return at + " 类型错误，要求 " + types.join("|");
  }
  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    return at + " 不在允许值内";
  }
  if (actual === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return at + " 太短";
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return at + " 太长";
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return at + " 格式不正确";
  }
  if (actual === "integer" || actual === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return at + " 小于最小值";
    if (schema.maximum !== undefined && value > schema.maximum) return at + " 大于最大值";
  }
  if (actual === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) return at + " 项数不足";
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return at + " 项数过多";
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        const issue = schemaIssue(value[i], schema.items, at + "[" + i + "]");
        if (issue) return issue;
      }
    }
  }
  if (actual === "object") {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return at + "." + key + " 缺失";
    }
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (!property && schema.additionalProperties === false) return at + "." + key + " 不允许";
      if (property) {
        const issue = schemaIssue(child, property, at + "." + key);
        if (issue) return issue;
      }
    }
  }
  return null;
}

export function validateInput(descriptor, input) {
  const value = input ?? {};
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > MAX_INPUT_BYTES) reject("INPUT_TOO_LARGE", "输入超过 8 MiB");
  const issue = schemaIssue(value, descriptor.inputSchema, "input");
  if (issue) reject("INVALID_INPUT", issue);
  if (descriptor.operation === "execute"
      && (typeof value.idempotencyKey !== "string" || value.idempotencyKey.trim().length < 8)) {
    reject("INVALID_INPUT", "execute 必须提供至少 8 字符的 idempotencyKey");
  }
  return value;
}

function baseUrlFor(catalog, candidate) {
  const offset = catalog.product.desktop?.portOffset;
  const fallback = "http://127.0.0.1:" + (8787 + (Number.isInteger(offset) ? offset : 0));
  let url;
  try { url = new URL(candidate ?? process.env.WORKLOOM_BASE_URL ?? fallback); }
  catch { reject("INVALID_BASE_URL", "服务 URL 无效"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    reject("INVALID_BASE_URL", "服务必须为 HTTPS，或本机回环 HTTP，且 URL 不含凭据/路径/查询");
  }
  return { url: url.origin, loopback };
}

function safeMessage(value, secrets = []) {
  let message = String(value ?? "远端失败");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      message = message.split(secret).join("[REDACTED]");
    }
  }
  return message.replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]").slice(0, 400);
}

export function sanitizeErrorMessage(error, env = process.env) {
  return safeMessage(error instanceof Error ? error.message : error,
    [env.WORKLOOM_ACCESS_TOKEN, env.WORKLOOM_C_TOKEN]);
}

async function fetchJson(fetcher, url, init, secrets = [], timeoutMs = 30000) {
  let response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    reject("NETWORK_ERROR", "服务请求失败：" + safeMessage(error.message, secrets), 6);
  }
  let body;
  try { body = await response.json(); }
  catch { reject("REMOTE_INVALID", "服务响应不是 JSON", 7); }
  if (!response.ok || body?.error) {
    const error = body?.error;
    const status = Number(error?.data?.httpStatus ?? response.status);
    const code = error?.data?.code ?? error?.code ?? (status === 401 ? "UNAUTHORIZED"
      : status === 403 ? "FORBIDDEN" : status === 409 ? "CONFLICT" : "REMOTE_ERROR");
    const exit = status === 401 ? 3 : status === 403 ? 4
      : status === 409 ? 5 : 7;
    reject(String(code), safeMessage(error?.message ?? error ?? response.statusText, secrets), exit);
  }
  return body;
}

async function trpcCall(fetcher, base, path, method, input, token, timeoutMs) {
  const url = new URL(base + "/trpc/" + path);
  const headers = { authorization: "Bearer " + token };
  let init;
  if (method === "query") {
    if (Object.keys(input).length) url.searchParams.set("input", JSON.stringify(input));
    init = { method: "GET", headers };
  } else {
    init = { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input) };
  }
  const response = await fetchJson(fetcher, url, init, [token], timeoutMs);
  if (!object(response?.result) || !Object.hasOwn(response.result, "data")) {
    reject("REMOTE_INVALID", "tRPC 响应缺少 result.data", 7);
  }
  return response.result.data;
}

async function memberToken(catalog, base, loopback, env, fetcher) {
  if (env.WORKLOOM_ACCESS_TOKEN) return env.WORKLOOM_ACCESS_TOKEN;
  if (!loopback) {
    reject("UNAUTHORIZED", "缺少 WORKLOOM_ACCESS_TOKEN；远程入口不读取本机安装凭据", 3);
  }
  const desktopSecret = env.WORKLOOM_DESKTOP_SESSION_SECRET;
  if (desktopSecret) {
    const response = await fetchJson(fetcher, base + "/api/desktop/session", {
      method: "POST", headers: { "x-workloom-desktop-secret": desktopSecret, "content-type": "application/json" },
      body: "{}",
    }, [desktopSecret]);
    const token = response?.token;
    if (typeof token !== "string" || !token || response.dataMode !== "real") reject("UNAUTHORIZED", "正式安装身份签发失败", 3);
    return token;
  }
  if (process.platform === "darwin" && env.WORKLOOM_KEYCHAIN_ACCESS !== "0") {
    try {
      const { stdout } = await promisify(execFile)("/usr/bin/security", ["find-generic-password", "-s", "com.workloom.eagle.agent-access", "-a", "local-owner", "-w"],
        { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
      if (stdout.trim()) return stdout.trim();
    } catch {
      // No item / locked keychain / user declined access. Never fall back to a guest or demo member.
    }
  }
  reject("UNAUTHORIZED", "缺少正式成员会话；请先启动已安装的鹰眼客户端，或注入 WORKLOOM_ACCESS_TOKEN", 3);
}

async function cServiceCall(fetcher, base, transport, input, env) {
  const token = env.WORKLOOM_C_TOKEN;
  if (!token) reject("UNAUTHORIZED", "缺少 WORKLOOM_C_TOKEN", 3);
  const remaining = { ...input };
  const pathname = transport.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_, key) => {
    if (typeof remaining[key] !== "string" || !remaining[key]) reject("INVALID_INPUT", key + " 缺失");
    const encoded = encodeURIComponent(remaining[key]);
    delete remaining[key];
    return encoded;
  });
  const url = new URL(base + pathname);
  const headers = { authorization: "Bearer " + token };
  let init;
  if (transport.method === "GET") {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    init = { method: "GET", headers };
  } else {
    init = { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(remaining) };
  }
  return fetchJson(fetcher, url, init, [token]);
}

async function localCall(catalog, transport, input) {
  const moduleFile = resolve(catalog.root, transport.module);
  const bundleRoot = await realpath(join(catalog.root, "bundles", catalog.bundle, "capabilities"));
  const file = await realpath(moduleFile);
  if (!file.startsWith(bundleRoot + sep)) reject("CATALOG_INVALID", "本地能力模块越出行业目录");
  const module = await import(pathToFileURL(file).href);
  const fn = module[transport.export];
  if (typeof fn !== "function") reject("CATALOG_INVALID", "本地能力导出不存在");
  return fn(input);
}

function envelope(descriptor, raw) {
  if (object(raw) && raw.schemaVersion === RESULT_SCHEMA) {
    if (raw.capabilityId !== descriptor.id || raw.operation !== descriptor.operation
        || !["succeeded", "pending", "failed"].includes(raw.status)
        || !DATA_MODES.has(raw.dataMode)) {
      reject("REMOTE_INVALID", "能力回执与请求契约不一致", 7);
    }
    if (descriptor.dataMode !== "real" && raw.dataMode === "real") {
      reject("REMOTE_INVALID", "未核实数据不得升级标记为 real", 7);
    }
    if (descriptor.operation === "execute" && raw.status === "succeeded"
        && (raw.receipt?.synced !== true || typeof raw.receipt?.eventId !== "string" || !raw.receipt.eventId)) {
      reject("REMOTE_INVALID", "执行成功必须附服务端已同步事件回执", 7);
    }
    return raw;
  }
  const receipt = object(raw?.receipt) ? raw.receipt : null;
  const proven = descriptor.dataMode === "real" && receipt?.synced === true;
  return {
    schemaVersion: RESULT_SCHEMA,
    capabilityId: descriptor.id,
    operation: descriptor.operation,
    status: descriptor.operation === "execute" && !proven ? "pending" : "succeeded",
    dataMode: descriptor.dataMode,
    result: raw,
    ...(["execute", "receipt"].includes(descriptor.operation)
      ? { receipt: {
        eventId: typeof receipt?.eventId === "string" ? receipt.eventId : undefined,
        synced: proven,
        sourceVerified: false,
      } } : {}),
  };
}

export async function invokeCapability(catalog, id, input = {}, options = {}) {
  const descriptor = catalog.entries.get(id);
  if (!descriptor) reject("NOT_FOUND", "能力不存在：" + id);
  if (descriptor.enabled === false) reject("DISABLED", descriptor.disabledReason, 8);
  const value = validateInput(descriptor, input);
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  let raw;
  if (descriptor.transport.kind === "local") {
    raw = await localCall(catalog, descriptor.transport, value);
  } else {
    const { url, loopback } = baseUrlFor(catalog, options.baseUrl);
    if (descriptor.transport.kind === "trpc") {
      const token = await memberToken(catalog, url, loopback, env, fetcher);
      raw = await trpcCall(fetcher, url, descriptor.transport.path, descriptor.transport.method, value, token, descriptor.transport.timeoutMs);
    } else {
      raw = await cServiceCall(fetcher, url, descriptor.transport, value, env);
    }
  }
  return envelope(descriptor, raw);
}

export function toolName(descriptor) {
  return "workloom_" + descriptor.id.replace(/[^A-Za-z0-9]/gu, "_");
}

export function mcpTools(catalog) {
  return [...catalog.entries.values()].filter((item) => item.enabled !== false).map((item) => ({
    name: toolName(item),
    title: item.title,
    description: item.description + "（" + item.dataMode + "；" + item.risk + "）",
    inputSchema: item.inputSchema,
    annotations: {
      title: item.title,
      readOnlyHint: item.operation !== "execute",
      destructiveHint: item.operation === "execute" && item.risk === "review",
      idempotentHint: item.operation !== "execute" || item.inputSchema.required?.includes("idempotencyKey") === true,
      openWorldHint: item.transport.kind !== "local",
    },
  }));
}
