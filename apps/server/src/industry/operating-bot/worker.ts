import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { closeAllPools } from "@workloom/db";
import { executeOperatingBrief } from "../business/operating-service.js";
import { operatingBot, OperatingBotError, type OperatingBotScope } from "./engine.js";

const BATCH = 8;
const DEFAULT_POLL_MS = 5_000;
const HEARTBEAT_MS = 10_000;
const SCOPE_ID = /^[A-Za-z0-9_.:-]{1,160}$/u;

export function readWorkerConfig(env: NodeJS.ProcessEnv): { scope: OperatingBotScope; pollMs: number } {
  const tenantId = env.WORKLOOM_BOT_TENANT_ID ?? "";
  const workspaceId = env.WORKLOOM_BOT_WORKSPACE_ID ?? "";
  if (!SCOPE_ID.test(tenantId) || !SCOPE_ID.test(workspaceId)) {
    throw new Error("经营 BOT 工位必须显式限定 WORKLOOM_BOT_TENANT_ID 与 WORKLOOM_BOT_WORKSPACE_ID。");
  }
  const pollMs = Number(env.WORKLOOM_BOT_POLL_MS ?? DEFAULT_POLL_MS);
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) {
    throw new Error("WORKLOOM_BOT_POLL_MS 允许 250–60000 毫秒。");
  }
  return { scope: { tenantId, workspaceId }, pollMs };
}

async function main() {
  const { scope, pollMs } = readWorkerConfig(process.env);
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.log("[eagle-bot] 已启动单工作区经营分析工位。");
  let priorError: string | null = null;
  let pulse: Promise<void> | null = null;
  let heartbeatFailed = false;
  const timer = setInterval(() => {
    if (pulse || stop.signal.aborted) return;
    pulse = operatingBot.markWorkerPresence(scope, false).then(() => { heartbeatFailed = false; }).catch(() => {
      if (!heartbeatFailed) console.error("[eagle-bot] 工位心跳暂未写入。");
      heartbeatFailed = true;
    }).finally(() => { pulse = null; });
  }, HEARTBEAT_MS);
  try {
    while (!stop.signal.aborted) {
      try {
        await operatingBot.scheduleDue(scope);
        for (let index = 0; index < BATCH && !stop.signal.aborted; index++) {
          if (!await operatingBot.runOnce(scope, executeOperatingBrief)) break;
        }
        await operatingBot.markWorkerPresence(scope, true);
        if (priorError) console.log("[eagle-bot] 工位已恢复处理经营任务。");
        priorError = null;
      } catch (error) {
        const code = error instanceof OperatingBotError ? error.code : "WORKER_CYCLE_FAILED";
        if (code !== priorError) console.error(`[eagle-bot] 本轮暂停，保留数据库状态供下一轮对账（${code}）。`);
        priorError = code;
      }
      try {
        await delay(pollMs, undefined, { signal: stop.signal });
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
    }
  } finally {
    clearInterval(timer);
    await pulse;
    await closeAllPools();
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error && /^经营 BOT 工位必须|^WORKLOOM_BOT_POLL_MS/u.test(error.message)
      ? error.message : "经营 BOT 工位启动失败。");
    process.exitCode = 1;
  });
}
