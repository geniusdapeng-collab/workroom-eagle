import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

const state = vi.hoisted(() => ({ complete: vi.fn(async () => "内部草稿"), assemble: vi.fn(), sharedPool: vi.fn(), sharedRoute: vi.fn(), sharedSink: vi.fn() }));
vi.mock("@workloom/base/model-router", async (original) => ({
  ...await original<typeof import("@workloom/base/model-router")>(),
  poolFromEnv: state.sharedPool,
  routeSmart: state.sharedRoute,
  GatewayEventSink: class { constructor() { state.sharedSink(); } },
}));
vi.mock("../industry/consulting/llm.js", () => ({
  createConsultingUiLlmCall: (deps: unknown) => { state.assemble(deps); return state.complete; },
}));
import { routedLlmCall, resetLlmAssembly } from "./llm.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); resetLlmAssembly(); });
function noModelWork() {
  expect(state.assemble).not.toHaveBeenCalled(); expect(state.complete).not.toHaveBeenCalled();
  expect(state.sharedPool).not.toHaveBeenCalled(); expect(state.sharedRoute).not.toHaveBeenCalled(); expect(state.sharedSink).not.toHaveBeenCalled();
}
describe("consulting industry selection precedes shared multi-vendor routing", () => {
  it("an unresolved active bundle refuses before any shared provider or alternate model work", async () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    state.sharedPool.mockReturnValue(new Map());
    state.sharedRoute.mockResolvedValue({ kind: "answered", text: "free unexpected shared-pool fixture" });
    const call = routedLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" },
      scene: "intent-classify", taskContext: { requestId: "fixture-stable-request" }, industryResolver: async () => null });
    const error = await call!("public consulting question").then(() => null, value => value as Error);
    expect({ message: error?.message ?? null, poolCalls: state.sharedPool.mock.calls.length,
      routeCalls: state.sharedRoute.mock.calls.length }).toEqual({
      message: "MODEL_INDUSTRY_UNRESOLVED", poolCalls: 0, routeCalls: 0,
    });
    expect(state.assemble).not.toHaveBeenCalled(); expect(state.complete).not.toHaveBeenCalled();
  });

  it("resolves the actual workspace bundle and preserves the same bounded context across its calls", async () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    const scope = { tenantId: "tenant", workspaceId: "workspace" };
    const call = routedLlmCall({ gateway: {} as pg.Pool, scope, scene: "quest-plan", industryResolver: async () => "consulting" });
    expect(call).toBeTypeOf("function");
    await expect(call!("first")).resolves.toBe("内部草稿");
    await expect(call!("second")).resolves.toBe("内部草稿");
    expect(state.assemble).toHaveBeenCalledTimes(1);
    expect(state.assemble).toHaveBeenCalledWith(expect.objectContaining({ scope, scene: "quest-plan" }));
    expect(state.complete).toHaveBeenCalledTimes(2);
    expect(state.sharedPool).not.toHaveBeenCalled(); expect(state.sharedRoute).not.toHaveBeenCalled(); expect(state.sharedSink).not.toHaveBeenCalled();
  });

  it("a deferred non-consulting mock refuses before shared provider routing or metering, allowing a visibly marked rule fallback", async () => {
    vi.stubEnv("LLM_PROVIDER", "mock");
    const industryResolver = vi.fn(async () => "hotel");
    const call = routedLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" }, scene: "ask-synthesize", industryResolver });
    expect(call).toBeTypeOf("function");
    await expect(call!("fixture question")).rejects.toThrow("LLM_MOCK_MODE");
    expect(industryResolver).toHaveBeenCalledTimes(1); noModelWork();
  });

  it.each([false, true])("known/deferred consulting mock rejects the real task at the public entry (%s), before all provider work", async (deferred) => {
    for (const provider of ["mock", undefined]) {
      vi.stubEnv("LLM_PROVIDER", provider);
      const call = routedLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" }, scene: "ask-synthesize",
        ...(deferred ? { industryResolver: async () => "consulting" } : { industry: "consulting" }) });
      expect(call).toBeTypeOf("function");
      await expect(call!("a real consulting task")).rejects.toThrow("CONSULTING_REAL_MODEL_REQUIRED");
    }
    noModelWork();
  });

  it("known non-consulting mock retains the original synchronous undefined contract", () => {
    vi.stubEnv("LLM_PROVIDER", "mock");
    expect(routedLlmCall({ gateway: {} as pg.Pool, scope: { tenantId: "tenant", workspaceId: "workspace" }, scene: "ask-synthesize", industry: "hotel" })).toBeUndefined();
    noModelWork();
  });
});
