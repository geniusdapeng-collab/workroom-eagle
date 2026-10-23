/** A workspace-bound persistent request survives unknown replies, reloads and concurrent tabs. No credentials are stored. */
export interface VerificationScope { tenantId: string; workspaceId: string }
interface RequestStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface ChangedConfigurationPermit { scopeDigest: string; requestKey: string; generation: number }
export class ModelVerificationConfigurationChanged extends Error {
  constructor(readonly permit: ChangedConfigurationPermit) {
    super("受保护模型配置已变更；旧验证请求未调用新配置。请明确确认后再验证新配置。");
  }
}
export class ModelVerificationPersistenceError extends Error {
  constructor() { super("无法保存或核对本次模型验证请求，已停止调用。请恢复浏览器本机存储后重试。"); }
}
interface RequestRecord { schemaVersion: 1; generation: number }
const validGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < 1_000_000;
const requestKey = (scopeDigest: string, generation: number) => `eagle-model-verification-v1-${scopeDigest}-${generation}`;
function parseRecord(raw: string): RequestRecord {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "generation,schemaVersion"
    || !("schemaVersion" in value) || value.schemaVersion !== 1
    || !("generation" in value) || !validGeneration(value.generation)) throw new ModelVerificationPersistenceError();
  return { schemaVersion: 1, generation: value.generation };
}
async function scopeDigest(scope: VerificationScope): Promise<string> {
  if (![scope.tenantId, scope.workspaceId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)) {
    throw new ModelVerificationPersistenceError();
  }
  try {
    const bytes = new TextEncoder().encode(JSON.stringify([scope.tenantId, scope.workspaceId]));
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { throw new ModelVerificationPersistenceError(); }
}
function storedRequest(storage: RequestStorage, key: string): RequestRecord {
  try {
    const raw = storage.getItem(key);
    if (raw !== null) return parseRecord(raw);
    // Deterministic generation zero gives concurrent first-time tabs the same key.
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, generation: 0 }));
    const persisted = storage.getItem(key);
    if (persisted === null) throw new ModelVerificationPersistenceError();
    return parseRecord(persisted);
  } catch { throw new ModelVerificationPersistenceError(); }
}
function isConfigurationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string"
    || !error.message.startsWith("[IDEMPOTENCY_CONFLICT]")) return false;
  const data = "data" in error ? error.data : null;
  return Boolean(data && typeof data === "object" && "code" in data && data.code === "CONFLICT");
}

export async function verifyCurrentModelPersistently<T>(deps: {
  storage: () => RequestStorage;
  resolveScope: () => Promise<VerificationScope>;
  invoke: (input: { idempotencyKey: string }) => Promise<T>;
  readback: () => Promise<unknown>;
  changedConfiguration?: ChangedConfigurationPermit;
}): Promise<T> {
  const digest = await scopeDigest(await deps.resolveScope());
  const storageKey = `workloom:eagle:b-pc:model-verification:v1:${digest}`;
  let storage: RequestStorage;
  try { storage = deps.storage(); } catch { throw new ModelVerificationPersistenceError(); }
  let record = storedRequest(storage, storageKey);
  const permit = deps.changedConfiguration;
  if (permit) {
    if (permit.scopeDigest !== digest || !validGeneration(permit.generation)
      || permit.requestKey !== requestKey(digest, permit.generation) || record.generation < permit.generation) throw new ModelVerificationPersistenceError();
    if (record.generation === permit.generation) {
      if (!validGeneration(record.generation + 1)) throw new ModelVerificationPersistenceError();
      try {
        storage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, generation: record.generation + 1 }));
        const raw = storage.getItem(storageKey);
        if (raw === null) throw new ModelVerificationPersistenceError();
        const next = parseRecord(raw);
        if (next.generation <= record.generation) throw new ModelVerificationPersistenceError();
        record = next;
      } catch { throw new ModelVerificationPersistenceError(); }
    }
    // Another tab may already have started the same explicitly approved new generation.
  }
  const key = requestKey(digest, record.generation);
  let result: T;
  try { result = await deps.invoke({ idempotencyKey: key }); }
  catch (error) {
    if (isConfigurationConflict(error)) throw new ModelVerificationConfigurationChanged({ scopeDigest: digest, requestKey: key, generation: record.generation });
    throw error;
  }
  // A missing readback acknowledgement does not discard the request identity.
  await deps.readback();
  return result;
}
