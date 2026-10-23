import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { gatewayAppend } from "@workloom/base/workdata";
import type { DeepSeekClient, DeepSeekCompletion } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { createConsultingUiLlmCall } from "./llm.js";

const result: DeepSeekCompletion = {
  text: "仅有客户自述，关键数字仍待核实。", model: "deepseek-flash", requestedModel: "deepseek-flash", provider: "deepseek",
  requestId: "provider-request", reservationId: "reserved-once", finishReason: "stop",
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  modelMetadata: { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxOutputTokens: 393216,
    verifiedAt: "2026-10-23T16:00:00Z", tokenizerProof: { source: "official", artifactSha256: "a".repeat(64), reviewedOn: "2026-10-23", modelVersion: "DeepSeek-V4.1-Flash-1017", algorithm: "ByteLevel BPE", framingAllowance: 1024 } },
};
const originalProvider = process.env.LLM_PROVIDER;
afterEach(() => { if (originalProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = originalProvider; });

describe("Eagle UI bounded model assembly", () => {
  it("masks PII, calls the shared provider exactly once and appends one real usage event", async () => {
    process.env.LLM_PROVIDER = "deepseek";
    const complete = vi.fn<DeepSeekClient["complete"]>(async () => result);
    const append = vi.fn<typeof gatewayAppend>(async () => ({ eventId: "E-1", seq: 1n, deduped: false, hash: "a".repeat(64), piiHits: 0 }));
    const call = createConsultingUiLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" }, scene: "ask-synthesize", client: { complete } as unknown as DeepSeekClient, append });
    await expect(call("客户手机号13800000000，仅按数据回答")).resolves.toBe(result.text);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ maxTokens: 2048 });
    expect(JSON.stringify(complete.mock.calls[0])).not.toContain("13800000000");
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[2]).toMatchObject({ decision: { action: "model.call", after: { usage: result.usage, reservation_id: result.reservationId } }, model_trace: { credits: 0, request_id: result.requestId, usage: result.usage }, receipt: { mode: "real", synced: true } });
  });

  it("provider failure is not converted into a model success event or another vendor retry", async () => {
    process.env.LLM_PROVIDER = "deepseek";
    const complete = vi.fn(async () => { throw new Error("BUDGET_FROZEN"); });
    const append = vi.fn();
    const call = createConsultingUiLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" }, scene: "quest-plan", client: { complete } as unknown as DeepSeekClient, append });
    await expect(call("test" )).rejects.toThrow("BUDGET_FROZEN");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it("event append failure does not retry the paid model or return unaudited success", async () => {
    process.env.LLM_PROVIDER = "deepseek";
    const complete = vi.fn(async () => result);
    const append = vi.fn(async () => { throw new Error("audit-store-unavailable"); });
    const call = createConsultingUiLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" }, scene: "ask-synthesize", client: { complete } as unknown as DeepSeekClient, append });
    await expect(call("test")).rejects.toThrow("audit-store-unavailable");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("production consulting refuses mock model configuration", async () => {
    process.env.LLM_PROVIDER = "mock";
    const complete = vi.fn();
    const call = createConsultingUiLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" }, scene: "ask-synthesize", client: { complete } as unknown as DeepSeekClient });
    await expect(call("test")).rejects.toThrow("CONSULTING_REAL_MODEL_REQUIRED");
    expect(complete).not.toHaveBeenCalled();
  });
});
