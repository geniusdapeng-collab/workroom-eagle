import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getOwnerPool } from "@workloom/db";
import { signDemoToken, type Identity } from "@workloom/base/tenancy";

/** 演示认证只有显式开发开关可用，production 中永远关闭。 */
export function demoAuthenticationAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.WORKLOOM_ALLOW_DEMO_AUTH === "1";
}

async function loadLocalOwner(): Promise<Identity | null> {
  const result = await getOwnerPool().query<Identity>(
    `SELECT m.id AS "memberId",m.member_no AS "memberNo",m.name,m.role,
            w.tenant_id AS "tenantId",w.id AS "workspaceId",t.plan
     FROM members m JOIN workspaces w ON w.id=m.workspace_id JOIN tenants t ON t.id=w.tenant_id
     JOIN profiles p ON p.workspace_id=w.id AND p.tenant_id=w.tenant_id
     WHERE w.id='ws-workroom-eagle-production' AND w.bundle_id='consulting' AND w.is_example=false
       AND m.id='member-workroom-eagle-local-owner' AND m.member_no='OWNER' AND m.role='owner'
       AND m.status='active' AND t.status='active' AND p.archive->>'dataMode'='real'`,
  );
  return result.rows[0] ?? null;
}

export function createLocalDesktopAuth(deps: {
  secret: () => string | undefined;
  loadOwner: () => Promise<Identity | null>;
  sign: (identity: Identity) => Promise<string>;
} = { secret: () => process.env.WORKLOOM_DESKTOP_SESSION_SECRET, loadOwner: loadLocalOwner, sign: signDemoToken }) {
  const app = new Hono();
  app.post("/session", async (c) => {
    c.header("cache-control", "no-store");
    // Electron 主进程 fetch 不带 Origin；任何网页请求都不能进入装机身份路径。
    if (c.req.header("origin")) return c.json({ error: "DESKTOP_ORIGIN_REQUIRED" }, 403);
    const expected = deps.secret();
    const supplied = c.req.header("x-workloom-desktop-secret") ?? "";
    if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return c.json({ error: "UNAUTHORIZED" }, 401);
    try {
      const identity = await deps.loadOwner();
      if (!identity) return c.json({ error: "PRODUCTION_WORKSPACE_NOT_READY" }, 503);
      return c.json({ token: await deps.sign(identity), identity, dataMode: "real" });
    } catch {
      return c.json({ error: "PRODUCTION_SESSION_UNAVAILABLE" }, 503);
    }
  });
  return app;
}
