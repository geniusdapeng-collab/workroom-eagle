import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@workloom/base/tenancy";
const fixture = vi.hoisted(() => ({ authority: vi.fn(), bundle: vi.fn(), escalate: vi.fn(), pool: vi.fn() }));
vi.mock("../service/access-authority.js", async original => ({
  ...await original<typeof import("../service/access-authority.js")>(), currentMemberAuthority: fixture.authority,
}));
vi.mock("../service/active-bundle.js", () => ({ resolveWorkspaceActiveBundle: fixture.bundle }));
vi.mock("@workloom/db", () => ({ getAppPool: () => ({}), getGatewayPool: () => ({}) }));
vi.mock("@workloom/base/model-router", async original => ({
  ...await original<typeof import("@workloom/base/model-router")>(), escalate: fixture.escalate, poolFromEnv: fixture.pool,
}));
import { modelFeedbackRouter } from "./credits-router.js";

const identity: Identity = { kind: "member", tenantId: "tenant-feedback", workspaceId: "workspace-feedback", memberId: "member-feedback",
  memberNo: "OWNER-feedback", name: "隔离反馈夹具", role: "owner", plan: "pro" };
const input = { scene: "ask-synthesize", action: "ask-synthesize", prompt: "分析公开资料中的证据缺口", fromTier: "L2" as const };
const caller = (value: Identity | null = identity) => modelFeedbackRouter.createCaller({ session: value, identity: value, partnerIdentity: null, headers: new Headers() });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.authority.mockImplementation(async value => ({ identity: value, permissions: {} }));
  fixture.bundle.mockResolvedValue({ state: "ready", bundleId: "consulting" });
  fixture.pool.mockReturnValue(new Map());
  fixture.escalate.mockResolvedValue({ escalated: true, fromTier: "L2", toTier: "L3", freeEscalation: true, kind: "answered", text: "no-cost fixture" });
});
describe("consulting feedback cannot bypass the fixed model and task budget", () => {
  it("rejects consulting escalation before assembling any alternate model provider", async () => {
    await expect(caller().escalate(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fixture.pool).not.toHaveBeenCalled(); expect(fixture.escalate).not.toHaveBeenCalled();
    expect(fixture.bundle).toHaveBeenCalledWith(identity.workspaceId);
  });
  it.each(["not-installed", "projection-invalid", "bundle-mismatch"])("fails closed when the active industry is %s", async state => {
    fixture.bundle.mockResolvedValue({ state, bundleId: null });
    await expect(caller().escalate(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fixture.pool).not.toHaveBeenCalled(); expect(fixture.escalate).not.toHaveBeenCalled();
  });
  it("retains the existing escalation route for an authenticated permitted non-consulting workspace", async () => {
    fixture.bundle.mockResolvedValue({ state: "ready", bundleId: "hotel" });
    await expect(caller().escalate(input)).resolves.toMatchObject({ escalated: true, toTier: "L3", text: "no-cost fixture" });
    expect(fixture.pool).toHaveBeenCalledTimes(1); expect(fixture.escalate).toHaveBeenCalledTimes(1);
  });
  it("rejects unauthenticated and readonly callers before any model or bundle I/O", async () => {
    await expect(caller(null).escalate(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller({ ...identity, role: "readonly" }).escalate(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.bundle).not.toHaveBeenCalled(); expect(fixture.pool).not.toHaveBeenCalled(); expect(fixture.escalate).not.toHaveBeenCalled();
  });
});
