import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertSuiteFixtureEnvironment, prepareSuiteDemoFixture } from "./suite-fixture-preflight.mjs";

const env = { NODE_ENV: "test", WORKLOOM_ALLOW_DEMO_AUTH: "1", LLM_PROVIDER: "mock",
  DATABASE_URL: "postgres://owner@127.0.0.1:45432/fixture",
  DATABASE_APP_URL: "postgres://app:unit-only@127.0.0.1:45432/fixture",
  DATABASE_GATEWAY_URL: "postgres://gateway:unit-only@127.0.0.1:45432/fixture" };
const demo = { tenant_id: "tenant-demo", slug: "yunqi-hotel", industry: "hotel", bundle_id: "hotel", is_example: true,
  profile_tenant_id: "tenant-demo", profile_industry: "hotel", archive: { dataMode: "simulated" } };
function factory(row = demo, installs = []) {
  const queries = [];
  return { queries, clientFactory: () => ({ async connect() {}, async end() {}, async query(sql, args) {
    queries.push({ sql, args }); return { rows: sql.includes("SELECT w.tenant_id") ? [row] : sql.includes("FROM bundle_installs") ? installs : [], rowCount: 1 };
  } }) };
}

test("explicit mock demo context accepts matching owner/app/gateway targets", () => {
  assert.deepEqual(assertSuiteFixtureEnvironment(env), { target: "127.0.0.1:45432/fixture" });
});
for (const [name, change] of [
  ["production", { NODE_ENV: "production" }], ["implicit demo auth", { WORKLOOM_ALLOW_DEMO_AUTH: undefined }],
  ["paid model", { LLM_PROVIDER: "deepseek" }], ["different database", { DATABASE_APP_URL: "postgres://app@127.0.0.1:45432/other" }],
  ["missing owner", { DATABASE_URL: undefined }],
  ["connection query override", { DATABASE_APP_URL: "postgres://app@127.0.0.1:45432/fixture?host=other.invalid" }],
]) test(`reject ${name} before fixture mutation`, async () => {
  const f = factory(); await assert.rejects(prepareSuiteDemoFixture({ ...env, ...change }, { runId: "stunit1", clientFactory: f.clientFactory }));
  assert.equal(f.queries.length, 0);
});
test("already marked simulated sample is used without changing its identity, with a separate formal auth probe", async () => {
  const f = factory(); const fixture = await prepareSuiteDemoFixture(env, { runId: "stunit1", clientFactory: f.clientFactory });
  assert.deepEqual(fixture.formalProbe, { id: "ws-suite-formal-stunit1", slug: "suite-formal-stunit1" });
  await fixture.restore();
  assert.ok(f.queries.some((q) => q.sql.includes("DELETE FROM workspaces") && q.args[0] === fixture.formalProbe.id));
  assert.ok(f.queries.every((q) => !/UPDATE workspaces/i.test(q.sql)));
  assert.ok(f.queries.every((q) => !/DELETE FROM biz_events|TRUNCATE|UPDATE biz_events/i.test(q.sql)));
});
for (const [name, row] of [
  ["real customer data", { ...demo, archive: { dataMode: "real" } }],
  ["production installation", { ...demo, archive: { dataMode: "simulated", production_install: true } }],
  ["different tenant", { ...demo, tenant_id: "customer" }],
  ["different sample slug", { ...demo, slug: "real-customer" }],
  ["unmarked ambiguous workspace", { ...demo, is_example: false }],
]) test(`reject ${name} without promoting demo login`, async () => {
  const f = factory(row); await assert.rejects(prepareSuiteDemoFixture(env, { runId: "stunit1", clientFactory: f.clientFactory }), /明确 simulated/);
  assert.ok(f.queries.every((q) => !q.sql.includes("SET is_example=true")));
  assert.ok(f.queries.some((q) => q.sql === "ROLLBACK"));
});

