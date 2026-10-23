import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  CapabilityError, invokeCapability, loadCatalog, mcpTools, sanitizeErrorMessage, validateInput,
} from "./agent-capabilities.mjs";

const root = resolve(import.meta.dirname, "..");
/**
 * 清单口径从本仓事实源推导（基座 ai-pm / 行业仓 geo-growth 等），
 * 避免把"基座只有 8 条"写死——行业仓会把行业清单合并进来（T-2026-1001-0008）。
 */
const productManifest = JSON.parse(readFileSync(resolve(root, "product.manifest.json"), "utf8"));
const bundleId = productManifest.defaultBundle;
const coreCatalog = JSON.parse(readFileSync(resolve(root, "scripts/agent-capabilities.core.json"), "utf8"));
const industryCatalogFile = resolve(root, "bundles", bundleId, "agent-capabilities.json");
const industryItems = existsSync(industryCatalogFile)
  ? JSON.parse(readFileSync(industryCatalogFile, "utf8")).capabilities ?? []
  : [];
const expectedTotal = coreCatalog.capabilities.length + industryItems.length;
const expectedEnabled = [...coreCatalog.capabilities, ...industryItems].filter((item) => item.enabled !== false).length;

async function testServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test("catalog only publishes reviewed common capabilities in the base repo", async () => {
  const catalog = await loadCatalog(root);
  assert.equal(catalog.bundle, bundleId);
  assert.equal(catalog.entries.size, expectedTotal);
  assert.equal(mcpTools(catalog).length, expectedEnabled);
  assert.equal(catalog.entries.get("core.workspace.profile").transport.path, "workspace.profile");
});

test("CLI list accepts options without a positional capability ID", async () => {
  const child = spawn(process.execPath, [
    resolve(root, "scripts/workloom-agent.mjs"), "list", "--root", root,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.capabilities.length, expectedTotal);
});

test("input validation rejects missing and unexpected fields", async () => {
  const catalog = await loadCatalog(root);
  const descriptor = catalog.entries.get("core.threads.get");
  assert.throws(() => validateInput(descriptor, {}), /threadId 缺失/u);
  assert.throws(() => validateInput(descriptor, { threadId: "T-1", tenantId: "other" }), /tenantId 不允许/u);
  assert.deepEqual(validateInput(descriptor, { threadId: "T-1" }), { threadId: "T-1" });
});

test("loopback installed identity requires the process secret and invokes the same tRPC procedure", async () => {
  const requests = [];
  const localTestToken = "test-only-local-token";
  const mock = await testServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, desktopSecret: req.headers["x-workloom-desktop-secret"], origin: req.headers.origin, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/desktop/session") {
      res.end(JSON.stringify({ token: localTestToken, dataMode: "real" }));
    } else if (req.url === "/trpc/workspace.profile") {
      res.end(JSON.stringify({ result: { data: { workspace: "demo" } } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "missing" } }));
    }
  });
  try {
    const catalog = await loadCatalog(root);
    const output = await invokeCapability(catalog, "core.workspace.profile", {}, {
      baseUrl: mock.url, env: { WORKLOOM_DESKTOP_SESSION_SECRET: "a".repeat(64), WORKLOOM_KEYCHAIN_ACCESS: "0" },
    });
    assert.equal(output.status, "succeeded");
    assert.equal(output.dataMode, "unverified");
    assert.deepEqual(output.result, { workspace: "demo" });
    assert.equal(requests[0].method, "POST");
    assert.deepEqual(JSON.parse(requests[0].body), {});
    assert.equal(requests[0].desktopSecret, "a".repeat(64));
    assert.equal(requests[0].origin, undefined);
    assert.equal(requests[1].method, "GET");
    assert.equal(requests[1].auth, `Bearer ${localTestToken}`);
  } finally {
    await mock.close();
  }
});

