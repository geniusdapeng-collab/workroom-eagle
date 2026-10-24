/** Durable, append-only dispatch admission. A lost response never starts a second classification. */
import type pg from "pg";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import type { Scope } from "./thread-runner.js";

export type ThreadStatus = "queued" | "running" | "pending_review" | "completed" | "failed" | "paused" | "cancelled";
type Via = "llm" | "rule" | "timeout_fallback";
export type DispatchResult =
  | { kind: "clarify"; question: string | undefined; via: Via; requestId?: string }
  | { kind: "routed"; mode: "ask" | "agent" | "quest"; via: Via; threadId: string; status: ThreadStatus;
      requestId?: string; stepsDone?: number; stepsTotal?: number; answer?: string;
      executionSource?: string; error?: string; current_action?: string | null; pendingApprovalId?: string }
  | { kind: "dispatching"; requestId: string }
  | { kind: "failed"; requestId: string; error: string };
export type DispatchRequestView = DispatchResult | { kind: "not-found"; requestId: string };

export function dispatchFingerprint(input: {
  title: string; goalRef?: string | null; presetKey?: string | null; runImmediately: boolean;
}): string {
  return createHash("sha256").update(JSON.stringify({ title: input.title, goalRef: input.goalRef ?? null,
    presetKey: input.presetKey ?? null, runImmediately: input.runImmediately })).digest("hex");
}

async function transaction<T>(scope: Scope, requestId: string, fn: (client: pg.PoolClient) => Promise<T>, lock = false): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
    if (lock) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `thread.dispatch.request:${scope.tenantId}:${scope.workspaceId}:${requestId}`,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function requestRows(client: pg.PoolClient, scope: Scope, requestId: string) {
  const rows = await client.query<{ action: string; after: Record<string, unknown> }>(
    `SELECT payload->'decision'->>'action' AS action,payload->'decision'->'after' AS after
     FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'object'->>'id'=$3
       AND payload->'decision'->>'action' IN ('thread.dispatch.request.claimed','thread.dispatch.request.result')
     ORDER BY seq ASC`, [scope.tenantId, scope.workspaceId, requestId],
  );
  return rows.rows;
}

async function readOn(client: pg.PoolClient, scope: Scope, requestId: string): Promise<DispatchRequestView> {
  const rows = await requestRows(client, scope, requestId);
  if (!rows.some(row => row.action === "thread.dispatch.request.claimed")) return { kind: "not-found", requestId };
  const resolved = [...rows].reverse().find(row => row.action === "thread.dispatch.request.result")?.after.result as DispatchResult | undefined;
  if (resolved && resolved.kind !== "routed") return { ...resolved, requestId };
  // The thread and its dispatch event commit together. This remains recoverable
  // even if the process exits before writing the separate request-result event.
  const thread = await client.query<{
    id: string; mode: "ask" | "agent" | "quest"; status: ThreadStatus; progress_done: number; progress_total: number;
    error: string | null; current_action: string | null; via: Via | null; execution_source: string | null;
  }>(
    `SELECT t.id,t.mode,t.status,t.progress_done,t.progress_total,t.error,t.current_action,
       d.payload->'decision'->'after'->>'via' AS via,
       (SELECT e.payload->'decision'->'after'->>'executionSource' FROM biz_events e
         WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.session_id=t.id
           AND e.payload->'decision'->>'action'='thread.execution.bound' ORDER BY e.seq DESC LIMIT 1) AS execution_source
     FROM threads t JOIN biz_events d ON d.session_id=t.id AND d.tenant_id=t.tenant_id AND d.workspace_id=t.workspace_id
     WHERE t.tenant_id=$1 AND t.workspace_id=$2 AND d.payload->'decision'->>'action'='thread.dispatch'
       AND d.payload->'decision'->'after'->>'execution_request_id'=$3 ORDER BY d.seq ASC LIMIT 1`,
    [scope.tenantId, scope.workspaceId, requestId],
  );
  const current = thread.rows[0];
  if (current) return { ...(resolved?.kind === "routed" ? resolved : {}), kind: "routed", requestId,
    mode: current.mode, via: current.via ?? "rule", threadId: current.id, status: current.status,
    stepsDone: current.progress_done, stepsTotal: current.progress_total,
    executionSource: current.execution_source ?? "generic", current_action: current.current_action,
    // The durable result is a submission snapshot. Clear its stale error when
    // the authoritative thread has recovered rather than spreading it forward.
    error: current.error ?? undefined,
  };
  if (resolved) return { ...resolved, requestId };
  return { kind: "dispatching", requestId };
}

export async function readDispatchRequest(scope: Scope, requestId: string): Promise<DispatchRequestView> {
  return transaction(scope, requestId, client => readOn(client, scope, requestId));
}

export async function claimDispatchRequest(scope: Scope, actorId: string, requestId: string, fingerprint: string): Promise<
  { claimed: true } | { claimed: false; result: DispatchResult }
> {
  return transaction(scope, requestId, async client => {
    const rows = await requestRows(client, scope, requestId);
    const claimed = rows.find(row => row.action === "thread.dispatch.request.claimed");
    if (claimed) {
      if (claimed.after.fingerprint !== fingerprint) throw new TRPCError({ code: "CONFLICT", message: "这次提交标识已绑定另一个目标，请恢复原任务或明确发起新任务。" });
      const result = await readOn(client, scope, requestId);
      if (result.kind === "not-found") throw new Error("DISPATCH_REQUEST_CLAIM_INCONSISTENT");
      return { claimed: false, result };
    }
    await gatewayAppendOnClient(client, { ...scope, actor: { id: actorId, type: "human" }, sessionId: requestId }, {
      who: { id: actorId, type: "human" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "dispatch_request", id: requestId },
      decision: { action: "thread.dispatch.request.claimed", after: { fingerprint } }, rule_impact: [],
    });
    return { claimed: true };
  }, true);
}

export async function settleDispatchRequest(scope: Scope, actorId: string, requestId: string, result: DispatchResult): Promise<DispatchResult> {
  return transaction(scope, requestId, async client => {
    const rows = await requestRows(client, scope, requestId);
    if (!rows.some(row => row.action === "thread.dispatch.request.claimed")) throw new Error("DISPATCH_REQUEST_NOT_CLAIMED");
    if (!rows.some(row => row.action === "thread.dispatch.request.result")) {
      await gatewayAppendOnClient(client, { ...scope, actor: { id: actorId, type: "human" }, sessionId: requestId }, {
        who: { id: actorId, type: "human" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
        object: { type: "dispatch_request", id: requestId },
        decision: { action: "thread.dispatch.request.result", after: { result: { ...result, requestId } } }, rule_impact: [],
      });
    }
    const resolved = await readOn(client, scope, requestId);
    if (resolved.kind === "not-found") throw new Error("DISPATCH_REQUEST_RESULT_INCONSISTENT");
    return resolved;
  }, true);
}
