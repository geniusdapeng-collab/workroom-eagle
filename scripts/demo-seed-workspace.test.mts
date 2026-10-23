import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { assertDemoDatabaseTargets, beginDemoWorkspacePhase, type DemoWorkspaceDefinition } from "./demo-seed-workspace.js";

const target: DemoWorkspaceDefinition = {
  id: "unit-demo-workspace", tenantId: "unit-demo-tenant", tenantName: "单元演示租户",
  name: "单元演示工作区", slug: "unit-demo-slug", industry: "hotel", bundleId: "hotel", stage: "stable", nightConfig: { enabled: false },
};
const workspace = () => ({ id: target.id, tenant_id: target.tenantId, slug: target.slug, industry: target.industry, bundle_id: target.bundleId, is_example: true });
function fixture(row: Record<string, unknown> = workspace(), profile?: Record<string, unknown>) {
  const calls: string[] = [];
  return { calls, client: { query: async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith("SELECT id,")) return { rows: [row] };
    if (sql.startsWith("SELECT tenant_id,")) return { rows: profile ? [profile] : [] };
    return { rows: [] };
  } } };
}
const writes = (calls: string[]) => calls.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/u.test(sql));

test("owner/gateway credentials may differ but target overrides and ambiguous or different databases are rejected", () => {
  const owner = "postgres://unit-owner:unit-owner-secret@127.0.0.1:5432/eagle_audit";
  assert.doesNotThrow(() => assertDemoDatabaseTargets(owner, "postgresql://unit-gateway:unit-gateway-secret@127.0.0.1/eagle_%61udit"));
  for (const candidate of ["postgres://gateway@127.0.0.2:5432/eagle_audit", "postgres://gateway@127.0.0.1:5433/eagle_audit",
    "postgres://gateway@127.0.0.1:5432/other", "postgres://gateway@127.0.0.1:5432/eagle_audit?host=another-instance",
    "postgres://gateway@127.0.0.1:5432/eagle_audit?dbname=other", "postgres://gateway@127.0.0.1:5432/eagle_audit#ignored",
    "postgres://gateway@127.0.0.1", "postgres://gateway@127.0.0.1/eagle%2faudit", "https://127.0.0.1/eagle_audit", "not-a-dsn"]) {
    assert.throws(() => assertDemoDatabaseTargets(owner, candidate), (error) => error instanceof Error && !error.message.includes("unit-owner-secret"));
  }
});

test("both real seed entry points reject different targets before opening either TCP connection", async () => {
  let connections = 0;
  const servers = [createServer((socket) => { connections++; socket.destroy(); }), createServer((socket) => { connections++; socket.destroy(); })];
  try {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); })));
    const ports = servers.map((server) => (server.address() as { port: number }).port);
    for (const file of ["seed.ts", "seed-consulting.ts"]) {
      const command = promisify(execFile)(process.execPath, ["--import", "tsx", `scripts/${file}`], {
        cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15000,
        env: { ...process.env, DATABASE_URL: `postgres://unit-owner:unit-only-secret@127.0.0.1:${ports[0]}/unit`,
          DATABASE_GATEWAY_URL: `postgres://unit-gateway:unit-only-secret@127.0.0.1:${ports[1]}/unit` },
      });
      await assert.rejects(command, (error) => {
        const failure = error as { code?: number; stderr?: string };
        return failure.code === 1 && Boolean(failure.stderr?.includes("数据库目标不一致")) && !failure.stderr?.includes("unit-only-secret");
      });
    }
    assert.equal(connections, 0);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
});

test("existing formal, unknown, foreign ID/slug/tenant/industry/bundle collisions fail before demo writes", async () => {
  for (const patch of [{ is_example: false }, { is_example: null }, { id: "foreign-id" }, { slug: "foreign-slug" },
    { tenant_id: "foreign-tenant" }, { industry: "consulting" }, { bundle_id: null }, { bundle_id: "consulting" }]) {
    const f = fixture({ ...workspace(), ...patch });
    await assert.rejects(beginDemoWorkspacePhase(f.client, target, true), /身份冲突/);
    assert.deepEqual(writes(f.calls), []); assert.equal(f.calls.at(-1), "ROLLBACK");
  }
});

