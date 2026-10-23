/** Explicit demo seeds may write only their own already-marked example workspace. */
export interface DemoWorkspaceDefinition {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  slug: string;
  industry: string;
  bundleId: string;
  stage: string;
  nightConfig: Record<string, unknown>;
}

interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A gateway credential may change role, never the checked database target. */
export function assertDemoDatabaseTargets(ownerUrl: string, gatewayUrl: string): void {
  const targetOf = (value: string) => {
    try {
      const url = new URL(value);
      const port = url.port ? Number(url.port) : 5432;
      const database = decodeURIComponent(url.pathname.slice(1));
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.search || url.hash
        || !Number.isInteger(port) || port < 1 || port > 65535 || !database || database.includes("/") || database.includes("\\")) throw new Error();
      return JSON.stringify([url.hostname.toLowerCase(), port, database]);
    } catch {
      throw new Error("演示种子连接必须显式声明同一数据库主机、端口和库名，且不能带覆盖目标的查询参数");
    }
  };
  if (targetOf(ownerUrl) !== targetOf(gatewayUrl)) {
    throw new Error("演示种子的 owner 与 gateway 数据库目标不一致；未连接数据库，未写入任何演示数据");
  }
}

function conflict(): never {
  throw new Error("演示种子目标与现有工作区身份冲突；保留现有数据，禁止把正式或未知工作区改为示例");
}

function isProductionInstallFlag(value: unknown): boolean {
  return value === true || value === "true";
}

async function readAndLock(client: QueryClient, target: DemoWorkspaceDefinition, allowMissing: boolean): Promise<boolean> {
  const found = await client.query(
    `SELECT id, tenant_id, slug, industry, bundle_id, is_example FROM workspaces
     WHERE id=$1 OR slug=$2 ORDER BY id FOR NO KEY UPDATE`,
    [target.id, target.slug],
  );
  if (found.rows.length === 0) {
    if (allowMissing) return false;
    return conflict();
  }
  const workspace = found.rows[0]!;
  if (found.rows.length !== 1 || workspace.id !== target.id || workspace.tenant_id !== target.tenantId
    || workspace.slug !== target.slug || workspace.industry !== target.industry
    || workspace.bundle_id !== target.bundleId || workspace.is_example !== true) conflict();
  const profiles = await client.query(
    `SELECT tenant_id, industry, archive FROM profiles WHERE workspace_id=$1 FOR NO KEY UPDATE`,
    [target.id],
  );
  if (profiles.rows.length > 1) conflict();
  const profile = profiles.rows[0];
  if (profile) {
    const archive = profile.archive;
    if (profile.tenant_id !== target.tenantId || profile.industry !== target.industry
      || !archive || typeof archive !== "object" || Array.isArray(archive)
      || (archive as Record<string, unknown>).dataMode !== "simulated") conflict();
    const business = (archive as Record<string, unknown>).business;
    if (business && typeof business === "object" && !Array.isArray(business)
      && ((business as Record<string, unknown>).source === "user" || (business as Record<string, unknown>).configured_at)) conflict();
    if ((archive as Record<string, unknown>).realModeActivation || isProductionInstallFlag((archive as Record<string, unknown>).production_install)) conflict();
  }
  const installs = await client.query(
    `SELECT bundle_id, assets, status FROM bundle_installs WHERE workspace_id=$1 FOR NO KEY UPDATE`,
    [target.id],
  );
  for (const install of installs.rows) {
    const assets = install.assets;
    const structuredAssets = assets !== null && typeof assets === "object" && !Array.isArray(assets);
    // A previous formal install remains evidence even after uninstall or a legacy
    // status change. Only ordinary active metadata belongs to the current bundle.
    if (structuredAssets && isProductionInstallFlag((assets as Record<string, unknown>).production_install)) conflict();
    if (install.status === "active" && (install.bundle_id !== target.bundleId || !structuredAssets)) conflict();
  }
  return true;
}

/**
 * Leaves one explicit owner transaction open. The caller commits after its owner writes.
 * Existing rows stay locked against conversion to a formal workspace while that phase runs.
 */
export async function beginDemoWorkspacePhase(client: QueryClient, target: DemoWorkspaceDefinition, create: boolean): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`demo-seed:${target.id}`]);
    const exists = await readAndLock(client, target, create);
    if (!exists) {
      await client.query("INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro') ON CONFLICT (id) DO NOTHING", [target.tenantId, target.tenantName]);
      await client.query(
        `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config, bundle_id, is_example)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) ON CONFLICT DO NOTHING`,
        [target.id, target.tenantId, target.name, target.slug, target.industry, target.stage, JSON.stringify(target.nightConfig), target.bundleId],
      );
      // A competing creator may have won either the ID or the slug. Never update its identity.
      await readAndLock(client, target, false);
    }
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], "演示目标检查失败且事务回滚未完成"); }
    throw error;
  }
}
