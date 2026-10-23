/** Explicit verification of the server-held model configuration. No renderer URL/key and no plaintext persistence. */
import { createHash } from "node:crypto";
import type pg from "pg";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { getDeepSeekClientForTask, type DeepSeekClient, type DeepSeekCompletion } from "../../../../bundles/consulting/connectors/deepseek.mjs";
import { configuredDeepSeek, currentDeepSeekConfiguration } from "./onboarding-installation.js";

type Scope = { tenantId: string; workspaceId: string };
type ModelReceipt = Omit<DeepSeekCompletion, "text">;
interface VerificationEvent { eventId: string; hash: string; action: string; data: Record<string, unknown> }
interface VerificationTx {
  events: VerificationEvent[];
  append(action: string, data: Record<string, unknown>, model?: DeepSeekCompletion): Promise<VerificationEvent>;
  saveProof(proof: Record<string, unknown>): Promise<void>;
}
export interface CurrentModelVerificationStore {
  transaction<T>(scope: Scope, actorId: string, body: (tx: VerificationTx) => Promise<T>): Promise<T>;
}
export class CurrentModelVerificationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const modelCredentialFingerprint = (key: string) => hash(`workloom-llm-credential/v1:${key}`);

export class PgCurrentModelVerificationStore implements CurrentModelVerificationStore {
  constructor(private readonly pool: () => pg.Pool = getAppPool) {}
  async transaction<T>(scope: Scope, actorId: string, body: (tx: VerificationTx) => Promise<T>): Promise<T> {
    const client = await this.pool().connect();
    const sessionId = `onboarding-current-model-${scope.workspaceId}`;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`onboarding-model:${scope.tenantId}:${scope.workspaceId}`]);
      const rows = await client.query<{ event_id: string; hash: string; payload: { decision: { action: string; after: Record<string, unknown> } } }>(
        "SELECT event_id, hash, payload FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY seq", [scope.tenantId, scope.workspaceId, sessionId]);
      const events = rows.rows.map((row) => ({ eventId: row.event_id, hash: row.hash, action: row.payload.decision.action, data: row.payload.decision.after }));
      const result = await body({ events,
        append: async (action, data, model) => {
          const at = new Date().toISOString();
          const receipt = await gatewayAppendOnClient(client, { ...scope, actor: { id: actorId, type: "human" }, sessionId }, {
            who: { id: actorId, type: "human" }, context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: at },
            object: { type: "workspace", id: scope.workspaceId }, decision: { action, after: data, basis: ["成员显式验证本机受保护凭据；未改变经营资格门禁"] }, rule_impact: [],
            ...(model ? { model_trace: { provider: model.provider, model_id: model.model, tier: "standard", credits: 0, request_id: model.requestId, usage: model.usage, reservation_id: model.reservationId,
              model_metadata: model.modelMetadata }, receipt: { synced: true, mode: "real", verified_at: at } } : {}),
          });
          const event = { eventId: receipt.eventId, hash: receipt.hash, action, data }; events.push(event); return event;
        },
        saveProof: async (proof) => {
          const updated = await client.query("UPDATE profiles SET archive=jsonb_set(archive, '{llmVerification}', $2::jsonb, true), updated_at=now() WHERE workspace_id=$1", [scope.workspaceId, JSON.stringify(proof)]);
          if (updated.rowCount !== 1) throw new CurrentModelVerificationError("PROFILE_NOT_FOUND", "当前工作区缺少正式档案，未记录模型验证");
        },
      });
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

