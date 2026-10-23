import { describe, expect, it } from "vitest";
import { ModelVerificationConfigurationChanged, ModelVerificationPersistenceError, verifyCurrentModelPersistently, type ChangedConfigurationPermit } from "./current-model-verification";

const scope = { tenantId: "unit-tenant", workspaceId: "unit-workspace" };
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const keys: string[] = []; let paidCalls = 0; let conflict = false; let failReply = false; let failReadback = false;
  const completed = new Set<string>();
  const deps = { storage: () => storage, resolveScope: async () => scope,
    invoke: async ({ idempotencyKey }: { idempotencyKey: string }) => {
      keys.push(idempotencyKey);
      if (conflict) throw Object.assign(new Error("[IDEMPOTENCY_CONFLICT] 当前受保护配置已变化"), { data: { code: "CONFLICT" } });
      if (!completed.has(idempotencyKey)) { completed.add(idempotencyKey); paidCalls++; }
      if (failReply) throw new Error("unit reply lost after provider completion");
      return { ok: true, receipt: idempotencyKey };
    }, readback: async () => { if (failReadback) throw new Error("unit status readback unavailable"); } };
  return { values, storage, deps, keys, get paidCalls() { return paidCalls; },
    set conflict(value: boolean) { conflict = value; }, set failReply(value: boolean) { failReply = value; }, set failReadback(value: boolean) { failReadback = value; } };
}

describe("persistent current-model verification request, free fixtures only", () => {
  it("unknown replies, retries and a fresh page invocation retain the exact workspace request and never repurchase", async () => {
    const f = fixture(); f.failReply = true;
    await expect(verifyCurrentModelPersistently(f.deps)).rejects.toThrow(/reply lost/);
    await expect(verifyCurrentModelPersistently({ ...f.deps })).rejects.toThrow(/reply lost/);
    f.failReply = false;
    const result = await verifyCurrentModelPersistently({ ...f.deps, storage: () => f.storage });
    expect(result.ok).toBe(true); expect(new Set(f.keys).size).toBe(1); expect(f.paidCalls).toBe(1);
  });
  it("successful proof with a lost status readback remains replayable after reload", async () => {
    const f = fixture(); f.failReadback = true;
    await expect(verifyCurrentModelPersistently(f.deps)).rejects.toThrow(/readback unavailable/);
    f.failReadback = false;
    await verifyCurrentModelPersistently({ ...f.deps });
    await verifyCurrentModelPersistently({ ...f.deps });
    expect(new Set(f.keys).size).toBe(1); expect(f.paidCalls).toBe(1);
  });
  it("concurrent first-time tabs derive the same key and tenant/workspace scopes remain distinct", async () => {
    const f = fixture(); await Promise.all([verifyCurrentModelPersistently(f.deps), verifyCurrentModelPersistently({ ...f.deps })]);
    expect(new Set(f.keys).size).toBe(1); expect(f.paidCalls).toBe(1);
    for (const next of [{ ...scope, workspaceId: "other-workspace" }, { ...scope, tenantId: "other-tenant" }]) await verifyCurrentModelPersistently({ ...f.deps, resolveScope: async () => next });
    expect(new Set(f.keys).size).toBe(3); expect(f.values.size).toBe(3);
  });
  it("only an exact server configuration conflict offers an explicit new request; ordinary retries keep the old one", async () => {
    const f = fixture(); await verifyCurrentModelPersistently(f.deps); f.conflict = true;
    let permit: ChangedConfigurationPermit | undefined;
    try { await verifyCurrentModelPersistently(f.deps); } catch (error) { expect(error).toBeInstanceOf(ModelVerificationConfigurationChanged); permit = (error as ModelVerificationConfigurationChanged).permit; }
    await expect(verifyCurrentModelPersistently({ ...f.deps })).rejects.toBeInstanceOf(ModelVerificationConfigurationChanged);
    expect(new Set(f.keys).size).toBe(1); expect(f.paidCalls).toBe(1);
    f.conflict = false;
    await verifyCurrentModelPersistently({ ...f.deps, changedConfiguration: permit });
    await verifyCurrentModelPersistently({ ...f.deps, changedConfiguration: permit }); // stale second tab shares the new generation.
    expect(new Set(f.keys).size).toBe(2); expect(f.paidCalls).toBe(2);
  });
  it("message-only conflicts, generic errors and scope-changed permits cannot silently rotate a request", async () => {
    const f = fixture();
    for (const error of [new Error("[IDEMPOTENCY_CONFLICT] no structured server code"), Object.assign(new Error("other conflict"), { data: { code: "CONFLICT" } })]) {
      await expect(verifyCurrentModelPersistently({ ...f.deps, invoke: async () => { throw error; } })).rejects.not.toBeInstanceOf(ModelVerificationConfigurationChanged);
    }
    const before = f.keys.length;
    await expect(verifyCurrentModelPersistently({ ...f.deps, changedConfiguration: { scopeDigest: "0".repeat(64), requestKey: "fake", generation: 0 } })).rejects.toBeInstanceOf(ModelVerificationPersistenceError);
    expect(f.keys).toHaveLength(before);
  });
  it("unavailable, unwritable, discarded or corrupted persistence fails before any model invocation", async () => {
    const f = fixture();
    for (const storage of [
      () => { throw new Error("unit local storage disabled"); },
      () => ({ getItem: () => null, setItem: () => { throw new Error("unit quota"); } }),
      () => ({ getItem: () => null, setItem: () => undefined }),
      () => ({ getItem: () => "invalid-json", setItem: () => undefined }),
      () => ({ getItem: () => JSON.stringify({ schemaVersion: 1, generation: -1 }), setItem: () => undefined }),
    ]) await expect(verifyCurrentModelPersistently({ ...f.deps, storage })).rejects.toBeInstanceOf(ModelVerificationPersistenceError);
    expect(f.keys).toHaveLength(0); expect(f.paidCalls).toBe(0);
  });
});
