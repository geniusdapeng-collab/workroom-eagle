#!/usr/bin/env node
/** Reviewed capabilities over MCP stdio; stdout contains JSON-RPC only. */
import { resolve } from "node:path";
import { CapabilityError, invokeCapability, loadCatalog, mcpTools, sanitizeErrorMessage, toolName } from "./agent-capabilities.mjs";
const MAX_FRAME_BYTES = 9 * 1024 * 1024;
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const catalog = await loadCatalog(resolve(process.env.WORKLOOM_PRODUCT_ROOT ?? resolve(import.meta.dirname, "..")));
const tools = mcpTools(catalog);
const byName = new Map([...catalog.entries.values()].filter((item) => item.enabled !== false).map((item) => [toolName(item), item]));
let initialized = false;
let ready = false;
const activeIds = new Set();
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function protocolError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
function toolError(error) {
  const code = error instanceof CapabilityError ? error.code : "INTERNAL_ERROR";
  const message = sanitizeErrorMessage(error);
  const structuredContent = { error: { code, message } };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}
async function handle(request) {
  if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    protocolError(null, -32600, "invalid request"); return;
  }
  const { id, method, params } = request;
  if (id === undefined) {
    if (method === "notifications/initialized" && initialized) ready = true;
    return;
  }
  if (!((typeof id === "string" && id.length > 0) || Number.isInteger(id))) {
    protocolError(null, -32600, "request ID must be a string or integer"); return;
  }
  if (activeIds.has(id)) { protocolError(id, -32600, "duplicate active request ID"); return; }
  activeIds.add(id);
  try {
    if (method === "initialize") {
      if (initialized) { protocolError(id, -32600, "connection is already initialized"); return; }
      if (!object(params) || typeof params.protocolVersion !== "string" || !object(params.capabilities)
        || !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") {
        protocolError(id, -32602, "initialize requires protocolVersion, capabilities and clientInfo"); return;
      }
      initialized = true;
      reply(id, { protocolVersion: SUPPORTED_VERSIONS.has(params.protocolVersion) ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "eagle-consulting", version: "1.2.0" },
        instructions: "先读咨询catalog与docs/EAGLE-AGENT-GUIDE.md。正式成员会话必需。授权客户资料先建档再submit；复杂任务由服务端真实模型拆解，advance仅推进下一个有前序回执的步骤。公开研究使用task.dispatch，先保存UUID requestId并默认runImmediately:false；运输中断后只读dispatch_request找回原提交，再读task.view/task.report，不换号重复付费。任务控制只认actionReceipt。禁止代写产物、跳步、把draft_ready当人类定调或外发成功；最终须回读报告/artifact散列、UTF-8字节数与真实事件回执。" });
      return;
    }
    if (method === "ping") { reply(id, {}); return; }
    if (!ready) { protocolError(id, -32002, "initialize and notifications/initialized are required before operations"); return; }
    if (method === "tools/list") { reply(id, { tools }); return; }
    if (method === "tools/call") {
      if (!object(params) || typeof params.name !== "string" || (params.arguments !== undefined && !object(params.arguments))) {
        protocolError(id, -32602, "tools/call requires a tool name and object arguments"); return;
      }
      const descriptor = byName.get(params.name);
      if (!descriptor) { protocolError(id, -32602, "unknown tool"); return; }
      try {
        const output = await invokeCapability(catalog, descriptor.id, params.arguments ?? {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output, isError: output.status === "failed" });
      } catch (error) { reply(id, toolError(error)); }
      return;
    }
    protocolError(id, -32601, "method not found");
  } finally { activeIds.delete(id); }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { protocolError(null, -32600, "input frame too large"); process.exitCode = 2; continue; }
    const line = frame.trim();
    if (!line) continue;
    try {
      const request = JSON.parse(line);
      void handle(request).catch((error) => protocolError(request?.id ?? null, -32000, sanitizeErrorMessage(error)));
    } catch { protocolError(null, -32700, "parse error"); }
  }
  if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
    protocolError(null, -32600, "input frame too large"); process.exitCode = 2; process.stdin.destroy();
  }
});
process.stdin.on("end", () => { if (buffer.trim()) protocolError(null, -32700, "incomplete JSON-RPC frame"); });
process.stderr.write("鹰眼 Agent MCP 已启动（stdio；正式身份与服务端流程约束）\n");
