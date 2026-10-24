import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import type { gatewayAppend } from "@workloom/base/workdata";
import { createConsultingUiLlmCall } from "./llm.js";

const scope = { tenantId: "tenant-budget", workspaceId: "workspace-budget" };
const metadata = { data: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", context_window: 1048576,
  max_output_tokens: 393216, input_modalities: ["text"] }] };
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const envNames = ["WORKLOOM_SUPPORT_DIR", "WORKLOOM_CONSULTING_BUDGET_FILE", "LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "DEEPSEEK_API_KEY", "LLM_API_KEY"];
let saved: Record<string, string | undefined>;
let dir: string;
let inferenceCalls: number;
let append: ReturnType<typeof vi.fn<typeof gatewayAppend>>;
let originalFetch: typeof fetch;

beforeEach(() => {
  saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  dir = mkdtempSync(join(tmpdir(), "eagle-ui-budget-"));
  Object.assign(process.env, { WORKLOOM_SUPPORT_DIR: dir, LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-flash",
    LLM_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "unit-test-provider-key" });
  delete process.env.WORKLOOM_CONSULTING_BUDGET_FILE;
  delete process.env.LLM_API_KEY;
  inferenceCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/models")) return response(metadata);
    inferenceCalls++;
    return response({ id: `provider-${inferenceCalls}`, model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "来源有记录，输出仍须人类复核。" } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  }) as typeof fetch;
  append = vi.fn<typeof gatewayAppend>(async () => ({ eventId: "E-1", seq: 1n, hash: "a".repeat(64), deduped: false, piiHits: 0 }));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
  rmSync(dir, { recursive: true, force: true });
});

function call(scene: string, threadId = "T-budget", requestId = "request-budget") {
  // Older implementation ignores taskContext; this same test proves that defect
  // before the field and durable execution context are introduced.
  return createConsultingUiLlmCall({ gateway: {} as pg.Pool, scope, scene,
    taskContext: { threadId, requestId }, append } as Parameters<typeof createConsultingUiLlmCall>[0]);
}
function ledgers() {
  return readdirSync(join(dir, "consulting", "budgets")).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, "consulting", "budgets", name), "utf8")));
}

describe("a durable UI task owns one bounded provider execution context", () => {
  it("classification and planning share the same task budget, across newly assembled call closures", async () => {
    await call("intent-classify")("判断任务类型");
    await call("quest-plan")("按授权目标规划");
    expect(inferenceCalls).toBe(2);
    expect(ledgers()).toHaveLength(1);
    expect(ledgers()[0].llmAttempts).toBe(2);
  });

  it("a repeated exact operation returns the original provider receipt without another paid call", async () => {
    await call("quest-plan")("同一个请求和输入");
    await call("quest-plan")("同一个请求和输入");
    expect(inferenceCalls).toBe(1);
    expect(ledgers()).toHaveLength(1);
    expect(ledgers()[0].llmAttempts).toBe(1);
  });

  it("a task model receipt has an explicit thread association and stable dispatch request identifier", async () => {
    await call("quest-plan")("生成有回执的计划");
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toMatchObject({ ...scope, sessionId: "T-budget" });
    expect(append.mock.calls[0]?.[2]).toMatchObject({ decision: { after: {
      thread_id: "T-budget", execution_request_id: "request-budget", scene: "quest-plan",
    } } });
  });

  it("production calls without a durable request or thread identity stop before provider I/O", async () => {
    const unbound = createConsultingUiLlmCall({ gateway: {} as pg.Pool, scope, scene: "quest-plan", append });
    await expect(unbound("不能匿名购买一个新额度")).rejects.toThrow(/TASK_CONTEXT_REQUIRED/);
    expect(inferenceCalls).toBe(0);
    expect(append).not.toHaveBeenCalled();
  });
});
