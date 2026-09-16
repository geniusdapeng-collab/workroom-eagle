/** 活库契约：鹰眼工作区没有登记业务数据适配器时，公开摘要端点必须失败关闭为空。 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://postgres:example@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:example@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:example@localhost:5432/workloom";
process.env.SERVICE_C_DEMO_AUTH = "true";

const CONSULTING_FIXTURE_WORKSPACE_ID = process.env.RELEASE_WORKSPACE_ID?.trim()
  || process.env.SERVICE_C_TEST_WORKSPACE_ID?.trim()
  || null;
const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_APP_URL)
  && Boolean(CONSULTING_FIXTURE_WORKSPACE_ID);

describe.runIf(RUN_DB)("鹰眼活动 Bundle 服务前台适配器 PG 契约", () => {
  let app: Hono;
  let token = "";
  let resolveWorkspaceBusinessAdapter: typeof import("./business-registry.js").resolveWorkspaceBusinessAdapter;

  beforeAll(async () => {
    ({ serviceGateway: app } = await import("../gateway.js"));
    ({ resolveWorkspaceBusinessAdapter } = await import("./business-registry.js"));
    const { issueCToken, cSecret } = await import("../channels.js");
    token = await issueCToken({
      workspaceId: CONSULTING_FIXTURE_WORKSPACE_ID!,
      cUserId: "contract-consulting-subject",
      channel: "h5",
      secret: cSecret(),
    });
  });

  it("咨询 Bundle 不会选择任何示例行业适配器", async () => {
    const binding = await resolveWorkspaceBusinessAdapter(CONSULTING_FIXTURE_WORKSPACE_ID!);
    expect(binding).toMatchObject({ state: "adapter-not-declared", adapter: null, bundleId: "consulting" });
  });

  it("公开订单与权益摘要端点返回明确不可用状态且不读取其他行业数据", async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const ordersResponse = await app.request("/orders", { headers });
    const memberResponse = await app.request("/member", { headers });
    expect(ordersResponse.status).toBe(200);
    expect(memberResponse.status).toBe(200);
    expect(await ordersResponse.json()).toMatchObject({ orders: [], demo: false, available: false });
    expect(await memberResponse.json()).toMatchObject({
      title: "权益信息不可用", benefits: [], demo: false, available: false,
    });
  });
});
