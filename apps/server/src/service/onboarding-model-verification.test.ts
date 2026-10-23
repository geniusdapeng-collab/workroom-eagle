import { describe, expect, it } from "vitest";
import type { DeepSeekClient, DeepSeekCompletion } from "../../../../bundles/consulting/connectors/deepseek.mjs";
import { CurrentModelVerifier, modelCredentialFingerprint, type CurrentModelVerificationStore } from "./onboarding-model-verification.js";

const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" };
const fakeKey = "unit-only-protected-credential-never-real";
function fixture(custom?: () => Promise<DeepSeekCompletion>) {
  const env: Record<string, string | undefined> = { LLM_PROVIDER: "deepseek", LLM_BASE_URL: "https://api.deepseek.com/v1", LLM_MODEL: "deepseek-flash", LLM_API_KEY: fakeKey };
  const state = { calls: 0, events: [] as Array<{ eventId: string; hash: string; action: string; data: Record<string, unknown>; metered: boolean }>, proof: null as Record<string, unknown> | null,
    failProof: false, failAcknowledgement: false };
  let queue = Promise.resolve();
  const store: CurrentModelVerificationStore = { transaction: async (_scope, _actor, body) => {
    let release!: () => void; const prior = queue; queue = new Promise<void>((resolve) => { release = resolve; }); await prior;
    const events = structuredClone(state.events); let proof = state.proof;
    try {
      const result = await body({ events, append: async (action, data, model) => {
        const event = { eventId: `E-${events.length + 1}`, hash: String(events.length + 1).padStart(64, "0"), action, data, metered: Boolean(model) }; events.push(event); return event;
      }, saveProof: async (value) => { if (state.failProof) throw new Error("fixture database rejects proof"); proof = value; } });
      state.events = events; state.proof = proof;
      if (state.failAcknowledgement && events.some((event) => event.action === "onboarding.llm_configured")) { state.failAcknowledgement = false; throw new Error("fixture COMMIT acknowledgement lost"); }
      return result;
    } finally { release(); }
  } };
  const complete: DeepSeekCompletion = { text: "连接已响应，资格仍须核验。", provider: "deepseek", model: "deepseek-flash", requestedModel: "deepseek-flash", requestId: "unit-model-request",
    reservationId: "unit-budget-reservation", usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, finishReason: "stop",
    modelMetadata: { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxOutputTokens: 393216, verifiedAt: new Date().toISOString(),
      tokenizerProof: { source: "https://example.invalid/fixture", artifactSha256: "0".repeat(64), reviewedOn: "2026-10-24", modelVersion: "unit", algorithm: "unit", framingAllowance: 1024 } } };
  const client = { complete: async (request: { prompt: string; maxTokens: number }) => {
    state.calls += 1; expect(request.maxTokens).toBe(128); expect(request.prompt).not.toContain(fakeKey); return custom ? custom() : complete;
  } } as unknown as DeepSeekClient;
  const verifier = new CurrentModelVerifier({ store, env: () => env, modelFor: (task) => { expect(task).toContain(scope.workspaceId); expect(task).not.toContain(fakeKey); return client; } });
  return { verifier, env, state, complete };
}

describe("server-held current model verification (free fixtures)", () => {
  it("writes a real-call-bound proof and returns its receipt once; replay does not repeat paid I/O", async () => {
    const f = fixture(); const result = await f.verifier.verify(scope, "OWNER", "stable-unit-request");
    const same = await f.verifier.verify(scope, "OWNER", "stable-unit-request");
    expect(result).toEqual(same); expect(result.requestId).toBe(f.complete.requestId); expect(f.state.calls).toBe(1);
    expect(f.state.proof).toMatchObject({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", verified: true, credentialFingerprint: modelCredentialFingerprint(fakeKey) });
    expect(f.state.events.filter((event) => event.metered)).toHaveLength(1);
    expect(JSON.stringify(f.state.events)).not.toContain(fakeKey); expect(JSON.stringify(result)).not.toContain(fakeKey);
  });
  it("serializes duplicate concurrent claims before a model call", async () => {
    let finish!: (value: DeepSeekCompletion) => void; const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
    const first = f.verifier.verify(scope, "OWNER", "concurrent-unit-request");
    while (!f.state.calls) await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(f.verifier.verify(scope, "OWNER", "concurrent-unit-request")).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
    finish(f.complete); await first; expect(f.state.calls).toBe(1);
  });
  it("missing or forged config fails before claim or model I/O", async () => {
    for (const patch of [{ LLM_API_KEY: "" }, { LLM_PROVIDER: "mock" }, { LLM_BASE_URL: "https://api.deepseek.com.evil.invalid" }, { LLM_MODEL: "other-model" }]) {
      const f = fixture(); Object.assign(f.env, patch);
      await expect(f.verifier.verify(scope, "OWNER", "invalid-config-request")).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
      expect(f.state.calls).toBe(0); expect(f.state.events).toHaveLength(0); expect(f.state.proof).toBeNull();
    }
  });
  it("unknown provider result preserves a failed claim and cannot be silently reissued", async () => {
    const f = fixture(async () => { throw Object.assign(new Error("unit provider failure with no actual secret"), { code: "PROVIDER_TIMEOUT" }); });
    await expect(f.verifier.verify(scope, "OWNER", "unknown-unit-request")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    await expect(f.verifier.verify(scope, "OWNER", "unknown-unit-request")).rejects.toMatchObject({ code: "VERIFICATION_PENDING" });
    expect(f.state.calls).toBe(1); expect(f.state.proof).toBeNull(); expect(f.state.events.at(-1)!.action).toBe("onboarding.llm_verification_failed");
  });
  it("changed config or failed proof persistence never sets verification and still records actual usage once", async () => {
    let f = fixture(async () => { f.env.LLM_API_KEY = "unit-only-new-protected-key"; return f.complete; });
    await expect(f.verifier.verify(scope, "OWNER", "changed-config-request")).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
    expect(f.state.proof).toBeNull(); expect(f.state.events.filter((event) => event.metered)).toHaveLength(1);
    f = fixture(); f.state.failProof = true;
    await expect(f.verifier.verify(scope, "OWNER", "proof-failure-request")).rejects.toMatchObject({ code: "MODEL_VERIFICATION_FAILED" });
    expect(f.state.proof).toBeNull(); expect(f.state.events.filter((event) => event.metered)).toHaveLength(1);
  });
  it("lost COMMIT acknowledgement reads back the original success without a duplicate usage event", async () => {
    const f = fixture(); f.state.failAcknowledgement = true;
    await expect(f.verifier.verify(scope, "OWNER", "lost-acknowledgement-request")).resolves.toMatchObject({ ok: true, requestId: f.complete.requestId });
    expect(f.state.calls).toBe(1); expect(f.state.events.filter((event) => event.metered)).toHaveLength(1);
  });
});
