import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { invokeCapability, loadCatalog, mcpTools, validateInput } from "./agent-capabilities.mjs";

const root = resolve(import.meta.dirname, "..");
const memberToken = "fixture-only-member-token-not-a-real-credential";
const receipt = { eventId: "fixture-event-task-control", hash: "a".repeat(64), synced: true, serverField: "preserve-original" };
const threadId = "T-FIXTURE-42";
const routes = new Map([
  ["consulting.task.dispatch", ["threads.dispatch", "mutation"]],
  ["consulting.task.dispatch_request", ["threads.dispatchRequest", "query"]],
  ["consulting.task.view", ["consulting.taskView", "query"]],
  ["consulting.task.report", ["consulting.taskReport", "query"]],
  ["consulting.task.action", ["consulting.taskAction", "mutation"]],
]);
const inputFor = (id, requestId = randomUUID()) => id === "consulting.task.dispatch" ? { requestId, title: "做一个温州地区制造业的分析报告", runImmediately: false }
  : id === "consulting.task.dispatch_request" ? { requestId }
    : id === "consulting.task.action" ? { threadId, action: "handoff", idempotencyKey: "fixture-task-action-0001", reason: "保留资料，交人审阅" }
      : { threadId };
const payloadFor = (path, input) => path === "threads.dispatch" ? { kind: "routed", mode: "quest", via: "llm", threadId, requestId: input.requestId, status: "queued", executionSource: "generic" }
  : path === "threads.dispatchRequest" ? { kind: "routed", mode: "quest", via: "llm", threadId, requestId: input.requestId, status: "queued" }
    : path === "consulting.taskReport" ? { threadId, runId: "CR-" + "f".repeat(24), content: "# 内部报告待审稿\n\n实际服务端回读的夹具文本。\n", sha256: "b".repeat(64), bytes: 75, receipt, humanReviewRequired: true }
      : path === "consulting.taskAction" ? { threadId, status: "human_required", lastReceipt: { ...receipt, eventId: "fixture-last-state" }, actionReceipt: receipt, humanReviewRequired: true }
        : { threadId, status: "working", stepsDone: 2, lastReceipt: receipt, humanReviewRequired: true };
const response = (data) => new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
const authOptions = (fetcher) => ({ env: { WORKLOOM_ACCESS_TOKEN: memberToken, WORKLOOM_KEYCHAIN_ACCESS: "0" }, fetcher });

