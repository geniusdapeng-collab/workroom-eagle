/** Generate client-specific launch configuration from the installed runtime, with no credentials in files. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

export function buildAgentClientConfig({ productRoot, nodeExecutable, baseUrl }) {
  const root = resolve(productRoot);
  const node = resolve(nodeExecutable);
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["", "/"].includes(endpoint.pathname)) {
    throw new Error("Installed-agent configuration requires an explicit loopback HTTP endpoint");
  }
  const entry = join(root, "scripts", "workloom-agent-mcp.mjs");
  const env = { WORKLOOM_PRODUCT_ROOT: root, WORKLOOM_BASE_URL: endpoint.origin };
  const q = (value) => JSON.stringify(value);
  const codexToml = `[mcp_servers.eagle]\ncommand = ${q(node)}\nargs = [${q(entry)}]\ncwd = ${q(root)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 130\n\n[mcp_servers.eagle.env]\nWORKLOOM_PRODUCT_ROOT = ${q(root)}\nWORKLOOM_BASE_URL = ${q(endpoint.origin)}\n`;
  const stdioMcp = { mcpServers: { eagle: { command: node, args: [entry], cwd: root, env } } };
  return { codexToml, stdioMcp, guideFile: join(root, "docs", "EAGLE-AGENT-GUIDE.md"),
    instruction: "先读取EAGLE-AGENT-GUIDE.md和consulting.workforce.catalog。授权客户资料走dossier.put→workflow.submit→advance→get→artifact.read；公开研究走task.dispatch（先保存UUID requestId，runImmediately:false）→dispatch_request找回原提交→task.view→task.report。结果未知只读原标识，不换键或换号重购。禁止跳步或自写完成；draft_ready只表示内部草稿等待人类顾问审阅，须核对sha256、UTF-8字节数和真实事件回执；任务控制还须核对actionReceipt。" };
}

export async function writeAgentClientConfig(directory, options) {
  const dir = resolve(directory);
  const config = buildAgentClientConfig(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const codexFile = join(dir, "codex.toml");
  const mcpFile = join(dir, "mcp.json");
  const instructionsFile = join(dir, "AGENT-INSTRUCTIONS.md");
  await writeFile(codexFile, config.codexToml, { encoding: "utf8", mode: 0o600 });
  await writeFile(mcpFile, JSON.stringify(config.stdioMcp, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(instructionsFile, `${config.instruction}\n\n完整引导：${config.guideFile}\n`, { encoding: "utf8", mode: 0o600 });
  return { codexFile, mcpFile, instructionsFile, guideFile: config.guideFile };
}
