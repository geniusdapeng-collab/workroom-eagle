import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSuiteFixtureEnvironment, prepareSuiteDemoFixture } from "./suite-fixture-preflight.mjs";

const env = { NODE_ENV: "test", WORKLOOM_ALLOW_DEMO_AUTH: "1", LLM_PROVIDER: "mock",
  DATABASE_URL: "postgres://owner@127.0.0.1:45432/fixture",
  DATABASE_APP_URL: "postgres://app:unit-only@127.0.0.1:45432/fixture",
  DATABASE_GATEWAY_URL: "postgres://gateway:unit-only@127.0.0.1:45432/fixture" };
const demo = { tenant_id: "tenant-demo", slug: "yunqi-hotel", industry: "hotel", is_example: true, archive: { dataMode: "simulated" } };
function factory(row = demo) {
  const queries = [];
  return { queries, clientFactory: () => ({ async connect() {}, async end() {}, async query(sql, args) {
    queries.push({ sql, args }); return { rows: sql.includes("SELECT w.tenant_id") ? [row] : [], rowCount: 1 };
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
