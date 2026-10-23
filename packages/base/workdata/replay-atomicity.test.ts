import { describe, expect, it } from "vitest";
import type pg from "pg";
import { gatewayAppendIdempotent } from "./gateway.js";
import type { BusinessEvent } from "@workloom/shared";

const scope = { tenantId: "tenant-replay-atomicity", workspaceId: "ws-replay-atomicity" };
const context = {
  ...scope,
  actor: { id: "desktop-agent", type: "agent" as const, highRisk: true, fenceBindings: ["R2"] },
  approvalRef: "apr-replay-atomicity",
};
const event = (eventId = "E-RPL-atomicity"): BusinessEvent => ({
  event_id: eventId,
  who: { id: "desktop-agent", type: "agent" },
  context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: "2026-10-23T08:00:00Z" },
  object: { type: "desktop", id: "local-document" },
  decision: { action: "desktop.gui", after: { note: "contact audit@example.test" } },
  rule_impact: [],
});

// SQL-specific transaction double: every statement must be registered. Approval state
// and event insertion remain private until COMMIT, so failure tests detect split commits.
function replayDatabase(failInsert = false) {
  const durable = { consumed: false, events: 0, connections: 0, commits: 0, payload: "" };
  const pool = {
    async connect() {
      durable.connections += 1;
      let local = { ...durable };
      return {
        release() {},
        async query(sql: string, args: unknown[] = []) {
          const normalized = sql.replace(/\s+/g, " ").trim();
          if (normalized === "BEGIN") { local = { ...durable }; return { rows: [] }; }
          if (normalized === "COMMIT") {
            durable.consumed = local.consumed;
            durable.events = local.events;
            durable.payload = local.payload;
            durable.commits += 1;
            return { rows: [] };
          }
          if (normalized === "ROLLBACK") { local = { ...durable }; return { rows: [] }; }
          if (/^SELECT set_config\(/.test(normalized) || /^SELECT pg_advisory_xact_lock\(/.test(normalized)) return { rows: [] };
          if (/^SELECT status, snapshot FROM approvals/.test(normalized)) return {
            rows: [{ status: "approved", snapshot: { action: "desktop.gui", object_type: "desktop", object_id: "local-document" } }],
          };
          if (/^UPDATE approvals SET consumed_at/.test(normalized)) {
            if (local.consumed) return { rows: [], rowCount: 0 };
            local.consumed = true;
            return { rows: [], rowCount: 1 };
          }
          if (/^SELECT seq, hash FROM biz_events/.test(normalized)) return { rows: [] };
          if (/^SELECT \* FROM append_event_insert/.test(normalized)) {
            if (failInsert) throw new Error("injected append failure");
            local.events += 1;
            local.payload = String(args[4]);
            return { rows: [{ seq: "1", inserted: true }] };
          }
          throw new Error(`Unregistered replay SQL: ${normalized}`);
        },
      };
    },
  } as unknown as pg.Pool;
  return { pool, durable };
}

describe("replayed high-risk event and one-use approval commit together", () => {
  it("failed append rolls back approval consumption", async () => {
    const { pool, durable } = replayDatabase(true);
    await expect(gatewayAppendIdempotent(pool, context, event())).rejects.toThrow("injected append failure");
    expect(durable.consumed).toBe(false);
    expect(durable.events).toBe(0);
    expect(durable.commits).toBe(0);
  });

  it("invalid replay namespace cannot consume approval before rejection", async () => {
    const { pool, durable } = replayDatabase();
    await expect(gatewayAppendIdempotent(pool, context, event("E-9999"))).rejects.toThrow(/前缀空间/);
    expect(durable.consumed).toBe(false);
    expect(durable.connections).toBe(0);
  });

  it("successful replay uses one connection and one commit and masks PII", async () => {
    const { pool, durable } = replayDatabase();
    const result = await gatewayAppendIdempotent(pool, context, event());
    expect(result.deduped).toBe(false);
    expect(durable.consumed).toBe(true);
    expect(durable.events).toBe(1);
    expect(durable.connections).toBe(1);
    expect(durable.commits).toBe(1);
    expect(durable.payload).not.toContain("audit@example.test");
    expect(result.piiHits).toBeGreaterThan(0);
  });
});
