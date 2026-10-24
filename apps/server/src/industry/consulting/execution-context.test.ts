import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { DeepSeekClient } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { getConsultingExecutionContext } from "./execution-context.js";

const scope = { tenantId: "tenant-cache", workspaceId: "workspace-cache" };
const answer = { text: "An original reviewed draft", requestId: "request-original", reservationId: "reservation-original" };
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "eagle-provider-cache-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
function context(overrides: Partial<Parameters<typeof getConsultingExecutionContext>[0]> = {}) {
  const complete = vi.fn(async () => answer);
  const search = vi.fn(async () => ({ results: [], reservationId: "search-original" }));
  const fetchPage = vi.fn(async () => ({ content: "Public original source", reservationId: "fetch-original" }));
  const provider = { complete, search, fetchPage, verifyModel: vi.fn(), getBudget: vi.fn() };
  return { ...getConsultingExecutionContext({ scope, requestId: "dispatch-stable", supportDir: directory,
    clientFactory: () => provider as unknown as DeepSeekClient, ...overrides }), provider };
}
function recordPath(path: string) { return join(path, readdirSync(path).find(name => name.endsWith(".json"))!); }

describe("durable provider operation journal", () => {
  it("requires durable validated scope and task identity before creating a provider", () => {
    const factory = vi.fn();
    expect(() => context({ requestId: undefined, clientFactory: factory })).toThrow(/TASK_CONTEXT_REQUIRED/);
    expect(() => context({ requestId: "../escape", clientFactory: factory })).toThrow(/TASK_CONTEXT_INVALID/);
    expect(() => context({ scope: { ...scope, workspaceId: "" }, clientFactory: factory })).toThrow(/TASK_SCOPE_INVALID/);
    expect(factory).not.toHaveBeenCalled();
  });
  it("reuses the same normalized operation after reassembly and binds request before thread", async () => {
    const first = context();
    expect(await first.client.complete({ prompt: "Private prompt, not stored twice" })).toEqual(answer);
    const second = context({ threadId: "T-created-later" });
    expect(second.taskIdentity).toBe(first.taskIdentity);
    expect(second.budgetFile).toBe(first.budgetFile);
    expect(await second.client.complete({ prompt: "Private prompt, not stored twice", system: "", maxTokens: 2048, jsonMode: false })).toEqual(answer);
    expect(first.provider.complete).toHaveBeenCalledTimes(1);
    expect(second.provider.complete).not.toHaveBeenCalled();
    expect(readFileSync(recordPath(first.cacheDirectory), "utf8")).not.toContain("Private prompt");
  });
  it("survives an actual process restart and returns the first provider receipt", () => {
    const script = `import {getConsultingExecutionContext} from ${JSON.stringify(fileURLToPath(new URL("./execution-context.ts", import.meta.url)))};
      const ctx=getConsultingExecutionContext({scope:${JSON.stringify(scope)},requestId:'restart-stable',supportDir:${JSON.stringify(directory)},
        clientFactory:()=>({complete:async()=>({text:'first-process-'+process.pid,requestId:'provider-'+process.pid})})});
      console.log(JSON.stringify(await ctx.client.complete({prompt:'restart-original-input'})));`;
    const run = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8" });
    const first = run(); const second = run();
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
  });
  it("isolates scopes, requests and exact inputs without provider retries", async () => {
    const first = context();
    await first.client.complete({ prompt: "first" });
    await first.client.complete({ prompt: "different" });
    const other = context({ scope: { ...scope, workspaceId: "workspace-other" } });
    await other.client.complete({ prompt: "first" });
    expect(other.cacheDirectory).not.toBe(first.cacheDirectory);
    expect(first.provider.complete).toHaveBeenCalledTimes(2);
    expect(other.provider.complete).toHaveBeenCalledTimes(1);
  });
  it("concurrent exact operations reserve the journal before provider I/O", async () => {
    let release!: (value: typeof answer) => void;
    const complete = vi.fn(() => new Promise<typeof answer>(resolve => { release = resolve; }));
    const first = context({ clientFactory: () => ({ complete }) as unknown as DeepSeekClient });
    const pending = first.client.complete({ prompt: "one flight" });
    await expect(context().client.complete({ prompt: "one flight" })).rejects.toThrow(/PROVIDER_OPERATION_(UNCERTAIN|IN_PROGRESS)/);
    release(answer); await pending;
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("caches source search and fetch responses with their original reservations", async () => {
    const first = context();
    await first.client.search({ query: "Public official source" });
    await first.client.fetchPage({ url: "https://example.gov.cn/source" });
    const second = context();
    await expect(second.client.search({ query: "Public official source", count: 5 })).resolves.toMatchObject({ reservationId: "search-original" });
    await expect(second.client.fetchPage({ url: "https://example.gov.cn/source" })).resolves.toMatchObject({ reservationId: "fetch-original" });
    expect(second.provider.search).not.toHaveBeenCalled();
    expect(second.provider.fetchPage).not.toHaveBeenCalled();
  });
  it("retains unknown failures across restart and never stores secret exception details", async () => {
    const complete = vi.fn(async () => { throw new Error("secret-provider-diagnostics"); });
    const first = context({ clientFactory: () => ({ complete }) as unknown as DeepSeekClient });
    await expect(first.client.complete({ prompt: "unknown" })).rejects.toThrow("secret-provider-diagnostics");
    const second = context();
    await expect(second.client.complete({ prompt: "unknown" })).rejects.toThrow(/PROVIDER_OPERATION_UNCERTAIN/);
    expect(second.provider.complete).not.toHaveBeenCalled();
    expect(readFileSync(recordPath(first.cacheDirectory), "utf8")).not.toContain("secret-provider-diagnostics");
  });
  it("rejects a credential-bearing injected result before caching and keeps its fate non-repurchasable", async () => {
    const secret = `sk-${"fixture-not-a-real-credential-".repeat(2)}`;
    const complete = vi.fn(async () => ({ ...answer, text: secret }));
    const first = context({ clientFactory: () => ({ complete }) as unknown as DeepSeekClient });
    await expect(first.client.complete({ prompt: "untrusted response" })).rejects.toThrow(/SECRET_IN_OUTPUT/);
    expect(readFileSync(recordPath(first.cacheDirectory), "utf8")).not.toContain(secret);
    await expect(context().client.complete({ prompt: "untrusted response" })).rejects.toThrow(/PROVIDER_OPERATION_UNCERTAIN/);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("tampered, truncated, overly permissive and symbolic-link records fail closed", async () => {
    const first = context(); await first.client.complete({ prompt: "integrity" });
    const file = recordPath(first.cacheDirectory); const original = readFileSync(file, "utf8");
    for (const value of ["{truncated", JSON.stringify({ ...JSON.parse(original), result: { ...answer, text: "tampered" } })]) {
      writeFileSync(file, value);
      await expect(context().client.complete({ prompt: "integrity" })).rejects.toThrow(/OPERATION_CACHE_INVALID/);
    }
    writeFileSync(file, original); chmodSync(file, 0o644);
    await expect(context().client.complete({ prompt: "integrity" })).rejects.toThrow(/OPERATION_CACHE_UNSAFE/);
    rmSync(file); const external = join(directory, "external.json"); writeFileSync(external, original, { mode: 0o600 }); symlinkSync(external, file);
    await expect(context().client.complete({ prompt: "integrity" })).rejects.toThrow(/OPERATION_CACHE_INVALID/);
    expect(first.provider.complete).toHaveBeenCalledTimes(1);
  });
  it("does not follow a symbolic-link consulting directory outside the configured support root", () => {
    const external = join(directory, "outside"); mkdirSync(external);
    const support = join(directory, "support"); mkdirSync(support); symlinkSync(external, join(support, "consulting"));
    expect(() => context({ supportDir: support })).toThrow(/OPERATION_CACHE_UNSAFE/);
    expect(readdirSync(external)).toEqual([]);
  });
  it("rejects aborted and oversized operations without an automatic second purchase", async () => {
    const first = context(); const controller = new AbortController(); controller.abort();
    await expect(first.client.complete({ prompt: "aborted", signal: controller.signal })).rejects.toThrow(/CANCELLED/);
    expect(first.provider.complete).not.toHaveBeenCalled();
    const complete = vi.fn(async () => ({ ...answer, text: "x".repeat(3 * 1024 * 1024) }));
    const huge = context({ clientFactory: () => ({ complete }) as unknown as DeepSeekClient });
    await expect(huge.client.complete({ prompt: "huge" })).rejects.toThrow(/OPERATION_CACHE_TOO_LARGE/);
    await expect(context().client.complete({ prompt: "huge" })).rejects.toThrow(/PROVIDER_OPERATION_UNCERTAIN/);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
