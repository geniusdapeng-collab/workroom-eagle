/** Real isolated PG/RLS + durable journal; the provider alone is a no-cost fixture. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withWorkspace } from "@workloom/db";
import type { DeepSeekClient, DeepSeekCompletion } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { getConsultingExecutionContext } from "./execution-context.js";
import { createConsultingUiLlmCall } from "./llm.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_APP_URL) && Boolean(process.env.DATABASE_GATEWAY_URL);
describe.runIf(RUN_DB)("UI model receipt is durable, idempotent and scoped", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const suffix = randomUUID();
  const scope = { tenantId: `tenant-receipt-${suffix}`, workspaceId: `ws-receipt-${suffix}` };
  const other = { tenantId: `tenant-other-${suffix}`, workspaceId: `ws-other-${suffix}` };
  const directory = mkdtempSync(join(tmpdir(), "eagle-ui-receipt-"));
  const previous = process.env.LLM_PROVIDER;
  const result = (id: string): DeepSeekCompletion => ({ text: "Internal review draft", model: "deepseek-flash", requestedModel: "deepseek-flash", provider: "deepseek",
    requestId: id, reservationId: `reservation-${id}`, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    modelMetadata: { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxOutputTokens: 393216,
      verifiedAt: new Date().toISOString(), tokenizerProof: { source: "fixture", artifactSha256: "a".repeat(64), reviewedOn: "2026-10-24", modelVersion: "DeepSeek-V4.1-Flash-1017", algorithm: "fixture", framingAllowance: 1024 } } });
  const events = (target = scope) => withWorkspace(app, target, async (_db, client) => (await client.query(
    `SELECT event_id, session_id, payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND payload#>>'{decision,action}'='model.call' ORDER BY seq`,
    [scope.tenantId, scope.workspaceId],
  )).rows);
  beforeAll(async () => {
    process.env.LLM_PROVIDER = "deepseek";
    for (const target of [scope, other]) {
      await owner.query(`INSERT INTO tenants(id,name,plan) VALUES($1,'隔离回执夹具','pro')`, [target.tenantId]);
      await owner.query(`INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage) VALUES($1,$2,'隔离回执夹具',$1,'consulting','operating')`, [target.workspaceId, target.tenantId]);
    }
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previous;
    await Promise.all([owner.end(), gateway.end(), app.end()]);
    rmSync(directory, { recursive: true, force: true });
  });
  it("concurrent audit of one cached provider receipt appends exactly one event", async () => {
    const id = `provider-concurrent-${suffix}`;
    const complete = vi.fn(async () => result(id));
    const client = getConsultingExecutionContext({ scope, requestId: `dispatch-${suffix}`, supportDir: directory,
      clientFactory: () => ({ complete }) as unknown as DeepSeekClient }).client;
    const call = createConsultingUiLlmCall({ gateway, scope, scene: "quest-plan", client,
      taskContext: { threadId: `T-${suffix}`, requestId: `dispatch-${suffix}` } });
    await call("audited model input");
    await Promise.all(Array.from({ length: 5 }, () => call("audited model input")));
    expect(complete).toHaveBeenCalledTimes(1);
    const rows = await events();
    expect(rows.filter(row => row.payload.decision.after.request_id === id)).toHaveLength(1);
    expect(rows.find(row => row.payload.decision.after.request_id === id)).toMatchObject({ session_id: `T-${suffix}`,
      payload: { decision: { after: { execution_request_id: `dispatch-${suffix}`, thread_id: `T-${suffix}` } } } });
    expect(await events(other)).toEqual([]);
  });
  it("a lost COMMIT acknowledgement does not append or buy again on recovery", async () => {
    const id = `provider-commit-${suffix}`;
    const complete = vi.fn(async () => result(id));
    const client = getConsultingExecutionContext({ scope, requestId: `commit-${suffix}`, supportDir: directory,
      clientFactory: () => ({ complete }) as unknown as DeepSeekClient }).client;
    let loseAck = true;
    const uncertain = { connect: async () => {
      const connection = await gateway.connect();
      return new Proxy(connection, { get(target, key) {
        if (key === "query") return async (...args: Parameters<typeof connection.query>) => {
          const output = await (connection.query as (...values: unknown[]) => Promise<unknown>)(...args);
          if (args[0] === "COMMIT" && loseAck) { loseAck = false; throw new Error("TEST_COMMIT_ACK_LOST"); }
          return output;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    } } as pg.Pool;
    const input = { scope, scene: "quest-plan", client, taskContext: { threadId: `T-commit-${suffix}`, requestId: `commit-${suffix}` } };
    await expect(createConsultingUiLlmCall({ ...input, gateway: uncertain })("commit-bound input")).rejects.toThrow("TEST_COMMIT_ACK_LOST");
    await createConsultingUiLlmCall({ ...input, gateway })("commit-bound input");
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await events()).filter(row => row.payload.decision.after.request_id === id)).toHaveLength(1);
  });
});
