const IDENTIFIER = /^[a-f0-9-]{36}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;

export interface CommittedReceipt {
  eventId: string;
  hash: string;
  synced?: boolean;
}

export function receiptId(receipt: CommittedReceipt | null | undefined): string | null {
  if (receipt?.synced === false || !receipt?.eventId || !DIGEST.test(receipt.hash)) return null;
  return receipt.eventId;
}

interface Attempt {
  idempotencyKey: string;
  release: () => void;
}

/** Only the opaque operation ID and input digest survive a reload. */
export async function beginBusinessAttempt(scope: string, operation: string, input: unknown): Promise<Attempt> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const storageKey = ["workloom.business-attempt.v1", scope, operation, fingerprint].map(encodeURIComponent).join(":");
  let idempotencyKey = localStorage.getItem(storageKey);
  if (idempotencyKey && !IDENTIFIER.test(idempotencyKey)) throw new Error("无法验证原请求标识");
  if (!idempotencyKey) {
    idempotencyKey = globalThis.crypto.randomUUID();
    localStorage.setItem(storageKey, idempotencyKey);
  }
  return {
    idempotencyKey,
    release: () => {
      if (localStorage.getItem(storageKey) === idempotencyKey) localStorage.removeItem(storageKey);
    },
  };
}
