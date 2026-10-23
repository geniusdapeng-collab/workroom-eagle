import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";
import pg from "pg";
import { configuredDeepSeek, currentDeepSeekConfiguration, installationFacts, VERIFIED_CONSULTING_ARTIFACT_COUNT_SQL } from "./onboarding-installation.js";
import { modelCredentialFingerprint } from "./onboarding-model-verification.js";

const state = vi.hoisted(() => ({ authority: vi.fn(), connect: vi.fn(), write: vi.fn(), query: vi.fn() }));
vi.mock("./access-authority.js", async (original) => ({ ...await original<typeof import("./access-authority.js")>(), currentMemberAuthority: state.authority }));
vi.mock("@workloom/db", async (original) => ({ ...await original<typeof import("@workloom/db")>(), getAppPool: () => ({ connect: state.connect }) }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), writeFileSync: state.write }));
import { appRouter } from "../trpc/router.js";

const identity: Identity = { kind: "member", memberId: "fixture-owner", memberNo: "OWNER", name: "单元夹具",
  role: "owner", tenantId: "fixture-tenant", workspaceId: "fixture-workspace", plan: "pro" };
function caller() {
  state.authority.mockResolvedValue({ identity, permissions: {} });
  return appRouter.createCaller({ session: identity, identity, partnerIdentity: null, headers: new Headers() });
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("installation facts stay separate from formal qualification and completed work", () => {
  it("uses actual customer archive entries and keeps example/simulated installations distinct", () => {
    expect(installationFacts({ dataMode: "real", clients: [], business: { source: "user", name: "业务主体不是客户资料" } }, false, {})).toEqual({ mode: "production", customerDataReady: false, modelConfigured: false });
    expect(installationFacts({ dataMode: "real", clients: [{ id: "customer-fixture" }] }, false, {}).customerDataReady).toBe(true);
    expect(installationFacts({ dataMode: "real", clients: "not-an-array" }, true, {}).mode).toBe("example");
    expect(installationFacts({ dataMode: "simulated", clients: [] }, false, {}).mode).toBe("simulated");
  });
  it("modelConfigured follows only the current connector endpoint, alias and credential presence, without claiming a real-call proof", () => {
    const env = { LLM_PROVIDER: "deepseek", LLM_BASE_URL: "https://api.deepseek.com/v1", LLM_MODEL: "deepseek-flash", LLM_API_KEY: "unit-key-only" };
    expect(configuredDeepSeek(env)).toBe(true);
    for (const patch of [{ LLM_PROVIDER: "mock" }, { LLM_BASE_URL: "https://api.deepseek.com.evil.invalid" }, { LLM_MODEL: "other" }, { LLM_API_KEY: "" }, { DEEPSEEK_API_KEY: "" }]) expect(configuredDeepSeek({ ...env, ...patch })).toBe(false);
  });
  it("shows a blank formal install and configured model without forging old wizard qualification or welcome-event jobs", async () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek"); vi.stubEnv("LLM_BASE_URL", "https://api.deepseek.com/v1");
    vi.stubEnv("LLM_MODEL", "deepseek-flash"); vi.stubEnv("LLM_API_KEY", "unit-fixture-key-never-a-real-credential");
    vi.stubEnv("DEEPSEEK_API_KEY", undefined); vi.stubEnv("DEEPSEEK_BASE_URL", undefined);
    state.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT archive FROM profiles")) return { rows: [{ archive: { dataMode: "real", clients: [] } }] };
      if (sql.includes("SELECT name, bundle_id, is_example")) return { rows: [{ name: "正式空白夹具", bundle_id: "consulting", is_example: false }] };
      if (sql.includes("count(*)") && sql.includes("consulting.analysis.read")) return { rows: [{ n: "0" }] };
      if (sql.includes("count(*)")) return { rows: [{ n: "9" }] };
      return { rows: [] };
    });
    state.connect.mockResolvedValue({ query: state.query, release: vi.fn() });
    const status = await caller().onboarding.status();
    expect(status.installation).toEqual({ mode: "production", customerDataReady: false, modelConfigured: true });
    expect(status.workspace.events).toBe(9); expect(status.workspace.verifiedArtifacts).toBe(0);
    expect(status.dataMode).toBe("simulated"); expect(status.llm.real).toBe(false); expect(status.activationGate.canActivate).toBe(false);
    expect(JSON.stringify(status)).not.toContain("unit-fixture-key-never-a-real-credential");
  });
  it.each([false, true])("recognizes the same current verification proof for /v1 and DEEPSEEK overrides (%s), then invalidates it after key rotation", async (override) => {
    vi.stubEnv("LLM_PROVIDER", "deepseek"); vi.stubEnv("LLM_BASE_URL", "https://api.deepseek.com/v1"); vi.stubEnv("LLM_MODEL", "deepseek-flash");
    vi.stubEnv("LLM_API_KEY", "unit-fallback-key"); vi.stubEnv("DEEPSEEK_BASE_URL", override ? "https://api.deepseek.com/v1/" : undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", override ? "unit-protected-override-key" : undefined);
    const config = currentDeepSeekConfiguration(); const { apiKey, ...publicConfig } = config;
    const proof = { ...publicConfig, credentialFingerprint: modelCredentialFingerprint(apiKey), verified: true };
    state.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT archive FROM profiles")) return { rows: [{ archive: { dataMode: "real", clients: [], llmVerification: proof } }] };
      if (sql.includes("SELECT name, bundle_id, is_example")) return { rows: [{ name: "正式夹具", bundle_id: "consulting", is_example: false }] };
      if (sql.includes("count(*)")) return { rows: [{ n: "0" }] }; return { rows: [] };
    });
    state.connect.mockResolvedValue({ query: state.query, release: vi.fn() });
    const status = await caller().onboarding.status();
    expect(status.llm.real).toBe(true); expect(status.llm.baseUrl).toBe(config.baseUrl); expect(status.activationGate.canActivate).toBe(false);
    vi.stubEnv("DEEPSEEK_API_KEY", "unit-rotated-protected-key");
    expect((await caller().onboarding.status()).llm.real).toBe(false);
  });
  it.each(["mock", "deepseek"])("production saveLlmConfig rejects %s before network, plaintext file or database work", async (provider) => {
    vi.stubEnv("NODE_ENV", "production");
    const network = vi.fn(async () => { throw new Error("unexpected network in unit fixture"); });
    vi.stubGlobal("fetch", network); state.connect.mockRejectedValue(new Error("unexpected database in unit fixture"));
    await expect(caller().onboarding.saveLlmConfig({ provider, baseUrl: "https://api.deepseek.com", apiKey: "unit-only-fake-key", model: "deepseek-flash" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(network).not.toHaveBeenCalled(); expect(state.write).not.toHaveBeenCalled(); expect(state.connect).not.toHaveBeenCalled();
  });
  it("production legacy test rejects caller-provided URL/key before network", async () => {
    vi.stubEnv("NODE_ENV", "production"); const network = vi.fn(); vi.stubGlobal("fetch", network);
    await expect(caller().onboarding.testLlm({ baseUrl: "https://example.invalid", apiKey: "unit-only-fake-key", model: "anything" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(network).not.toHaveBeenCalled(); expect(state.write).not.toHaveBeenCalled();
  });
  it("the current-config verification route rejects caller URL, key and completion fields", async () => {
    await expect(caller().onboarding.verifyCurrentLlm({ idempotencyKey: "schema-unit-request", apiKey: "unit-only-key" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.connect).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.DATABASE_URL)("actual PostgreSQL count excludes welcome/dossier/planner, simulated/unsynced receipts, invalid hashes and other scopes (read-only CTE)", async () => {
    const payload = { decision: { action: "consulting.analysis.read", after: { file: { sha256: "a".repeat(64) } } }, receipt: { synced: true, mode: "real" } };
    const item = (value: unknown = payload, tenant = identity.tenantId, workspace = identity.workspaceId) => ({ tenant_id: tenant, workspace_id: workspace, payload: value });
    const records = [item(), item({ ...payload, decision: { ...payload.decision, after: { file: { sha256: "b".repeat(64) } } } }),
      ...["onboarding.welcome_progress", "consulting.dossier.created", "consulting.run.planned"].map((action) => item({ ...payload, decision: { ...payload.decision, action } })),
      item({ ...payload, receipt: { synced: false, mode: "real" } }), item({ ...payload, receipt: { synced: true, mode: "simulated" } }), item({ ...payload, receipt: { synced: "true", mode: "real" } }),
      item({ ...payload, decision: { ...payload.decision, after: { file: { sha256: "invalid" } } } }), item(payload, "another-tenant"), item(payload, identity.tenantId, "another-workspace")];
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    try {
      const result = await db.query(`WITH biz_events AS (SELECT item->>'tenant_id' AS tenant_id, item->>'workspace_id' AS workspace_id, item->'payload' AS payload FROM jsonb_array_elements($3::jsonb) AS item) ${VERIFIED_CONSULTING_ARTIFACT_COUNT_SQL}`,
        [identity.tenantId, identity.workspaceId, JSON.stringify(records)]);
      expect(Number(result.rows[0].n)).toBe(2);
    } finally { await db.end(); }
  });
});
