import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { auditTrpcContract } from "./trpc-contract.mjs";

const requireServer = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { initTRPC, lazy } = requireServer("@trpc/server");
const t = initTRPC.create();
const read = () => t.procedure.query(() => { throw new Error("CONTRACT_SCAN_MUST_NOT_EXECUTE_HANDLERS"); });
const write = () => t.procedure.mutation(() => { throw new Error("CONTRACT_SCAN_MUST_NOT_EXECUTE_HANDLERS"); });
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "eagle-trpc-contract-"));
  const sourceRoot = join(root, "apps/web/src");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "Calls.tsx"), body);
  return { sourceRoot, close: () => rmSync(root, { recursive: true, force: true }) };
}
function check(router, body) {
  const f = fixture(body);
  try { return auditTrpcContract({ router, sourceRoot: f.sourceRoot }); }
  finally { f.close(); }
}

// Runtime router metadata is the authority: source filenames, variable names and
// router-factory syntax must not affect whether the procedure is really mounted.
test("mounted industry procedures outside trpc/ are discovered without executing them", () => {
  const industryFactory = () => t.router({ taskView: read(), taskAction: write(), taskReport: read() });
  const root = t.router({ consulting: industryFactory() });
  const result = check(root, `trpc.consulting.taskView.query({threadId:'T-1'});
    trpc.consulting.taskAction.mutate({threadId:'T-1'});
    trpc.consulting.taskReport.query({threadId:'T-1'});`);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.mountedPaths, ["consulting.taskAction", "consulting.taskReport", "consulting.taskView"]);
  assert.equal(result.references.length, 3);
});

test("factory aliases and nested routers use the complete mounted path", () => {
  const nestedFactory = () => t.router({ kb: t.router({ search: read() }) });
  const root = t.router({ service: nestedFactory() });
  assert.deepEqual(check(root, "trpc.service.kb.search.query({text:'x'})").missing, []);
  assert.deepEqual(check(root, "trpc.service.kb.typo.query({text:'x'})").missing.map((r) => r.path), ["service.kb.typo"]);
});

test("an unmounted router definition cannot make a web call pass", () => {
  const unused = t.router({ taskView: read() });
  assert.ok(unused._def.procedures.taskView);
  const root = t.router({ system: t.router({ health: read() }) });
  assert.deepEqual(check(root, "trpc.consulting.taskView.query({})").missing.map((r) => r.path), ["consulting.taskView"]);
});

test("misspelled top-level and leaf procedure names remain failures", () => {
  const root = t.router({ consulting: t.router({ taskView: read() }) });
  const result = check(root, "trpc.consultng.taskView.query({}); trpc.consulting.taskVeiw.query({});");
  assert.deepEqual(result.missing.map((r) => r.path), ["consulting.taskVeiw", "consultng.taskView"]);
});

test("namespace aliases require a real mounted prefix and do not hide nested typos", () => {
  const root = t.router({ service: t.router({ kb: t.router({ search: read() }) }) });
  const result = check(root, `const svc = trpc.service as unknown as SomeInterface;
    const kb = trpc.service.kb;
    trpc.service.kb.search.query({});
    trpc.service.kb.typo.query({});
    const absent = trpc.service.missing;`);
  assert.deepEqual(result.missing.map((r) => r.path), ["service.kb.typo", "service.missing"]);
  assert.equal(result.references.find((r) => r.path === "service").kind, "namespace");
});

test("AST scanning ignores examples in comments and strings, with TSX and literal brackets supported", () => {
  const root = t.router({ consulting: t.router({ taskView: read() }) });
  const result = check(root, `// trpc.missing.notMounted.query({});
    const example = "trpc.missing.notMounted.query({})";
    const element = <div>{trpc["consulting"].taskView.query({})}</div>;`);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.references.map((r) => r.path), ["consulting.taskView"]);
});

test("multiline access and transport method references are checked", () => {
  const root = t.router({ consulting: t.router({ taskView: read() }) });
  const result = check(root, `const query = (trpc.consulting.taskView).query;
    trpc\n      .consulting\n      .taskView\n      .query({});
    const bad = trpc.consulting.missing.query;`);
  assert.deepEqual(result.missing.map((r) => r.path), ["consulting.missing"]);
  assert.equal(result.references.filter((r) => r.path === "consulting.taskView").length, 2);
});

test("dynamic router access fails closed instead of silently reducing coverage", () => {
  const root = t.router({ consulting: t.router({ taskView: read() }) });
  assert.throws(() => check(root, "trpc[section].taskView.query({})"), /TRPC_CONTRACT_DYNAMIC_ACCESS/);
});

test("missing or malformed actual router metadata fails closed", () => {
  for (const router of [null, {}, { _def: { procedures: {} } }]) {
    assert.throws(() => check(router, "const empty = true;"), /TRPC_CONTRACT_ROUTER_METADATA_INVALID/);
  }
});

test("an empty call set is valid but does not invent mounted procedure coverage", () => {
  const result = check(t.router({}), "const empty = true;");
  assert.deepEqual(result.references, []);
  assert.deepEqual(result.mountedPaths, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.files.length, 1);
});

test("all nested ts and tsx sources are scanned, and read failures are visible", () => {
  const f = fixture("trpc.consulting.taskView.query({});");
  try {
    mkdirSync(join(f.sourceRoot, "nested"));
    writeFileSync(join(f.sourceRoot, "nested", "More.ts"), "trpc.consulting.notMounted.mutate({});");
    writeFileSync(join(f.sourceRoot, "ignored.css"), "trpc.fake.fromCss.query({});");
    const root = t.router({ consulting: t.router({ taskView: read() }) });
    const result = auditTrpcContract({ router: root, sourceRoot: f.sourceRoot });
    assert.equal(result.files.length, 2);
    assert.deepEqual(result.missing.map((r) => r.path), ["consulting.notMounted"]);
    assert.throws(() => auditTrpcContract({ router: root, sourceRoot: join(f.sourceRoot, "absent") }), /ENOENT/);
  } finally { f.close(); }
});