async function serverFixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname.replace(/^\/trpc\//u, "");
    const input = req.method === "GET" ? JSON.parse(url.searchParams.get("input") ?? "{}") : JSON.parse(body || "{}");
    requests.push({ path, input, method: req.method, auth: req.headers.authorization });
    if (handler && await handler({ req, res, path, input, requests }) === true) return;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: { data: payloadFor(path, input) } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function subprocessEnvironment(baseUrl) {
  return { PATH: process.env.PATH, HOME: homedir(), LANG: "en_US.UTF-8", WORKLOOM_PRODUCT_ROOT: root,
    WORKLOOM_BASE_URL: baseUrl, WORKLOOM_ACCESS_TOKEN: memberToken, WORKLOOM_KEYCHAIN_ACCESS: "0", WORKLOOM_DEV_AUTO_LOGIN: "0" };
}
async function cli(id, input, baseUrl) {
  const child = spawn(process.execPath, [join(root, "scripts/workloom-agent.mjs"), "invoke", id, "--input-file", "-"], { cwd: root, env: subprocessEnvironment(baseUrl), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
  const ended = once(child, "exit"); child.stdin.end(JSON.stringify(input));
  const [exitCode] = await ended;
  return { exitCode, stdout, stderr, output: stdout.trim() ? JSON.parse(stdout) : null };
}
async function mcp(t, baseUrl) {
  const child = spawn(process.execPath, [join(root, "scripts/workloom-agent-mcp.mjs")], { cwd: root, env: subprocessEnvironment(baseUrl), stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); let nextId = 0, buffer = ""; const lifecycle = [];
  child.stderr.resume(); child.stdout.setEncoding("utf8"); child.stdin.on("error", () => undefined);
  child.stdout.on("data", (data) => {
    buffer += data; let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const wait = pending.get(frame.id); if (wait) { clearTimeout(wait.timer); pending.delete(frame.id); wait.done(frame); }
    }
  });
  function request(method, params) {
    lifecycle.push(method);
    return new Promise((done, reject) => {
      const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(Error("MCP fixture timeout")); }, 5000);
      pending.set(id, { done, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  t.after(async () => { const ended = once(child, "exit"); child.stdin.end(); await ended; for (const item of pending.values()) clearTimeout(item.timer); });
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "task-capability-fixture", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); lifecycle.push("notifications/initialized");
  const listed = await request("tools/list", {});
  return { initialized, listed, lifecycle, call: (id, input) => request("tools/call", { name: "workloom_" + id.replace(/[^A-Za-z0-9]/gu, "_"), arguments: input }) };
}

test("public task catalog exposes exactly the reviewed routes and correct MCP operation annotations", async () => {
  const catalog = await loadCatalog(root);
  for (const [id, [path, method]] of routes) {
    const descriptor = catalog.entries.get(id); assert.ok(descriptor, id);
    assert.deepEqual([descriptor.transport.kind, descriptor.transport.path, descriptor.transport.method], ["trpc", path, method]);
    const tool = mcpTools(catalog).find((tool) => tool.name === "workloom_" + id.replaceAll(".", "_"));
    assert.ok(tool, id); assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.readOnlyHint, !["consulting.task.dispatch", "consulting.task.action"].includes(id));
  }
  assert.equal(catalog.entries.get("consulting.task.dispatch").idempotencyField, "requestId");
  assert.equal(catalog.entries.get("consulting.task.view").receiptField, "lastReceipt");
  assert.equal(catalog.entries.get("consulting.task.action").receiptField, "actionReceipt");
});

test("dispatch UUID, default queued mode and undeclared stage/completion fields are checked before networking", async () => {
  const catalog = await loadCatalog(root); const descriptor = catalog.entries.get("consulting.task.dispatch"); assert.ok(descriptor);
  assert.equal(descriptor.inputSchema.properties.runImmediately.default, false);
  let calls = 0;
  for (const patch of [{ requestId: undefined }, { requestId: "not-a-uuid" }, { requestId: "00000000-0000-0000-0000-000000000000" }, { stage: "completed" }, { completed: true }, { tenantId: "other" }, { artifact: {} }]) {
    const input = { ...inputFor(descriptor.id), ...patch }; if (input.requestId === undefined) delete input.requestId;
    await assert.rejects(invokeCapability(catalog, descriptor.id, input, authOptions(async () => { calls++; throw Error("must not reach network"); })), (error) => error.code === "INVALID_INPUT");
  }
  assert.equal(calls, 0);
  const input = { requestId: randomUUID(), title: "公开研究报告", goalRef: null, presetKey: null };
  assert.deepEqual(validateInput(descriptor, input), input);
  for (const action of ["skip", "complete", "publish"]) assert.throws(() => validateInput(catalog.entries.get("consulting.task.action"), { ...inputFor("consulting.task.action"), action }), /不在允许值/u);
});

test("top-level and nested prototype-property names cannot bypass additionalProperties false", async () => {
  const catalog = await loadCatalog(root); let calls = 0;
  const options = authOptions(async () => { calls++; return response({ kind: "routed", mode: "quest", threadId, status: "queued" }); });
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const top = JSON.parse(JSON.stringify(inputFor("consulting.task.dispatch")).slice(0, -1) + `,${JSON.stringify(key)}:{"status":"completed"}}`);
    await assert.rejects(invokeCapability(catalog, "consulting.task.dispatch", top, options), (error) => error.code === "INVALID_INPUT", key);
    const nestedSource = JSON.parse(`{"id":"fixture","title":"Fixture source","content":"Explicitly authorized fixture-only material",${JSON.stringify(key)}:{"status":"completed"}}`);
    await assert.rejects(invokeCapability(catalog, "consulting.dossier.put", { enterpriseId: "fixture", sources: [nestedSource], idempotencyKey: "fixture-nested-prototype" }, options), (error) => error.code === "INVALID_INPUT", `nested ${key}`);
  }
  assert.equal(calls, 0);
  assert.equal(Object.prototype.status, undefined);
});

test("actual HTTP dispatch keeps the original UUID/title/body and member identity without claiming a synchronized report", async (t) => {
  const fixture = await serverFixture(t); const catalog = await loadCatalog(root); const input = inputFor("consulting.task.dispatch");
  const output = await invokeCapability(catalog, "consulting.task.dispatch", input, { baseUrl: fixture.baseUrl, env: { WORKLOOM_ACCESS_TOKEN: memberToken, WORKLOOM_KEYCHAIN_ACCESS: "0" } });
  assert.equal(output.status, "pending"); assert.equal(output.receipt.synced, false); assert.equal(output.receipt.eventId, undefined);
  assert.equal(output.result.threadId, threadId); assert.equal(output.result.status, "queued");
  assert.deepEqual(fixture.requests, [{ path: "threads.dispatch", input, method: "POST", auth: `Bearer ${memberToken}` }]);
});

test("lost HTTP dispatch response recovers only the same original request without repeating classification or execution", async (t) => {
  let original = null, dispatchCount = 0;
  const fixture = await serverFixture(t, async ({ req, res, path, input }) => {
    if (path === "threads.dispatch") { dispatchCount++; original = payloadFor(path, input); req.socket.destroy(); return true; }
    if (path === "threads.dispatchRequest") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: { data: original } })); return true; }
    return false;
  });
  const catalog = await loadCatalog(root); const input = inputFor("consulting.task.dispatch"); const options = { baseUrl: fixture.baseUrl, env: { WORKLOOM_ACCESS_TOKEN: memberToken, WORKLOOM_KEYCHAIN_ACCESS: "0" } };
  await assert.rejects(invokeCapability(catalog, "consulting.task.dispatch", input, options), (error) => error.code === "NETWORK_ERROR");
  const recovered = await invokeCapability(catalog, "consulting.task.dispatch_request", { requestId: input.requestId }, options);
  assert.equal(recovered.result.threadId, threadId); assert.equal(recovered.result.requestId, input.requestId); assert.equal(dispatchCount, 1);
  assert.deepEqual(fixture.requests.map((r) => [r.path, r.method]), [["threads.dispatch", "POST"], ["threads.dispatchRequest", "GET"]]);
});

