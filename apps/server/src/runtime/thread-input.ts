/** Reject credentials before thread admission, model input or append-only event persistence. */
import { TRPCError } from "@trpc/server";

const OBVIOUS_CREDENTIAL = /\b(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9_]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9_.~+/-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/iu;
const SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|TOKEN|PASSWORD|SECRET)$|^PII_SALT$/u;

function configuredCredentials(): string[] {
  const values = Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && Boolean(value && value.length >= 8))
    .map(([, value]) => value!);
  for (const name of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
    const value = process.env[name];
    if (!value) continue;
    // Database URLs and their embedded passwords are server-held credentials.
    // Neither is logged or returned when a rejected target contains them.
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password) values.push(value);
      if (password.length >= 8) values.push(password);
    } catch { /* Malformed deployment input is handled by the DB configuration boundary. */ }
  }
  return values;
}

export function assertThreadInputSafe(...values: Array<string | null | undefined>): void {
  const configured = configuredCredentials();
  if (values.some(value => typeof value === "string" && (OBVIOUS_CREDENTIAL.test(value)
    || configured.some(credential => value.includes(credential))))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "任务内容含凭据，已在模型调用和任务入账前拒绝。请删除凭据后重新提交。" });
  }
}