test("remote HTTP is rejected before any credential use", async () => {
  const catalog = await loadCatalog(root);
  await assert.rejects(
    invokeCapability(catalog, "core.workspace.profile", {}, {
      baseUrl: "http://example.com", env: { WORKLOOM_ACCESS_TOKEN: "test" },
    }),
    (error) => error instanceof CapabilityError && error.code === "INVALID_BASE_URL",
  );
});

test("error messages redact configured bearer and C tokens", () => {
  const token = "test-only-secret-token-12345";
  const output = sanitizeErrorMessage(new Error(`service echoed ${token} and Bearer ${token}`), {
    WORKLOOM_ACCESS_TOKEN: token,
    WORKLOOM_C_TOKEN: "test-only-c-token-67890",
  });
  assert.ok(!output.includes(token));
  assert.match(output, /\[REDACTED\]/u);
});

test("C service requires C token and uses same-origin path", async () => {
  const requests = [];
  const mock = await testServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ticket: { id: "tck-1", status: "created" }, timeline: [] }));
  });
  const catalog = await loadCatalog(root);
  catalog.entries.set("growth.ticket.receipt", {
    id: "growth.ticket.receipt", version: "1.0.0", title: "工单回执",
    description: "读取本人工单", operation: "receipt", risk: "low", dataMode: "simulated",
    inputSchema: {
      type: "object", properties: { id: { type: "string" } },
      required: ["id"], additionalProperties: false,
    },
    transport: { kind: "c-service", path: "/c/tickets/{id}", method: "GET" },
  });
  try {
    await assert.rejects(
      invokeCapability(catalog, "growth.ticket.receipt", { id: "tck-1" }, { baseUrl: mock.url, env: {} }),
      (error) => error.code === "UNAUTHORIZED",
    );
    const output = await invokeCapability(catalog, "growth.ticket.receipt", { id: "tck-1" }, {
      baseUrl: mock.url, env: { WORKLOOM_C_TOKEN: "c-test-token" },
    });
    assert.equal(output.receipt.synced, false);
    assert.equal(output.dataMode, "simulated");
    assert.deepEqual(requests, [{ path: "/c/tickets/tck-1", auth: "Bearer c-test-token" }]);
  } finally {
    await mock.close();
  }
});

test("disabled writes and missing idempotency keys fail before network", async () => {
  const catalog = await loadCatalog(root);
  const descriptor = {
    id: "growth.ticket.execute", operation: "execute", risk: "moderate", dataMode: "simulated",
    inputSchema: { type: "object", properties: {
      idempotencyKey: { type: "string" },
    }, required: ["idempotencyKey"], additionalProperties: false },
    transport: { kind: "c-service", path: "/c/tickets", method: "POST" },
  };
  catalog.entries.set(descriptor.id, { ...descriptor, enabled: false, disabledReason: "隔离修复未发布" });
  await assert.rejects(
    invokeCapability(catalog, descriptor.id, { idempotencyKey: "abcdefgh" }),
    (error) => error.code === "DISABLED",
  );
  catalog.entries.set(descriptor.id, descriptor);
  await assert.rejects(
    invokeCapability(catalog, descriptor.id, {}),
    (error) => error.code === "INVALID_INPUT",
  );
});

test("MCP stdio lists only enabled tools and keeps stdout as JSON-RPC", async () => {
  const child = spawn(process.execPath, [resolve(root, "scripts/workloom-agent-mcp.mjs")], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  child.stdin.end();
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.protocolVersion, "2025-11-25");
  assert.equal(lines[1].result.tools.length, expectedEnabled);
  assert.equal(lines[1].result.tools[0].annotations.readOnlyHint, true);
  assert.match(lines[0].result.instructions, /禁止.*跳步/u);
});

test("missing real credentials never fall back to anonymous demo login", async () => {
  const catalog = await loadCatalog(root);
  let requests = 0;
  await assert.rejects(invokeCapability(catalog, "core.workspace.profile", {}, {
    baseUrl: "http://127.0.0.1:8897", env: { WORKLOOM_KEYCHAIN_ACCESS: "0", WORKLOOM_DEV_AUTO_LOGIN: "1" },
    fetcher: async () => { requests += 1; throw new Error("must not call anonymous login"); },
  }), (error) => error.code === "UNAUTHORIZED");
  assert.equal(requests, 0);
});

