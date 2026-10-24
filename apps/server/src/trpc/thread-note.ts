/** A member's task note is an append-only event, never a dispatch, execution or state update. */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient, type EventDraft } from "@workloom/base/workdata";
import { assertThreadInputSafe } from "../runtime/thread-input.js";
import { actionProcedure, scopeOf } from "./context.js";

export const threadNoteProcedure = actionProcedure("workspace.write")
  .input(z.object({
    threadId: z.string().regex(/^T-[A-Za-z0-9_-]{1,110}$/),
    text: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().uuid(),
  }).strict())
  .mutation(async ({ ctx, input }) => {
    assertThreadInputSafe(input.text);
    const scope = scopeOf(ctx.identity);
    const requestKey = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify({ text: input.text, actorId: ctx.identity.memberNo })).digest("hex");
    const client = await getAppPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
      const thread = await client.query(`SELECT id FROM threads WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR KEY SHARE`,
        [input.threadId, scope.tenantId, scope.workspaceId]);
      if (!thread.rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在或无权留言。" });
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["thread.note", scope.tenantId, scope.workspaceId, input.threadId, requestKey]),
      ]);
      const existing = await client.query<{ event_id: string; hash: string; payload: EventDraft }>(
        `SELECT event_id,hash,payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3
           AND payload#>>'{decision,action}'='thread.note' AND payload#>>'{decision,after,requestKey}'=$4 ORDER BY seq LIMIT 1`,
        [scope.tenantId, scope.workspaceId, input.threadId, requestKey]);
      const prior = existing.rows[0];
      if (prior) {
        const after = prior.payload.decision.after as { fingerprint?: string } | undefined;
        if (after?.fingerprint !== fingerprint) throw new TRPCError({ code: "CONFLICT", message: "同一留言标识已绑定其他正文或操作者，请恢复原留言。" });
        if (!/^E-\d+$/.test(prior.event_id) || !/^[a-f0-9]{64}$/.test(prior.hash) || prior.payload.receipt?.synced !== true) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "原留言事件回执不完整，不能重复追加或宣称成功。" });
        }
        await client.query("COMMIT");
        return { threadId: input.threadId, receipt: { eventId: prior.event_id, hash: prior.hash, synced: true as const } };
      }
      const time = new Date().toISOString();
      const saved = await gatewayAppendOnClient(client, { ...scope, sessionId: input.threadId,
        actor: { id: ctx.identity.memberNo, type: "human" } }, {
        who: { id: ctx.identity.memberNo, type: "human" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time, channel: "inapp" },
        object: { type: "thread", id: input.threadId },
        decision: { action: "thread.note", after: { text: input.text, requestKey, fingerprint },
          basis: ["成员在当前任务追加留言；只写事件账本，不派单、不推进任务、不调用模型。"] },
        rule_impact: [],
        receipt: { synced: true, mode: "real", verified_at: time, snapshot_uri: `workloom://thread/${encodeURIComponent(input.threadId)}/note/${requestKey}` },
      });
      await client.query("COMMIT");
      return { threadId: input.threadId, receipt: { eventId: saved.eventId, hash: saved.hash, synced: true as const } };
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "任务留言未完成且事务回滚未确认。"); }
      throw error;
    } finally { client.release(); }
  });
