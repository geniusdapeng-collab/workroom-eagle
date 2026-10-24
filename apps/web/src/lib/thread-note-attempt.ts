/** Persist only an opaque note UUID and content digest so transport loss/reload cannot duplicate a note. */
interface NoteAttempt { version: 1; idempotencyKey: string; fingerprint: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function key(identityKey: string, threadId: string, fingerprint: string): string {
  if (!identityKey || identityKey === "anonymous") throw new Error("身份尚未确认，请等待工作区加载后再留言。");
  return `workloom.thread-note.v1:${encodeURIComponent(identityKey)}:${encodeURIComponent(threadId)}:${fingerprint}`;
}
export async function beginThreadNote(identityKey: string, threadId: string, text: string): Promise<NoteAttempt> {
  const bytes = new TextEncoder().encode(JSON.stringify({ threadId, text }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const storageKey = key(identityKey, threadId, fingerprint);
  let raw: string | null;
  try { raw = localStorage.getItem(storageKey); }
  catch { throw new Error("本机无法读取留言恢复标识，本次尚未追加留言。"); }
  if (raw) {
    let prior: Partial<NoteAttempt>;
    try { prior = JSON.parse(raw) as Partial<NoteAttempt>; }
    catch { throw new Error("原留言的恢复标识无法解析，请先核对任务事件记录。"); }
    if (prior.version !== 1 || !UUID.test(prior.idempotencyKey ?? "") || prior.fingerprint !== fingerprint) {
      throw new Error("原留言的恢复标识不完整，请先核对任务事件记录。");
    }
    return prior as NoteAttempt;
  }
  const attempt: NoteAttempt = { version: 1, idempotencyKey: globalThis.crypto.randomUUID(), fingerprint };
  try { localStorage.setItem(storageKey, JSON.stringify(attempt)); }
  catch { throw new Error("本机无法保存留言恢复标识；为避免重复追加，本次尚未提交。"); }
  return attempt;
}
export function finishThreadNote(identityKey: string, threadId: string, attempt: NoteAttempt): void {
  try { localStorage.removeItem(key(identityKey, threadId, attempt.fingerprint)); }
  catch { throw new Error("留言已有事件回执，但本机恢复标识暂未更新；重试会核对原留言，不重复追加。"); }
}