test("even a marked example cannot overwrite a real, unknown or user-configured profile", async () => {
  for (const archive of [{ dataMode: "real" }, {}, { dataMode: "simulated", business: { source: "user" } },
    { dataMode: "simulated", business: { configured_at: "2026-10-24" } }, { dataMode: "simulated", realModeActivation: { at: "2026-10-24" } },
    { dataMode: "simulated", production_install: true }]) {
    const f = fixture(workspace(), { tenant_id: target.tenantId, industry: target.industry, archive });
    await assert.rejects(beginDemoWorkspacePhase(f.client, target, true), /身份冲突/);
    assert.deepEqual(writes(f.calls), []); assert.equal(f.calls.at(-1), "ROLLBACK");
  }
});

test("an exact simulated example is reused without updating its marker or committing the caller phase", async () => {
  const f = fixture(workspace(), { tenant_id: target.tenantId, industry: target.industry, archive: { dataMode: "simulated" } });
  await beginDemoWorkspacePhase(f.client, target, false);
  assert.deepEqual(writes(f.calls), []); assert.equal(f.calls.includes("COMMIT"), false);
  assert.equal(f.calls.some((sql) => sql.includes("FOR NO KEY UPDATE")), true);
});

test("database failures roll back and a failed rollback remains explicit", async () => {
  for (const rollbackFails of [false, true]) {
    const client = { query: async (sql: string) => {
      if (sql.startsWith("SELECT id,")) throw new Error("unit target read failed");
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("unit rollback failed");
      return { rows: [] };
    } };
    await assert.rejects(beginDemoWorkspacePhase(client, target, true), rollbackFails ? AggregateError : /target read failed/);
  }
});