test("declared view/report/action receipts preserve original event, hash, content and business status", async () => {
  const catalog = await loadCatalog(root);
  for (const id of ["consulting.task.view", "consulting.task.report", "consulting.task.action"]) {
    const descriptor = catalog.entries.get(id); assert.ok(descriptor);
    const raw = payloadFor(descriptor.transport.path, inputFor(id));
    const output = await invokeCapability(catalog, id, inputFor(id), authOptions(async () => response(raw)));
    assert.equal(output.status, "succeeded"); assert.deepEqual(output.result, raw); assert.deepEqual(output.receipt, { ...receipt, sourceVerified: false });
    if (id.endsWith("report")) { assert.equal(output.result.content, raw.content); assert.equal(output.result.sha256, raw.sha256); assert.equal(output.result.bytes, raw.bytes); }
    if (id.endsWith("action")) { assert.equal(output.result.status, "human_required"); assert.equal(output.receipt.eventId, raw.actionReceipt.eventId); assert.notEqual(output.receipt.eventId, raw.lastReceipt.eventId); }
  }
});

test("missing or malformed declared receipt fails without guessing another output field", async () => {
  const catalog = await loadCatalog(root);
  for (const id of ["consulting.task.view", "consulting.task.report", "consulting.task.action"]) {
    const descriptor = catalog.entries.get(id); assert.ok(descriptor);
    for (const bad of [undefined, null, [], "receipt", { synced: true }, { synced: true, eventId: "" }, { synced: true, eventId: "   " }, { synced: false, eventId: "fake" }]) {
      const raw = payloadFor(descriptor.transport.path, inputFor(id)); raw[descriptor.receiptField] = bad;
      if (descriptor.receiptField !== "receipt") raw.receipt = receipt;
      await assert.rejects(invokeCapability(catalog, id, inputFor(id), authOptions(async () => response(raw))), (error) => error.code === "REMOTE_INVALID", `${id}/${JSON.stringify(bad)}`);
    }
  }
});

test("legacy raw execute output needs both synced and nonempty eventId before success", async () => {
  const catalog = await loadCatalog(root); const input = { enterpriseId: "fixture", sources: [{ id: "s", title: "t", content: "fixture-only" }], idempotencyKey: "fixture-raw-receipt" };
  for (const rawReceipt of [{ synced: true }, { synced: true, eventId: "" }, { synced: true, eventId: "  " }, { synced: false, eventId: "event" }]) {
    const output = await invokeCapability(catalog, "consulting.dossier.put", input, authOptions(async () => response({ receipt: rawReceipt })));
    assert.equal(output.status, "pending"); assert.equal(output.receipt.synced, false);
  }
  const output = await invokeCapability(catalog, "consulting.dossier.put", input, authOptions(async () => response({ receipt })));
  assert.equal(output.status, "succeeded"); assert.equal(output.receipt.hash, receipt.hash);
});

test("untrusted full success envelopes also reject whitespace-only synchronized event IDs", async () => {
  const catalog = await loadCatalog(root);
  await assert.rejects(invokeCapability(catalog, "consulting.workflow.submit", { enterpriseId: "fixture", goal: "请形成真实材料分析内部草稿", idempotencyKey: "fixture-bad-full-receipt" }, authOptions(async () => response({ schemaVersion: "workloom.capability-result/v1", capabilityId: "consulting.workflow.submit", operation: "execute", status: "succeeded", dataMode: "real", result: {}, receipt: { synced: true, eventId: "   " } }))), (error) => error.code === "REMOTE_INVALID");
});

