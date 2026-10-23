/** Installation facts are independent of wizard qualification and never imply a completed business task. */
export function currentDeepSeekConfiguration(env: Record<string, string | undefined> = process.env) {
  return { provider: env.LLM_PROVIDER ?? "mock", baseUrl: env.DEEPSEEK_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.deepseek.com", model: env.LLM_MODEL ?? "deepseek-flash",
    apiKey: env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY ?? "" };
}
export function configuredDeepSeek(env: Record<string, string | undefined> = process.env): boolean {
  const current = currentDeepSeekConfiguration(env);
  const base = current.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return current.provider === "deepseek" && base === "https://api.deepseek.com"
    && current.model === "deepseek-flash" && Boolean(current.apiKey.trim());
}

export function installationFacts(archive: Record<string, unknown>, isExample: boolean, env: Record<string, string | undefined> = process.env) {
  return {
    mode: (isExample ? "example" : archive.dataMode === "real" ? "production" : "simulated") as "production" | "example" | "simulated",
    customerDataReady: Array.isArray(archive.clients) && archive.clients.length > 0,
    modelConfigured: configuredDeepSeek(env),
  };
}

export const VERIFIED_CONSULTING_ARTIFACT_COUNT_SQL = `SELECT count(*)::text AS n FROM biz_events
  WHERE tenant_id=$1 AND workspace_id=$2
    AND payload->'decision'->>'action'='consulting.analysis.read'
    AND payload#>'{receipt,synced}'='true'::jsonb AND payload->'receipt'->>'mode'='real'
    AND jsonb_typeof(payload#>'{decision,after,file,sha256}')='string'
    AND payload#>>'{decision,after,file,sha256}' ~ '^[a-f0-9]{64}$'`;