const databaseUrl = process.env.DEMO_SEED_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
async function withDatabase(body: (owner: pg.Client, other: pg.Client) => Promise<void>) {
  if (!databaseUrl) throw new Error("碰撞与行锁验收必须显式提供隔离测试 DATABASE_URL 或 DEMO_SEED_TEST_DATABASE_URL，不能跳过真实 SQL 断言");
  const owner = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const other = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const schema = `demo_seed_guard_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let ownerConnected = false;
  let otherConnected = false;
  try {
    await owner.connect(); ownerConnected = true;
    await other.connect(); otherConnected = true;
    await owner.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const client of [owner, other]) await client.query(`SET search_path TO "${schema}",pg_catalog`);
    await owner.query(`CREATE TABLE tenants (id text PRIMARY KEY, name text NOT NULL, plan text NOT NULL);
      CREATE TABLE workspaces (id text PRIMARY KEY, tenant_id text REFERENCES tenants(id), name text, slug text UNIQUE,
        industry text, stage text, night_config jsonb, bundle_id text, is_example boolean NOT NULL DEFAULT false);
      CREATE TABLE profiles (workspace_id text PRIMARY KEY REFERENCES workspaces(id), tenant_id text, industry text, archive jsonb);
      CREATE TABLE children (workspace_id text REFERENCES workspaces(id));
      CREATE TABLE bundle_installs (id text PRIMARY KEY, workspace_id text REFERENCES workspaces(id), bundle_id text, assets jsonb, status text)`);
    await body(owner, other);
  } finally {
    await Promise.allSettled([...(ownerConnected ? [owner.query("ROLLBACK")] : []), ...(otherConnected ? [other.query("ROLLBACK")] : [])]);
    if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await Promise.allSettled([owner.end(), other.end()]);
  }
}

test("actual SQL creates an explicit example and repeat initialization preserves its identity", async () => {
  await withDatabase(async (owner) => {
    await beginDemoWorkspacePhase(owner, target, true);
    await owner.query("INSERT INTO profiles VALUES ($1,$2,$3,$4)", [target.id, target.tenantId, target.industry, { dataMode: "simulated", userNote: "preserve fixture" }]);
    await owner.query("COMMIT");
    await beginDemoWorkspacePhase(owner, { ...target, name: "a changed seed label" }, true); await owner.query("COMMIT");
    const found = await owner.query("SELECT w.name,w.is_example,w.bundle_id,p.archive FROM workspaces w JOIN profiles p ON p.workspace_id=w.id");
    assert.equal(found.rows.length, 1); assert.equal(found.rows[0].name, target.name);
    assert.equal(found.rows[0].is_example, true); assert.equal(found.rows[0].bundle_id, target.bundleId);
    assert.deepEqual(found.rows[0].archive, { dataMode: "simulated", userNote: "preserve fixture" });
  });
});

test("actual SQL rejects formal ID and slug collisions while preserving every existing profile", async () => {
  await withDatabase(async (owner) => {
    await owner.query("INSERT INTO tenants VALUES ($1,$2,'pro')", [target.tenantId, "existing fixture"]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,bundle_id,is_example) VALUES ($1,$2,$3,$4,$5,$6,false)", [target.id, target.tenantId, "formal fixture", target.slug, target.industry, target.bundleId]);
    await owner.query("INSERT INTO profiles VALUES ($1,$2,$3,$4)", [target.id, target.tenantId, target.industry, { dataMode: "real", sentinel: "keep this authorized fixture" }]);
    for (const requested of [target, { ...target, id: "another-demo-id" }]) await assert.rejects(beginDemoWorkspacePhase(owner, requested, true), /身份冲突/);
    const rows = await owner.query("SELECT w.is_example,p.archive FROM workspaces w JOIN profiles p ON p.workspace_id=w.id");
    assert.deepEqual(rows.rows, [{ is_example: false, archive: { dataMode: "real", sentinel: "keep this authorized fixture" } }]);
  });
});

test("actual SQL rechecks a competing formal creator after the initially empty lookup", async () => {
  await withDatabase(async (owner, other) => {
    await owner.query("INSERT INTO tenants VALUES ($1,$2,'pro')", [target.tenantId, "existing fixture"]);
    let raced = false;
    const guarded = { query: async (sql: string, params?: unknown[]) => {
      const result = await owner.query(sql, params);
      if (!raced && sql.startsWith("SELECT id,") && result.rows.length === 0) {
        raced = true;
        await other.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,bundle_id,is_example) VALUES ($1,$2,$3,$4,$5,$6,false)", [target.id, target.tenantId, "competing formal fixture", target.slug, target.industry, target.bundleId]);
      }
      return result;
    } };
    await assert.rejects(beginDemoWorkspacePhase(guarded, target, true), /身份冲突/);
    const row = (await owner.query("SELECT name,is_example FROM workspaces")).rows[0];
    assert.deepEqual(row, { name: "competing formal fixture", is_example: false });
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM profiles")).rows[0].n, 0);
  });
});

test("actual SQL refuses an active production install even when legacy workspace/profile labels contradict it", async () => {
  await withDatabase(async (owner) => {
    await beginDemoWorkspacePhase(owner, target, true);
    await owner.query("INSERT INTO profiles VALUES ($1,$2,$3,$4)", [target.id, target.tenantId, target.industry, { dataMode: "simulated", sentinel: "preserve contradictory fixture" }]);
    await owner.query("INSERT INTO bundle_installs VALUES ('unit-production-install',$1,$2,$3,'active')", [target.id, target.bundleId, { production_install: true }]);
    await owner.query("COMMIT");
    await assert.rejects(beginDemoWorkspacePhase(owner, target, true), /身份冲突/);
    assert.equal((await owner.query("SELECT assets->>'production_install' AS formal FROM bundle_installs")).rows[0].formal, "true");
    assert.equal((await owner.query("SELECT archive->>'sentinel' AS sentinel FROM profiles")).rows[0].sentinel, "preserve contradictory fixture");
  });
});

test("actual gateway-phase lock permits foreign-key writes but blocks conversion until the owner commits", async () => {
  await withDatabase(async (owner, other) => {
    await beginDemoWorkspacePhase(owner, target, true); await owner.query("COMMIT");
    await beginDemoWorkspacePhase(owner, target, false);
    await other.query("BEGIN"); await other.query("SET LOCAL lock_timeout='100ms'");
    await other.query("INSERT INTO children VALUES ($1)", [target.id]); await other.query("COMMIT");
    await other.query("BEGIN"); await other.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(other.query("UPDATE workspaces SET is_example=false WHERE id=$1", [target.id]), { code: "55P03" });
    await other.query("ROLLBACK"); await owner.query("COMMIT");
    await other.query("UPDATE workspaces SET is_example=false WHERE id=$1", [target.id]);
    assert.equal((await other.query("SELECT is_example FROM workspaces WHERE id=$1", [target.id])).rows[0].is_example, false);
  });
});
