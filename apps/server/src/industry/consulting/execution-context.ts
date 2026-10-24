/** A durable business execution owns its provider budget and original responses. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DeepSeekError, getDeepSeekClientForTask, type DeepSeekClient } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { containsCredential } from "./workflow-core.js";

export interface ConsultingTaskContext { threadId?: string; requestId?: string }
export interface ConsultingExecutionInput extends ConsultingTaskContext {
  scope: { tenantId: string; workspaceId: string };
  /** Injection seams are local service dependencies, never accepted from an RPC input. */
  supportDir?: string;
  clientFactory?: (taskIdentity: string) => DeepSeekClient;
}
export interface ConsultingExecutionContext {
  client: DeepSeekClient;
  taskIdentity: string;
  budgetFile: string;
  cacheDirectory: string;
}

type Operation = "complete" | "search" | "fetch";
interface OperationRecord {
  schemaVersion: "eagle.provider-operation/v1";
  executionHash: string;
  operation: Operation;
  fingerprint: string;
  status: "pending" | "settled" | "unknown";
  createdAt: string;
  result?: unknown;
  resultSha256?: string;
  errorCode?: string;
}
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function validIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
}
function fail(code: string): never { throw new DeepSeekError(code); }

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) fail("OPERATION_CACHE_UNSAFE");
}
function writeExclusive(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function readRecord(path: string, expected: Pick<OperationRecord, "executionHash" | "operation" | "fingerprint">): OperationRecord | undefined {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) fail("OPERATION_CACHE_INVALID");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) fail("OPERATION_CACHE_UNSAFE");
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as OperationRecord;
    if (parsed.schemaVersion !== "eagle.provider-operation/v1" || parsed.executionHash !== expected.executionHash
      || parsed.operation !== expected.operation || parsed.fingerprint !== expected.fingerprint
      || !["pending", "settled", "unknown"].includes(parsed.status)) fail("OPERATION_CACHE_INVALID");
    if (parsed.status === "settled" && (!parsed.resultSha256 || hash(canonical(parsed.result)) !== parsed.resultSha256)) fail("OPERATION_CACHE_INVALID");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof DeepSeekError) throw error;
    fail("OPERATION_CACHE_INVALID");
  } finally { if (fd !== undefined) closeSync(fd); }
}
function publish(path: string, record: OperationRecord): void {
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > MAX_CACHE_BYTES) fail("OPERATION_CACHE_TOO_LARGE");
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeExclusive(temp, text);
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/**
 * A pending operation is deliberately never reclaimed on restart. A caller may
 * reuse a settled response, but may not repurchase an operation of unknown fate.
 * This journal is provider I/O evidence, not a replacement for business events.
 */
export function getConsultingExecutionContext(input: ConsultingExecutionInput): ConsultingExecutionContext {
  if (!validIdentity(input.scope.tenantId) || !validIdentity(input.scope.workspaceId)) fail("TASK_SCOPE_INVALID");
  if (input.threadId !== undefined && !validIdentity(input.threadId)) fail("TASK_CONTEXT_INVALID");
  if (input.requestId !== undefined && !validIdentity(input.requestId)) fail("TASK_CONTEXT_INVALID");
  if (!input.threadId && !input.requestId) fail("TASK_CONTEXT_REQUIRED");
  const taskIdentity = canonical({ tenantId: input.scope.tenantId, workspaceId: input.scope.workspaceId,
    kind: input.requestId ? "dispatch" : "thread", id: input.requestId ?? input.threadId });
  const executionHash = hash(taskIdentity);
  const support = resolve(input.supportDir ?? process.env.WORKLOOM_SUPPORT_DIR
    ?? join(homedir(), "Library", "Application Support", "WorkRoomEagle"));
  const root = join(support, "consulting", "execution-cache");
  const cacheDirectory = join(root, executionHash);
  // Check every server-owned component before traversing it. The configured
  // support root is trusted deployment input; descendants cannot redirect I/O.
  privateDirectory(join(support, "consulting"));
  privateDirectory(root);
  privateDirectory(cacheDirectory);
  const budgetFile = process.env.WORKLOOM_CONSULTING_BUDGET_FILE
    ? resolve(process.env.WORKLOOM_CONSULTING_BUDGET_FILE)
    : join(support, "consulting", "budgets", `${hash(taskIdentity)}.json`);
  const provider = (input.clientFactory ?? getDeepSeekClientForTask)(taskIdentity);

  async function once<T>(operation: Operation, body: unknown, invoke: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) fail("CANCELLED");
    const fingerprint = hash(canonical({ operation, body }));
    const path = join(cacheDirectory, `${operation}-${fingerprint}.json`);
    const expected = { executionHash, operation, fingerprint };
    const existing = readRecord(path, expected);
    if (existing) {
      if (existing.status !== "settled") fail("PROVIDER_OPERATION_UNCERTAIN");
      if (containsCredential(canonical(existing.result))) fail("SECRET_IN_OUTPUT");
      return structuredClone(existing.result) as T;
    }
    const record: OperationRecord = { schemaVersion: "eagle.provider-operation/v1", ...expected,
      status: "pending", createdAt: new Date().toISOString() };
    try { writeExclusive(path, `${JSON.stringify(record)}\n`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("PROVIDER_OPERATION_IN_PROGRESS");
      throw error;
    }
    try {
      const result = await invoke();
      // The journal precedes workflow validation and must protect every provider
      // result, including web tools and dependency-injected clients.
      if (containsCredential(canonical(result))) fail("SECRET_IN_OUTPUT");
      publish(path, { ...record, status: "settled", result, resultSha256: hash(canonical(result)) });
      return result;
    } catch (error) {
      // Retain a non-repurchasable operation even when a known provider response
      // could not be durably saved. Never turn an audit/storage error into retry.
      publish(path, { ...record, status: "unknown", errorCode: error instanceof DeepSeekError ? error.code : "OPERATION_FAILED" });
      throw error;
    }
  }
  const client: DeepSeekClient = {
    complete: (value) => once("complete", { system: value.system ?? "", prompt: value.prompt,
      maxTokens: value.maxTokens ?? 2048, jsonMode: value.jsonMode ?? false }, () => provider.complete(value), value.signal),
    search: (value) => once("search", { query: value.query, count: value.count ?? 5 }, () => provider.search(value), value.signal),
    fetchPage: (value) => once("fetch", { url: value.url }, () => provider.fetchPage(value), value.signal),
    verifyModel: (signal) => provider.verifyModel(signal),
    getBudget: () => provider.getBudget(),
  };
  return { client, taskIdentity, budgetFile, cacheDirectory };
}