for (const [name, patch] of [
  ["string formal profile flag", { archive: { dataMode: "simulated", production_install: "true" } }],
  ["user business", { archive: { dataMode: "simulated", business: { source: "user" } } }],
  ["configured business", { archive: { dataMode: "simulated", business: { configured_at: "2026-10-24" } } }],
  ["explicit empty business configuration", { archive: { dataMode: "simulated", business: { configured_at: "" } } }],
  ["explicit null business configuration", { archive: { dataMode: "simulated", business: { configured_at: null } } }],
  ["real activation", { archive: { dataMode: "simulated", realModeActivation: { verifiedAt: "2026-10-24" } } }],
  ["explicit null activation", { archive: { dataMode: "simulated", realModeActivation: null } }],
  ["foreign profile tenant", { profile_tenant_id: "customer" }],
  ["foreign profile industry", { profile_industry: "consulting" }],
  ["foreign bundle", { bundle_id: "consulting" }],
]) test(`reject contradictory ${name} before inserting a probe`, async () => {
  const f = factory({ ...demo, ...patch });
  await assert.rejects(prepareSuiteDemoFixture(env, { runId: "stunit1", clientFactory: f.clientFactory }), /明确 simulated/);
  assert.ok(f.queries.every((q) => !q.sql.includes("INSERT INTO workspaces")));
  assert.ok(f.queries.some((q) => q.sql === "ROLLBACK"));
});

for (const status of ["active", "inactive", "uninstalled"]) {
  for (const formal of [true, "true"]) {
    test(`reject ${status} production-install ${JSON.stringify(formal)} despite simulated example labels`, async () => {
      const f = factory(demo, [{ bundle_id: "hotel", assets: { production_install: formal }, status }]);
      await assert.rejects(prepareSuiteDemoFixture(env, { runId: "stunit1", clientFactory: f.clientFactory }), /明确 simulated/);
      assert.ok(f.queries.every((q) => !q.sql.includes("INSERT INTO workspaces")));
    });
  }
}

test("active foreign or malformed install metadata fails closed without rejecting ordinary removed metadata", async () => {
  for (const install of [{ bundle_id: "consulting", assets: {}, status: "active" }, { bundle_id: "hotel", assets: null, status: "active" }]) {
    const f = factory(demo, [install]);
    await assert.rejects(prepareSuiteDemoFixture(env, { runId: "stunit1", clientFactory: f.clientFactory }), /明确 simulated/);
    assert.ok(f.queries.every((q) => !q.sql.includes("INSERT INTO workspaces")));
  }
  const f = factory(demo, [{ bundle_id: "retired-bundle", assets: null, status: "uninstalled" }, { bundle_id: "retired-bundle", assets: [], status: "inactive" }]);
  await (await prepareSuiteDemoFixture(env, { runId: "stunit1", clientFactory: f.clientFactory })).restore();
  assert.ok(f.queries.some((q) => q.sql.includes("LOCK TABLE workspaces, profiles, bundle_installs")));
});

