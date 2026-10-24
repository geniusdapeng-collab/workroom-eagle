import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentClientConfig, writeAgentClientConfig } from "./agent-client-config.mjs";

test("installed configuration uses the exact runtime paths and loopback instance without credentials", () => {
  const root = resolve("unit-runtime-with-空格");
  const config = buildAgentClientConfig({ productRoot: root, nodeExecutable: process.execPath, baseUrl: "http://127.0.0.1:18997" });
  const server = config.stdioMcp.mcpServers.eagle;
  assert.equal(server.command, process.execPath); assert.equal(server.cwd, root);
  assert.equal(server.args[0], join(root, "scripts/workloom-agent-mcp.mjs"));
  assert.deepEqual(server.env, { WORKLOOM_PRODUCT_ROOT: root, WORKLOOM_BASE_URL: "http://127.0.0.1:18997" });
  assert.match(config.codexToml, /tool_timeout_sec = 130/u);
  assert.doesNotMatch(JSON.stringify(config), /ACCESS_TOKEN|SESSION_SECRET|API_KEY/u);
  assert.match(config.instruction, /task\.dispatch.*UUID requestId/u);
  assert.match(config.instruction, /dispatch_request.*task\.view.*task\.report/u);
  assert.match(config.instruction, /不换键或换号重购/u);
});

test("installed configuration refuses remote, credential-bearing and ambiguous endpoints", () => {
  for (const baseUrl of ["https://example.invalid", "http://127.0.0.1.example.invalid:8897", "http://user:pass@localhost:8897", "http://localhost:8897/path", "http://localhost:8897/?token=fixture", "http://localhost:8897/#fixture"]) {
    assert.throws(() => buildAgentClientConfig({ productRoot: ".", nodeExecutable: process.execPath, baseUrl }), /loopback HTTP endpoint/u);
  }
});

test("configuration files are generated from installed paths with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-agent-config-unit-"));
  try {
    const files = await writeAgentClientConfig(directory, { productRoot: directory, nodeExecutable: process.execPath, baseUrl: "http://localhost:18897" });
    const actual = JSON.parse(await readFile(files.mcpFile, "utf8"));
    assert.equal(actual.mcpServers.eagle.env.WORKLOOM_BASE_URL, "http://localhost:18897");
    for (const path of [files.codexFile, files.mcpFile, files.instructionsFile]) assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(files.instructionsFile, "utf8"), /draft_ready/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