export class CurrentModelVerifier {
  constructor(private readonly deps: { store?: CurrentModelVerificationStore; modelFor?: (task: string) => DeepSeekClient;
    env?: () => Record<string, string | undefined> } = {}) {}
  private get store() { return this.deps.store ?? new PgCurrentModelVerificationStore(); }
  private current() { return currentDeepSeekConfiguration(this.deps.env?.() ?? process.env); }
  async verify(scope: Scope, actorId: string, idempotencyKey: string) {
    const env = this.deps.env?.() ?? process.env;
    if (!configuredDeepSeek(env)) throw new CurrentModelVerificationError("MODEL_NOT_CONFIGURED", "当前服务端尚未配置受控 DeepSeek 模型与受保护密钥");
    const config = this.current(); const requestKey = hash(idempotencyKey);
    const fingerprint = hash(JSON.stringify({ provider: config.provider, baseUrl: config.baseUrl, model: config.model, credential: modelCredentialFingerprint(config.apiKey) }));
    const prior = await this.store.transaction(scope, actorId, async (tx) => {
      const existing = tx.events.filter((event) => event.data.requestKey === requestKey);
      if (existing.length) {
        if (existing[0]!.data.configFingerprint !== fingerprint) throw new CurrentModelVerificationError("IDEMPOTENCY_CONFLICT", "原验证请求绑定另一份配置，不能复用幂等键");
        const completed = existing.find((event) => event.action === "onboarding.llm_configured");
        if (completed) return completed;
        throw new CurrentModelVerificationError("VERIFICATION_PENDING", "原模型验证已发起或失败；先保留原回执排查，不能自动重复付费调用");
      }
      await tx.append("onboarding.llm_verification_started", { requestKey, configFingerprint: fingerprint }); return null;
    });
    if (prior) return this.result(prior);
    let completion: DeepSeekCompletion | undefined;
    try {
      const model = (this.deps.modelFor ?? getDeepSeekClientForTask)(`onboarding-model:${scope.tenantId}:${scope.workspaceId}:${requestKey}`);
      completion = await model.complete({ system: "你正在响应用户明确点击的本机模型连接验证。仅回答一句简短中文，不执行工具或经营动作。", prompt: "请回答：模型已连接，正式经营资格仍须通过独立检查。", maxTokens: 128 });
      const current = this.current();
      if (current.provider !== config.provider || current.baseUrl !== config.baseUrl || current.model !== config.model || current.apiKey !== config.apiKey) {
        throw new CurrentModelVerificationError("CONFIGURATION_CHANGED", "模型调用期间受保护配置发生变化，本次回执保留但不记为当前配置已验证");
      }
      const { text: _text, ...modelReceipt } = completion; const verifiedAt = new Date().toISOString();
      const event = await this.store.transaction(scope, actorId, async (tx) => {
        const completed = tx.events.find((item) => item.action === "onboarding.llm_configured" && item.data.requestKey === requestKey);
        if (completed) return completed;
        await tx.saveProof({ provider: config.provider, baseUrl: config.baseUrl, model: config.model,
          credentialFingerprint: modelCredentialFingerprint(config.apiKey), verified: true, verifiedAt, verifiedBy: actorId,
          requestId: completion!.requestId, reservationId: completion!.reservationId });
        return tx.append("onboarding.llm_configured", { requestKey, configFingerprint: fingerprint, verifiedAt, model: modelReceipt }, completion);
      });
      return this.result(event);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && /^[A-Z0-9_]{1,80}$/.test(String(error.code)) ? String(error.code) : "MODEL_VERIFICATION_FAILED";
      const model = completion ? (({ text: _text, ...receipt }) => receipt)(completion) : undefined;
      const committed = await this.store.transaction(scope, actorId, async (tx) => {
        // If COMMIT succeeded but its acknowledgement was lost, read back the original proof instead of metering twice.
        const completed = tx.events.find((item) => item.action === "onboarding.llm_configured" && item.data.requestKey === requestKey);
        if (completed) return completed;
        await tx.append("onboarding.llm_verification_failed", { requestKey, configFingerprint: fingerprint, code, ...(model ? { model } : {}) }, completion);
        return null;
      });
      if (committed) return this.result(committed);
      throw new CurrentModelVerificationError(code, `当前配置未记为已验证（${code}）；服务没有自动重发未知调用`);
    }
  }
  private result(event: VerificationEvent) {
    const model = event.data.model as ModelReceipt;
    return { ok: true as const, provider: model.provider, model: model.model, verifiedAt: String(event.data.verifiedAt), requestId: model.requestId,
      usage: model.usage, receipt: { eventId: event.eventId, hash: event.hash, synced: true as const } };
  }
}
export const currentModelVerifier = new CurrentModelVerifier();
