/** Explicit legacy demonstration fixture setup for the destructive scenario suite. */
import pg from "pg";

function target(raw, field) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`套件必须显式配置 ${field}`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.search || url.hash) {
    throw new Error(`套件 ${field} 不是有效 PostgreSQL 目标`);
  }
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

export function assertSuiteFixtureEnvironment(env) {
  if (env.NODE_ENV === "production") throw new Error("场景套件不得在 production 运行");
  if (env.WORKLOOM_ALLOW_DEMO_AUTH !== "1") throw new Error("场景套件需要显式 WORKLOOM_ALLOW_DEMO_AUTH=1；正式认证边界保持关闭");
  if (env.LLM_PROVIDER !== "mock") throw new Error("场景套件只允许显式 LLM_PROVIDER=mock，禁止连接付费模型");
  const targets = ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"].map((field) => target(env[field], field));
  if (new Set(targets).size !== 1) throw new Error("场景套件的 owner/app/gateway 必须指向同一明确测试库");
  return { target: targets[0] };
}

/**
 * Only the known, explicitly simulated and example-marked legacy sample is used.
 * A new empty non-example auth probe is removed on exit; existing workspace
 * identities are never changed by this preflight.
 * append-only scenario events remain in the caller's dedicated test database.
 */
export async function prepareSuiteDemoFixture(env, { runId, clientFactory = (url) => new pg.Client({ connectionString: url }) } = {}) {
  assertSuiteFixtureEnvironment(env);
  if (!/^st[a-z0-9]+$/.test(runId ?? "")) throw new Error("场景套件运行标识无效");
  const formalProbe = { id: `ws-suite-formal-${runId}`, slug: `suite-formal-${runId}` };
  const client = clientFactory(env.DATABASE_URL);
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT w.tenant_id,w.slug,w.industry,w.is_example,p.archive
       FROM workspaces w JOIN profiles p ON p.workspace_id=w.id
       WHERE w.id=$1 FOR UPDATE OF w`, ["ws-yunqi"],
    );
    const row = result.rows[0];
    if (!row || row.tenant_id !== "tenant-demo" || row.slug !== "yunqi-hotel" || row.industry !== "hotel"
      || row.is_example !== true || row.archive?.dataMode !== "simulated" || row.archive?.production_install === true) {
      throw new Error("场景套件只接受 tenant-demo/ws-yunqi 的明确 simulated、is_example=true 演示夹具，拒绝修改正式工作区");
    }
    await client.query(
      `INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage,is_example)
       VALUES ($1,'tenant-demo','套件正式认证拒绝探针',$2,'general','test',false)`,
      [formalProbe.id, formalProbe.slug],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { await client.end(); }
  return {
    workspaceId: "ws-yunqi", workspaceSlug: "yunqi-hotel", formalProbe,
    async restore() {
      const restore = clientFactory(env.DATABASE_URL);
      await restore.connect();
      try {
        await restore.query("BEGIN");
        await restore.query(`DELETE FROM workspaces WHERE id=$1 AND slug=$2 AND is_example=false`, [formalProbe.id, formalProbe.slug]);
        await restore.query("COMMIT");
      } catch (error) { await restore.query("ROLLBACK"); throw error; }
      finally { await restore.end(); }
    },
  };
}