test("HTTPS remote endpoints do not receive the local desktop secret or keychain token", async () => {
  const catalog = await loadCatalog(root);
  let requests = 0;
  await assert.rejects(invokeCapability(catalog, "core.workspace.profile", {}, {
    baseUrl: "https://example.invalid", env: { WORKLOOM_DESKTOP_SESSION_SECRET: "a".repeat(64) },
    fetcher: async () => { requests += 1; throw new Error("must not request local identity for a remote host"); },
  }), (error) => error.code === "UNAUTHORIZED");
  assert.equal(requests, 0);
});

test("consulting execution contracts reject client stage overrides, fabricated completion and missing idempotency", async () => {
  const catalog = await loadCatalog(root);
  const descriptor = catalog.entries.get("consulting.workflow.advance");
  assert.equal(descriptor.transport.timeoutMs, 120000);
  assert.throws(() => validateInput(descriptor, { runId: "CR-" + "a".repeat(24) }), /idempotencyKey 缺失/u);
  for (const patch of [{ stepId: "s6" }, { status: "completed" }, { artifact: {} }, { employeeKey: "chief-of-staff" }]) {
    assert.throws(() => validateInput(descriptor, { runId: "CR-" + "a".repeat(24), idempotencyKey: "unit-idempotency", ...patch }), /不允许/u);
    assert.throws(() => validateInput(catalog.entries.get("consulting.workflow.revalidate"), { runId: "CR-" + "a".repeat(24), idempotencyKey: "unit-idempotency", ...patch }), /不允许/u);
  }
});

test("execute success without a synchronized event receipt is rejected", async () => {
  const catalog = await loadCatalog(root);
  await assert.rejects(invokeCapability(catalog, "consulting.workflow.submit", {
    enterpriseId: "unit", goal: "请完成一项真实材料分析任务", idempotencyKey: "unit-completion-claim",
  }, { env: { WORKLOOM_ACCESS_TOKEN: "test-only-member-token" }, fetcher: async () => new Response(JSON.stringify({ result: { data: {
    schemaVersion: "workloom.capability-result/v1", capabilityId: "consulting.workflow.submit", operation: "execute", status: "succeeded", dataMode: "real", result: {},
  } } }), { headers: { "content-type": "application/json" } }) }), (error) => error.code === "REMOTE_INVALID");
});

test("MCP rejects operations before initialization and malformed/unknown tool calls as protocol errors", async () => {
  const child = spawn(process.execPath, [resolve(root, "scripts/workloom-agent-mcp.mjs")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.resume();
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "unit", version: "1" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "missing-tool" } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "workloom_consulting_repo_status", arguments: [] } },
    { jsonrpc: "2.0", id: 6, method: "initialize", params: {} },
  ];
  child.stdin.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  const [exitCode] = await once(child, "exit"); assert.equal(exitCode, 0);
  const outputs = new Map(stdout.trim().split("\n").map((line) => { const msg = JSON.parse(line); return [msg.id, msg]; }));
  assert.equal(outputs.get(1).error.code, -32002); assert.equal(outputs.get(3).error.code, -32002);
  assert.equal(outputs.get(4).error.code, -32602); assert.equal(outputs.get(5).error.code, -32602); assert.equal(outputs.get(6).error.code, -32600);
});

test("MCP measures the original frame bytes before trimming whitespace", async () => {
  const child = spawn(process.execPath, [resolve(root, "scripts/workloom-agent-mcp.mjs")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.resume();
  child.stdin.on("error", (error) => assert.ok(["EPIPE", "ECONNRESET"].includes(error.code), `unexpected stdin failure: ${error.code}`));
  child.stdin.end(" ".repeat(9 * 1024 * 1024 + 1) + "\n");
  const [exitCode] = await once(child, "exit"); assert.equal(exitCode, 2);
  assert.match(stdout, /input frame too large/u);
});