test("const namespace alias leaf typos fail instead of passing on namespace existence", () => {
  const root = t.router({ service: t.router({ eval: t.router({ latestReport: read() }) }) });
  const result = check(root, `const svc = trpc.service as unknown as Api;
    svc.eval.latestRepotr.query({});`);
  assert.deepEqual(result.missing.map((r) => r.path), ["service.eval.latestRepotr"]);
});

test("zero-argument getter alias leaf typos fail instead of passing on namespace existence", () => {
  const root = t.router({ accounts: t.router({ auth: t.router({ acceptInvite: write() }) }) });
  const result = check(root, `const svc = () => trpc.accounts.auth as unknown as Api;
    svc().acceptInvtie.mutate({});`);
  assert.deepEqual(result.missing.map((r) => r.path), ["accounts.auth.acceptInvtie"]);
});

test("the client factory used by lib/trpc.ts retains its own call coverage", () => {
  const root = t.router({ access: t.router({ me: read() }) });
  for (const name of ["createTRPCClient", "createTRPCProxyClient"]) {
    const result = check(root, `import { ${name} } from "@trpc/client";
      export const trpc = ${name}<AppRouter>({});
      trpc.access.me.query(); trpc.auth.notMounted.mutate({});`);
    assert.deepEqual(result.references.map((r) => r.path), ["access.me", "auth.notMounted"]);
    assert.deepEqual(result.missing.map((r) => r.path), ["auth.notMounted"]);
  }
});

test("renamed client factory imports and named root imports retain call coverage", () => {
  const root = t.router({ access: t.router({ me: read() }) });
  const result = check(root, `import { createTRPCClient as createClient } from "@trpc/client";
    const localClient = createClient<AppRouter>({});
    localClient.access.me.query(); localClient.access.typo.query();`);
  assert.deepEqual(result.references.map((r) => r.path), ["access.me", "access.typo"]);
  assert.deepEqual(result.missing.map((r) => r.path), ["access.typo"]);
  assert.deepEqual(check(root, `import { trpc as api } from "./lib/trpc";
    api.access.typo.query();`).missing.map((r) => r.path), ["access.typo"]);
});

test("scope-bound aliases do not confuse an unrelated shadowed value with the client", () => {
  const root = t.router({ access: t.router({ me: read() }) });
  const result = check(root, `import { trpc } from "./lib/trpc";
    const api = trpc.access;
    { const api = { typo: { query() {} } }; api.typo.query(); }
    api.typo.query();`);
  assert.deepEqual(result.missing.map((r) => r.path), ["access.typo"]);
  assert.equal(result.references.length, 2);
});

test("mutable aliases and namespace escapes fail closed", () => {
  const root = t.router({ service: t.router({ kb: t.router({ search: read() }) }) });
  for (const body of ["let api = trpc.service; api.kb.search.query({});",
    "let trpc = createTRPCClient<AppRouter>({}); trpc.service.kb.search.query({});"]) {
    assert.throws(() => check(root, body), /TRPC_CONTRACT_(MUTABLE_ALIAS|UNRESOLVED_ESCAPE)/);
  }
  for (const body of ["use(trpc.service);", "function service() { return trpc.service; }",
    "const api = { service: trpc.service };", "const { service } = trpc;"] ) {
    assert.throws(() => check(root, body), /TRPC_CONTRACT_UNRESOLVED_ESCAPE/);
  }
});

test("getter aliases cannot escape analysis through arguments or a copied function", () => {
  const root = t.router({ service: t.router({ kb: t.router({ search: read() }) }) });
  for (const escape of ["use(service);", "const copied = service; copied().kb.typo.query({});"]) {
    assert.throws(() => check(root, `const service = () => trpc.service; ${escape}`), /TRPC_CONTRACT_UNRESOLVED_ESCAPE/);
  }
});

test("exported namespaces and getter aliases cannot hide consumers in another module", () => {
  const root = t.router({ service: t.router({ kb: t.router({ search: read() }) }) });
  for (const body of ["export const service = trpc.service;", "export const service = () => trpc.service;"]) {
    assert.throws(() => check(root, body), /TRPC_CONTRACT_UNRESOLVED_ESCAPE/);
  }
});

test("lazy mounts, malformed source, and symlinked sources cannot silently pass", () => {
  const lazyRoot = t.router({ lazyService: lazy(async () => {
    throw new Error("CONTRACT_SCAN_MUST_NOT_LOAD_LAZY_ROUTERS");
  }) });
  assert.throws(() => check(lazyRoot, "const empty = true;"), /TRPC_CONTRACT_LAZY_ROUTERS_UNRESOLVED/);
  const root = t.router({ service: t.router({ search: read() }) });
  assert.throws(() => check(root, "trpc.service.search.query("), /TRPC_CONTRACT_SOURCE_PARSE_FAILED/);
  const f = fixture("trpc.service.search.query({});");
  try {
    symlinkSync(join(f.sourceRoot, "Calls.tsx"), join(f.sourceRoot, "Linked.tsx"));
    assert.throws(() => auditTrpcContract({ router: root, sourceRoot: f.sourceRoot }), /TRPC_CONTRACT_SOURCE_SYMLINK/);
  } finally { f.close(); }
});
