import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const sourceScript = new URL("./reset.sh", import.meta.url);

function databaseLocation(host = "127.0.0.1", database = "workloom") {
  return `postgres://demo@${host}:5432/${database}`;
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-reset-safety-"));
  const bin = join(root, "bin");
  const scripts = join(root, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  copyFileSync(sourceScript, join(scripts, "reset.sh"));
  const log = join(root, "calls.log");

  writeExecutable(join(bin, "psql"), `#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  *"concat_ws('|', to_regclass('public.workspaces')"*) printf '%s\\n' "\${STUB_TABLE_STATE:-workspaces|profiles|bundle_installs}" ;;
  *"to_regclass('public.workspaces')"*) printf '%s\\n' "\${STUB_TABLE_STATE:-workspaces}" ;;
  *"information_schema.columns"*) printf '%s\\n' "\${STUB_EXAMPLE_COLUMN:-1}" ;;
  *"DROP SCHEMA public CASCADE"*)
    if [ "\${STUB_LOCK_CONFLICT:-0}" = "1" ]; then exit 1; fi
    printf '%s\\n' drop >>"$STUB_LOG" ;;
  *"unsafe_demo"*) printf '%s\\n' "\${STUB_UNSAFE_DEMO:-\${STUB_NON_EXAMPLE:-0}}" ;;
  *"is_example IS NOT TRUE"*) printf '%s\\n' "\${STUB_NON_EXAMPLE:-0}" ;;
  *) printf '%s\\n' unexpected-psql >>"$STUB_LOG" ;;
esac
`);
  writeExecutable(join(bin, "pg_dump"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${STUB_BACKUP_FAILURE:-0}" = "1" ]; then exit 1; fi
printf 'synthetic-backup-for-test\\n'
printf '%s\\n' backup >>"$STUB_LOG"
`);
  writeExecutable(join(bin, "pnpm"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${STUB_ASSERT_CHILD_DSNS:-0}" = "1" ]; then
  node --env-file=.env --input-type=module <<'NODE'
import { appendFileSync } from 'node:fs';
if (process.env.DATABASE_APP_URL !== process.env.DATABASE_URL || process.env.DATABASE_GATEWAY_URL !== process.env.DATABASE_URL) {
  console.error('reset child database target mismatch'); process.exit(66);
}
appendFileSync(process.env.STUB_LOG, 'all-child-dsns-match-validated-target\\n');
NODE
fi
printf 'pnpm %s\\n' "$*" >>"$STUB_LOG"
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
    DATABASE_URL: databaseLocation(),
    NODE_ENV: "test",
  };
  const run = (args = [], overrides = {}) => spawnSync("bash", [join(scripts, "reset.sh"), ...args], {
    cwd: root,
    env: { ...env, ...overrides },
    encoding: "utf8",
    input: "",
  });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  return { root, run, calls };
}

test("非交互调用没有 --yes 时 fail closed，且不访问数据库", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 64);
  assert.match(result.stderr, /非交互环境必须显式传入 --yes/);
  assert.equal(f.calls(), "");
});

test("远端、生产和数据库名不匹配目标始终拒绝", () => {
  for (const overrides of [
    { DATABASE_URL: databaseLocation("db.example.invalid") },
    { NODE_ENV: "production" },
    { DATABASE_URL: databaseLocation("127.0.0.1", "customer_prod") },
  ]) {
    const f = fixture();
    const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(f.calls(), "");
  }
});

test("检测到非演示工作区时拒绝删除", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_NON_EXAMPLE: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /正式|非演示工作区/);
  assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
});

test("本机 workloom 纯演示库先备份，再事务重建并执行迁移种子", () => {
  const f = fixture();
  const result = f.run(["--yes"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(f.calls(), /backup/);
  assert.match(f.calls(), /drop/);
  assert.match(f.calls(), /pnpm db:migrate/);
  assert.match(f.calls(), /pnpm db:seed:demo/);
  assert.match(result.stdout, /已生成重置前备份/);
});

test("未知参数 fail closed", () => {
  const f = fixture();
  const result = f.run(["--force"]);
  assert.equal(result.status, 64);
  assert.equal(f.calls(), "");
});

test("连接参数覆盖、缺少事实表或示例列均在备份和删除前拒绝", () => {
  for (const overrides of [
    { DATABASE_URL: `${databaseLocation()}?host=db.example.invalid` },
    { STUB_TABLE_STATE: "absent" },
    { STUB_EXAMPLE_COLUMN: "0" },
  ]) {
    const f = fixture(); const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
  }
});

test("备份失败或锁内出现正式工作区时不执行重建与种子", () => {
  for (const overrides of [{ STUB_BACKUP_FAILURE: "1" }, { STUB_LOCK_CONFLICT: "1" }]) {
    const f = fixture(); const result = f.run(["--yes"], overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(f.calls(), /drop|pnpm/);
  }
});

test("迁移与种子子进程的全部DSN固定到已验证目标，ambient与.env无法改连其他实例且不泄露凭据", () => {
  const f = fixture();
  const owner = "postgres://maintenance:unit-only-password@127.0.0.1:45444/workloom";
  const remote = "postgres://gateway:unit-only-remote-password@remote.invalid:5432/customer_prod";
  writeFileSync(join(f.root, ".env"), `DATABASE_URL=${remote}\nDATABASE_APP_URL=${remote}\nDATABASE_GATEWAY_URL=${remote}\n`);
  const result = f.run(["--yes"], { DATABASE_URL: owner, DATABASE_APP_URL: remote, DATABASE_GATEWAY_URL: remote, STUB_ASSERT_CHILD_DSNS: "1" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(f.calls().split("all-child-dsns-match-validated-target").length - 1, 2);
  assert.doesNotMatch(result.stdout + result.stderr + f.calls(), /unit-only-password|unit-only-remote-password|remote.invalid/);
});

test("示例标记仍为真但正式档案或安装事实矛盾时，在备份和删除前拒绝", () => {
  const f = fixture();
  const result = f.run(["--yes"], { STUB_NON_EXAMPLE: "0", STUB_UNSAFE_DEMO: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /正式|身份矛盾/);
  assert.doesNotMatch(f.calls(), /drop|backup|pnpm/);
});

// Execute the production predicate in task-owned random schemas. These tests do
// not execute DROP SCHEMA public or the reset command against any real database.
const resetSource = readFileSync(sourceScript, "utf8");
const guardMatch = /UNSAFE_DEMO_SQL=\$\(cat <<'SQL'\n([\s\S]*?)\nSQL\n\)/.exec(resetSource);
async function withGuardDatabase(body) {
  assert.ok(guardMatch, "reset must share one exact unsafe-data predicate before backup and under table locks");
  const databaseUrl = process.env.RESET_SAFETY_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(databaseUrl, "reset SQL assertions require an explicitly isolated test database; cannot skip them");
  const owner = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const other = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const schema = `reset_guard_${randomUUID().replaceAll("-", "")}`;
  const ns = `"${schema}"`;
  const guard = guardMatch[1].replaceAll("public.", `${ns}.`);
  let ownerConnected = false; let otherConnected = false; let created = false;
  try {
    await owner.connect(); ownerConnected = true;
    await other.connect(); otherConnected = true;
    await owner.query(`CREATE SCHEMA ${ns}`); created = true;
    await owner.query(`CREATE TABLE ${ns}.workspaces(id text PRIMARY KEY, tenant_id text, slug text, industry text, bundle_id text, is_example boolean);
      CREATE TABLE ${ns}.profiles(workspace_id text PRIMARY KEY, tenant_id text, industry text, archive jsonb);
      CREATE TABLE ${ns}.bundle_installs(id text PRIMARY KEY, workspace_id text, bundle_id text, assets jsonb, status text)`);
    const install = async (archive = { dataMode: "simulated" }) => {
      await owner.query(`TRUNCATE ${ns}.workspaces,${ns}.profiles,${ns}.bundle_installs`);
      await owner.query(`INSERT INTO ${ns}.workspaces VALUES ('ws-yunqi','tenant-demo','yunqi-hotel','hotel','hotel',true)`);
      await owner.query(`INSERT INTO ${ns}.profiles VALUES ('ws-yunqi','tenant-demo','hotel',$1)`, [archive]);
      await owner.query(`INSERT INTO ${ns}.bundle_installs VALUES ('fixture-install','ws-yunqi','hotel','{}','active')`);
    };
    await install();
    await body({ owner, other, ns, guard, install, unsafe: async () => (await owner.query(guard)).rows.length });
  } finally {
    const rollbacks = await Promise.allSettled([...(ownerConnected ? [owner.query("ROLLBACK")] : []), ...(otherConnected ? [other.query("ROLLBACK")] : [])]);
    try { if (created) await owner.query(`DROP SCHEMA ${ns} CASCADE`); }
    finally { await Promise.all([owner.end(), other.end()]); }
    const rollbackFailure = rollbacks.find((result) => result.status === "rejected");
    if (rollbackFailure) throw rollbackFailure.reason;
  }
}

test("实际SQL仅接受精确的酒店/咨询simulated示例，拒绝空库、未知身份和缺失档案", async () => {
  await withGuardDatabase(async ({ owner, ns, unsafe, install }) => {
    assert.equal(await unsafe(), 0);
    await owner.query(`INSERT INTO ${ns}.workspaces VALUES ('ws-eagle','tenant-demo','eagle-consulting','consulting','consulting',true)`);
    await owner.query(`INSERT INTO ${ns}.profiles VALUES ('ws-eagle','tenant-demo','consulting','{"dataMode":"simulated"}')`);
    assert.equal(await unsafe(), 0);
    for (const mutation of [
      `UPDATE ${ns}.workspaces SET is_example=false`,
      `UPDATE ${ns}.workspaces SET id='unknown-workspace'`,
      `UPDATE ${ns}.workspaces SET tenant_id='unknown-tenant'`,
      `UPDATE ${ns}.workspaces SET bundle_id=NULL`,
      `DELETE FROM ${ns}.profiles`,
      `UPDATE ${ns}.profiles SET tenant_id='unknown-tenant'`,
      `UPDATE ${ns}.profiles SET industry='unknown-industry'`,
      `TRUNCATE ${ns}.workspaces,${ns}.profiles,${ns}.bundle_installs`,
    ]) {
      await install(); await owner.query(mutation);
      assert.ok(await unsafe() > 0, mutation);
    }
  });
});

test("实际SQL拒绝real、用户经营信息、激活证明和正式安装档案，不靠示例标记放行", async () => {
  await withGuardDatabase(async ({ unsafe, install }) => {
    for (const archive of [null, [], {}, { dataMode: "real" }, { dataMode: "simulated", business: { source: "user" } },
      { dataMode: "simulated", business: { configured_at: "2026-10-24" } },
      { dataMode: "simulated", realModeActivation: { gateVersion: 1 } }, { dataMode: "simulated", production_install: true }]) {
      await install(archive); assert.ok(await unsafe() > 0, JSON.stringify(archive));
    }
  });
});

test("实际SQL拒绝活动安装矛盾与任何历史正式安装台账", async () => {
  await withGuardDatabase(async ({ owner, ns, unsafe, install }) => {
    for (const mutation of [
      `UPDATE ${ns}.bundle_installs SET assets='{"production_install":true}'`,
      `UPDATE ${ns}.bundle_installs SET status='inactive',assets='{"production_install":true}'`,
      `UPDATE ${ns}.bundle_installs SET bundle_id='other'`,
      `UPDATE ${ns}.bundle_installs SET assets=NULL`,
    ]) {
      await install(); await owner.query(mutation); assert.ok(await unsafe() > 0, mutation);
    }
  });
});

test("实际SQL最终校验同锁三事实表，阻止仅更新档案或安装台账的并发正式转换", async () => {
  await withGuardDatabase(async ({ owner, other, ns, unsafe }) => {
    assert.match(resetSource, /LOCK TABLE public\.workspaces, public\.profiles, public\.bundle_installs IN ACCESS EXCLUSIVE MODE/);
    await owner.query("BEGIN");
    await owner.query(`LOCK TABLE ${ns}.workspaces,${ns}.profiles,${ns}.bundle_installs IN ACCESS EXCLUSIVE MODE`);
    assert.equal(await unsafe(), 0);
    for (const mutation of [
      `UPDATE ${ns}.profiles SET archive='{"dataMode":"real"}'`,
      `UPDATE ${ns}.bundle_installs SET assets='{"production_install":true}'`,
    ]) {
      await other.query("BEGIN"); await other.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(other.query(mutation), { code: "55P03" }); await other.query("ROLLBACK");
    }
    await owner.query("ROLLBACK"); assert.equal(await unsafe(), 0);
  });
});