test("descriptor metadata is one explicit required top-level string field, never automatic discovery", async (t) => {
  const original = JSON.parse(await readFile(join(root, "bundles/consulting/agent-capabilities.json"), "utf8"));
  const descriptor = original.capabilities.find((c) => c.id === "consulting.task.dispatch"); assert.ok(descriptor);
  const directory = await mkdtemp(join(tmpdir(), "eagle-catalog-metadata-fixture-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "bundles/consulting"), { recursive: true });
  await writeFile(join(directory, "product.manifest.json"), JSON.stringify({ productId: "fixture-only", defaultBundle: "consulting" }));
  for (const mutate of [
    (d) => { d.idempotencyField = "request.id"; }, (d) => { d.idempotencyField = ["requestId"]; }, (d) => { d.idempotencyField = "constructor"; },
    (d) => { d.idempotencyField = "missing"; }, (d) => { d.inputSchema.required = ["title"]; },
    (d) => { d.inputSchema.properties.requestId.type = ["string", "null"]; }, (d) => { d.inputSchema.properties.requestId.minLength = 1; },
    (d) => { d.receiptField = "result.receipt"; }, (d) => { d.receiptField = ""; }, (d) => { d.receiptField = "constructor"; },
    (d) => { d.operation = "read"; }, (d) => { d.receiptField = "receipt"; d.dataMode = "unverified"; },
  ]) {
    const changed = copy(descriptor); mutate(changed);
    await writeFile(join(directory, "bundles/consulting/agent-capabilities.json"), JSON.stringify({ ...original, capabilities: [changed] }));
    await assert.rejects(loadCatalog(directory), (error) => error.code === "CATALOG_INVALID");
  }
});

test("HTTP 401/403/409 preserve useful CLI exit codes and redact echoed authorization", async (t) => {
  let status = 401;
  const fixture = await serverFixture(t, async ({ res }) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: { message: `fixture rejected Bearer ${memberToken}`, data: { httpStatus: status, code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "CONFLICT" } } })); return true; });
  for (const [httpStatus, exitCode] of [[401, 3], [403, 4], [409, 5]]) {
    status = httpStatus; const result = await cli("consulting.task.action", inputFor("consulting.task.action"), fixture.baseUrl);
    assert.equal(result.exitCode, exitCode); assert.equal(result.output, null); assert.ok(!result.stderr.includes(memberToken)); assert.match(result.stderr, /REDACTED/u);
  }
});

test("real CLI uses the new dispatch and receipt tools against a local fixture without a fabricated completion", async (t) => {
  const fixture = await serverFixture(t); const requestId = randomUUID();
  for (const id of routes.keys()) {
    const result = await cli(id, inputFor(id, requestId), fixture.baseUrl);
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.output.capabilityId, id);
    assert.equal(result.output.status, id.endsWith(".dispatch") ? "pending" : "succeeded");
  }
  assert.equal(fixture.requests.length, 5); assert.ok(fixture.requests.every((r) => r.auth === `Bearer ${memberToken}`));
});

test("real MCP initialize/list/call executes every new tool with the same exact request and receipt contract", async (t) => {
  const fixture = await serverFixture(t); const client = await mcp(t, fixture.baseUrl); const requestId = randomUUID();
  assert.equal(client.initialized.result.protocolVersion, "2025-11-25");
  for (const id of routes.keys()) {
    assert.ok(client.listed.result.tools.some((tool) => tool.name === "workloom_" + id.replaceAll(".", "_")));
    const input = inputFor(id, requestId); const frame = await client.call(id, input);
    assert.equal(frame.error, undefined); assert.equal(frame.result.isError, false); assert.equal(frame.result.structuredContent.capabilityId, id);
    assert.equal(frame.result.structuredContent.status, id.endsWith(".dispatch") ? "pending" : "succeeded");
    assert.deepEqual(fixture.requests.at(-1).input, input);
  }
  assert.deepEqual(client.lifecycle.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"]);
});

test("MCP marks actual backend failed envelopes as errors without converting blocked tasks into success", async (t) => {
  const fixture = await serverFixture(t, async ({ res, path }) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: { data: { schemaVersion: "workloom.capability-result/v1", capabilityId: path === "threads.dispatch" ? "consulting.task.dispatch" : "consulting.task.action", operation: "execute", status: "failed", dataMode: "real", result: { status: "blocked", error: { code: "BUDGET_FROZEN" } } } } })); return true; });
  const client = await mcp(t, fixture.baseUrl);
  for (const id of ["consulting.task.dispatch", "consulting.task.action"]) {
    const frame = await client.call(id, inputFor(id));
    assert.equal(frame.result.isError, true); assert.equal(frame.result.structuredContent.status, "failed"); assert.equal(frame.result.structuredContent.result.error.code, "BUDGET_FROZEN");
  }
});

function copy(value) { return structuredClone(value); }