test("actual isolated SQL protects contradictory archives and historical formal installs with zero probe writes", async (context) => {
  const databaseUrl = process.env.SUITE_PREFLIGHT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(databaseUrl, "必须显式提供隔离测试数据库，不能跳过真实 SQL 断言");
  const owner = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const schema = `suite_preflight_${randomUUID().replaceAll("-", "")}`;
  const runId = `st${randomUUID().replaceAll("-", "")}`;
  const observations = [];
  const testEnv = { ...env, DATABASE_URL: databaseUrl, DATABASE_APP_URL: databaseUrl, DATABASE_GATEWAY_URL: databaseUrl };
  let created = false;
  await owner.connect();
  const clientFactory = () => {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
    return {
      async connect() { await client.connect(); await client.query(`SET search_path TO "${schema}",pg_catalog`); },
      query: (sql, args) => client.query(sql, args),
      end: () => client.end(),
    };
  };
  try {
    await owner.query(`CREATE SCHEMA "${schema}"`); created = true;
    await owner.query(`SET search_path TO "${schema}",pg_catalog`);
    await owner.query(`CREATE TABLE workspaces(id text PRIMARY KEY,tenant_id text,name text,slug text,industry text,stage text,bundle_id text,is_example boolean);
      CREATE TABLE profiles(workspace_id text PRIMARY KEY,tenant_id text,industry text,archive jsonb);
      CREATE TABLE bundle_installs(id text PRIMARY KEY,workspace_id text,bundle_id text,assets jsonb,status text)`);
    await owner.query("INSERT INTO workspaces VALUES ('ws-yunqi','tenant-demo','preserve fixture','yunqi-hotel','hotel','test','hotel',true)");
    await owner.query("INSERT INTO profiles VALUES ('ws-yunqi','tenant-demo','hotel',$1)", [{ dataMode: "simulated" }]);
    const scenarios = [
      { archive: { dataMode: "simulated", production_install: "true", sentinel: "keep formal profile" } },
      { archive: { dataMode: "simulated", business: { source: "user" }, sentinel: "keep user profile" } },
      { archive: { dataMode: "simulated", business: { configured_at: null }, sentinel: "keep configured profile" } },
      { archive: { dataMode: "simulated", realModeActivation: null, sentinel: "keep activation profile" } },
      ...["inactive", "uninstalled"].flatMap((status) => [true, "true"].map((formal) => ({
        archive: { dataMode: "simulated", sentinel: `keep ${status} ${formal}` }, install: { status, formal },
      }))),
    ];
    for (const scenario of scenarios) {
      await owner.query("UPDATE profiles SET archive=$1 WHERE workspace_id='ws-yunqi'", [scenario.archive]);
      await owner.query("DELETE FROM bundle_installs");
      if (scenario.install) await owner.query("INSERT INTO bundle_installs VALUES ('fixture-install','ws-yunqi','hotel',$1,$2)", [{ production_install: scenario.install.formal }, scenario.install.status]);
      await assert.rejects(prepareSuiteDemoFixture(testEnv, { runId, clientFactory }), /明确 simulated/);
      const archiveAfter = (await owner.query("SELECT archive FROM profiles WHERE workspace_id='ws-yunqi'")).rows[0].archive;
      const probeCountAfter = (await owner.query("SELECT count(*)::int AS count FROM workspaces WHERE id <> 'ws-yunqi'")).rows[0].count;
      const installsAfter = (await owner.query("SELECT assets,status FROM bundle_installs")).rows;
      assert.deepEqual(archiveAfter, scenario.archive);
      assert.equal(probeCountAfter, 0);
      if (scenario.install) assert.deepEqual(installsAfter[0], { assets: { production_install: scenario.install.formal }, status: scenario.install.status });
      observations.push({ archiveBefore: scenario.archive, archiveAfter, probeCountAfter, installsAfter });
    }
    await owner.query("UPDATE profiles SET archive=$1 WHERE workspace_id='ws-yunqi'", [{ dataMode: "simulated", sentinel: "ordinary example" }]);
    await owner.query("DELETE FROM bundle_installs");
    await owner.query("INSERT INTO bundle_installs VALUES ('ordinary-retired','ws-yunqi','retired-bundle',NULL,'uninstalled')");
    const fixture = await prepareSuiteDemoFixture(testEnv, { runId, clientFactory });
    await fixture.restore();
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM workspaces WHERE id <> 'ws-yunqi'")).rows[0].count, 0);
    assert.deepEqual((await owner.query("SELECT archive FROM profiles")).rows[0].archive, { dataMode: "simulated", sentinel: "ordinary example" });
  } finally {
    if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.end();
  }
  context.diagnostic(JSON.stringify({ schema, negativeCases: observations, ordinaryRemovedInstallAccepted: true, temporarySchemaRemoved: true }));
});
