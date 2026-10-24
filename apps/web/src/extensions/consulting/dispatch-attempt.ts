/** Only opaque request metadata is persisted; submitted text and credentials are never stored here. */
export interface DispatchAttempt {
  version: 1; requestId: string; fingerprint: string; createdAt: string;
  state: "pending" | "unknown" | "dispatching" | "settled";
  threadId?: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function storageKey(scope: string): string {
  if (!scope || scope === "anonymous") throw new Error("身份尚未确认，请等待工作区加载后再提交。");
  return `workloom.consulting.dispatch.v1:${encodeURIComponent(scope)}`;
}
export function readDispatchAttempt(scope: string): DispatchAttempt | null {
  const key = storageKey(scope);
  let raw: string | null;
  try { raw = localStorage.getItem(key); }
  catch { throw new Error("本机无法读取请求恢复标识，尚未重新提交任务。"); }
  if (!raw) return null;
  let value: Partial<DispatchAttempt>;
  try { value = JSON.parse(raw) as Partial<DispatchAttempt>; }
  catch { throw new Error("原提交的恢复标识无法解析，请先核对任务中心中的原提交。"); }
  if (value.version !== 1 || !UUID.test(value.requestId ?? "") || !/^[a-f0-9]{64}$/i.test(value.fingerprint ?? "")
      || !["pending", "unknown", "dispatching", "settled"].includes(value.state ?? "") || typeof value.createdAt !== "string") {
    throw new Error("原提交的恢复标识不完整，请先核对任务中心中的原提交。");
  }
  return value as DispatchAttempt;
}
export function saveDispatchAttempt(scope: string, attempt: DispatchAttempt): void {
  try { localStorage.setItem(storageKey(scope), JSON.stringify(attempt)); }
  catch { throw new Error("本机无法保存请求恢复标识；为避免重复执行，本次尚未提交。"); }
}
export async function dispatchFingerprint(input: { title: string; presetKey?: string; runImmediately: boolean }): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ title: input.title, presetKey: input.presetKey ?? null, runImmediately: input.runImmediately }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function beginDispatchAttempt(scope: string, input: { title: string; presetKey?: string; runImmediately: boolean }): Promise<{ attempt: DispatchAttempt; reused: boolean }> {
  const fingerprint = await dispatchFingerprint(input);
  const prior = readDispatchAttempt(scope);
  if (prior?.fingerprint === fingerprint) return { attempt: prior, reused: true };
  if (prior && prior.state !== "settled") throw new Error("上一项提交结果尚未确认，请先查询原提交结果；不能用另一个目标覆盖恢复标识。");
  const attempt: DispatchAttempt = { version: 1, requestId: globalThis.crypto.randomUUID(), fingerprint, createdAt: new Date().toISOString(), state: "pending" };
  saveDispatchAttempt(scope, attempt);
  return { attempt, reused: false };
}
export function updateDispatchAttempt(scope: string, requestId: string, patch: Pick<DispatchAttempt, "state"> & { threadId?: string }): void {
  const current = readDispatchAttempt(scope);
  if (!current || current.requestId !== requestId) throw new Error("请求恢复标识已变化，尚未改写其他提交。");
  saveDispatchAttempt(scope, { ...current, ...patch });
}
/** A deliberate new-task action may clear a settled record. Unknown requests stay recoverable. */
export function finishSettledDispatch(scope: string): void {
  const current = readDispatchAttempt(scope);
  if (current && current.state !== "settled") throw new Error("原提交结果尚未确认，请先核对原任务。");
  try { localStorage.removeItem(storageKey(scope)); }
  catch { throw new Error("本机请求恢复标识暂时无法更新，请稍后再试。"); }
}
