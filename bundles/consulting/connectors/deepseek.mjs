/**
 * Eagle's bounded, single-turn DeepSeek connector. No retries, history, SDK
 * retries, automatic tool loops, substitute models or simulated receipts.
 * Official API contract verified 2026-10-23:
 * https://api-docs.deepseek.com/quick_start/pricing/
 * https://api-docs.deepseek.com/api/create-chat-completion/
 * https://api-docs.deepseek.com/guides/search/
 */
import { randomUUID, createHash } from 'node:crypto';
import { constants, mkdirSync, openSync, closeSync, fstatSync, fsyncSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export class DeepSeekError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DeepSeekError';
    this.code = code;
    // A failed request with unknown usage freezes the ledger. Automatic retry
    // would double-charge an uncertain attempt, so callers must never retry it.
    this.retryable = false;
  }
}

export const DEEPSEEK_MODEL = 'deepseek-flash';
export const TOKENIZER_PROOF = Object.freeze({
  source: 'https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip',
  artifactSha256: 'e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495',
  reviewedOn: '2026-10-24',
  modelVersion: 'DeepSeek-V4.1-Flash-1017',
  algorithm: 'ByteLevel BPE; empty normalizer; no added prefix; all 256 byte symbols in vocabulary',
  framingAllowance: 1024,
});
const LIMITS = Object.freeze({ maxLlmCalls: 40, maxLlmTokens: 300000, maxCostCny: 120, maxWallClockMin: 45, maxSearchCalls: 8, maxFetchCalls: 8 });
export const DEEPSEEK_BUDGET_LIMITS = LIMITS;
export const DEEPSEEK_MAX_INPUT_BYTES = 100000;
const MAX_OUTPUT_TOKENS = 4096;
// Peak uncached Flash: USD 0.3 / 1M input, 1.2 / 1M output.
// Use the higher rate for ALL reserved tokens and a conservative 10 CNY/USD
// accounting factor. This is an explicitly labelled cost estimate, not FX or
// a provider invoice. Actual token usage remains separately recorded.
const CNY_PER_TOKEN_UPPER = 12 / 1000000;
const CNY_PER_WEB_REQUEST = 0.0075;
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * The reviewed official tokenizer represents each UTF-8 byte by a vocabulary
 * token before BPE merging; merges can only reduce count. For two text messages,
 * its fixed chat template is below 1024 UTF-8 bytes. There is no history, image,
 * hidden client tool schema or retry. Thus this bound covers input AND framing,
 * rather than pretending max_tokens bounds the input. Provider usage above this
 * bound signals tokenizer/template drift and freezes further paid I/O.
 */
export function inputTokenUpperBound(system = '', prompt = '') {
  return Buffer.byteLength(system, 'utf8') + Buffer.byteLength(prompt, 'utf8') + TOKENIZER_PROOF.framingAllowance;
}

function fail(code, detail) { throw new DeepSeekError(code, detail); }
function isInteger(n) { return Number.isSafeInteger(n) && n >= 0; }
function snapshot(value) { return structuredClone(value); }

function privateBudgetDirectory(path) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') fail('BUDGET_STORAGE_UNSAFE');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    info = lstatSync(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail('BUDGET_STORAGE_UNSAFE');
}

function privateBudgetFile(path) {
  let info;
  try { info = lstatSync(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; fail('BUDGET_STORAGE_UNSAFE'); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size > 8 * 1024 * 1024
    || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail('BUDGET_STORAGE_UNSAFE');
  return info;
}

function readPrivateBudgetFile(path) {
  const info = privateBudgetFile(path);
  if (!info) return undefined;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1
      || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)) fail('BUDGET_STORAGE_UNSAFE');
    return readFileSync(fd, 'utf8');
  } catch (error) { if (error instanceof DeepSeekError) throw error; fail('BUDGET_STORAGE_UNSAFE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function writePrivateBudgetFile(path, text) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function initialState(policy, now) {
  return { schemaVersion: 'eagle.deepseek-budget/v1', policy, startedAt: now(), llmAttempts: 0, searchAttempts: 0, fetchAttempts: 0, actualTokens: 0, reservedTokens: 0, actualCostCny: 0, reservedCostCny: 0, frozen: false, freezeReason: null, reservations: [], tokenizerProof: TOKENIZER_PROOF };
}

function budgetStore(options, now) {
  const policy = { ...LIMITS, ...(options.budget ?? {}) };
  for (const [key, ceiling] of Object.entries(LIMITS)) {
    const value = policy[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > ceiling || (key !== 'maxCostCny' && key !== 'maxWallClockMin' && !Number.isSafeInteger(value))) fail('BUDGET_CONFIG', key);
  }
  const file = options.budgetFile ? resolve(options.budgetFile) : undefined;
  let memory = initialState(policy, now);
  if (file) { privateBudgetDirectory(dirname(file)); privateBudgetFile(file); }
  function transaction(change) {
    if (!file) {
      const out = change(memory);
      return out;
    }
    const lock = `${file}.lock`;
    privateBudgetDirectory(dirname(file));
    privateBudgetFile(file);
    privateBudgetFile(lock);
    let fd;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { fail('BUDGET_LOCKED', 'another writer or an interrupted transaction owns the ledger lock'); }
    try {
      let state;
      const raw = readPrivateBudgetFile(file);
      try { state = raw === undefined ? initialState(policy, now) : JSON.parse(raw); }
      catch { fail('BUDGET_LEDGER_INVALID'); }
      if (state.schemaVersion !== 'eagle.deepseek-budget/v1' || JSON.stringify(state.policy) !== JSON.stringify(policy) || state.tokenizerProof?.artifactSha256 !== TOKENIZER_PROOF.artifactSha256 || !Array.isArray(state.reservations)) fail('BUDGET_LEDGER_INVALID');
      for (const field of ['llmAttempts', 'searchAttempts', 'fetchAttempts', 'actualTokens', 'reservedTokens']) if (!isInteger(state[field])) fail('BUDGET_LEDGER_INVALID');
      for (const field of ['startedAt', 'actualCostCny', 'reservedCostCny']) if (typeof state[field] !== 'number' || !Number.isFinite(state[field]) || state[field] < 0) fail('BUDGET_LEDGER_INVALID');
      for (const entry of state.reservations.filter((r) => r.status === 'pending')) {
        // A process that exited while awaiting its provider cannot prove usage.
        // Keep the reservation and stop; restarting cannot reset the quota.
        try { process.kill(entry.pid, 0); } catch { state.frozen = true; state.freezeReason = 'INTERRUPTED_USAGE_UNKNOWN'; }
      }
      let out;
      let thrown;
      try { out = change(state); } catch (error) { thrown = error; }
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        writePrivateBudgetFile(temp, `${JSON.stringify(state, null, 2)}\n`);
        privateBudgetFile(file);
        renameSync(temp, file);
      } finally { try { unlinkSync(temp); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
      if (thrown) throw thrown;
      return out;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  function reserve(kind, tokens = 0) {
    return transaction((state) => {
      if (state.frozen) fail('BUDGET_FROZEN', state.freezeReason ?? 'unknown usage');
      if (now() - state.startedAt > policy.maxWallClockMin * 60000) fail('BUDGET_TIME');
      const counter = kind === 'llm' ? 'llmAttempts' : kind === 'search' ? 'searchAttempts' : 'fetchAttempts';
      const ceiling = kind === 'llm' ? policy.maxLlmCalls : kind === 'search' ? policy.maxSearchCalls : policy.maxFetchCalls;
      if (state[counter] >= ceiling) fail('BUDGET_CALLS', kind);
      // One acceptance round may spend at most eight web operations in total.
      // Keep the existing ledger policy shape so old evidence remains readable.
      if (kind !== 'llm' && state.searchAttempts + state.fetchAttempts >= Math.min(8, policy.maxSearchCalls + policy.maxFetchCalls)) fail('BUDGET_WEB_CALLS');
      if (state.actualTokens + state.reservedTokens + tokens > policy.maxLlmTokens) fail('BUDGET_TOKENS');
      const cost = kind === 'llm' ? tokens * CNY_PER_TOKEN_UPPER : CNY_PER_WEB_REQUEST;
      if (state.actualCostCny + state.reservedCostCny + cost > policy.maxCostCny) fail('BUDGET_COST');
      const entry = { id: randomUUID(), kind, tokens, estimatedCostCny: cost, pid: process.pid, status: 'pending', reservedAt: now() };
      state[counter]++;
      state.reservedTokens += tokens;
      state.reservedCostCny += cost;
      state.reservations.push(entry);
      return snapshot(entry);
    });
  }
  function freeze(id, reason) {
    transaction((state) => {
      state.frozen = true;
      state.freezeReason = reason;
      const entry = state.reservations.find((r) => r.id === id);
      if (entry?.status === 'pending') { entry.status = 'unknown'; entry.errorCode = reason; }
    });
  }
  function settle(id, tokens, receipt) {
    return transaction((state) => {
      const entry = state.reservations.find((r) => r.id === id);
      if (!entry || entry.status !== 'pending') fail('RESERVATION_INVALID');
      if (!isInteger(tokens) || tokens > entry.tokens) {
        state.frozen = true;
        state.freezeReason = 'USAGE_BOUND_EXCEEDED';
        entry.status = 'unknown';
        fail('USAGE_BOUND_EXCEEDED');
      }
      state.reservedTokens -= entry.tokens;
      state.reservedCostCny = Math.max(0, state.reservedCostCny - entry.estimatedCostCny);
      state.actualTokens += tokens;
      const cost = entry.kind === 'llm' ? tokens * CNY_PER_TOKEN_UPPER : receipt.billable ? CNY_PER_WEB_REQUEST : 0;
      state.actualCostCny += cost;
      Object.assign(entry, { status: 'settled', actualTokens: tokens, estimatedActualCostCny: cost, settledAt: now(), receipt });
    });
  }
  return { reserve, freeze, settle, get: () => transaction((state) => snapshot(state)) };
}

function safePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { fail('FETCH_URL'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || raw.length > 8192 || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') || host.includes(':') || /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)) fail('FETCH_URL');
  return url.href;
}

async function jsonResponse(res) {
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES) { await res.body?.cancel(); fail('RESPONSE_TOO_LARGE'); }
  const reader = res.body?.getReader();
  if (!reader) fail('RESPONSE_INVALID');
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
      parts.push(next.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) { if (error instanceof DeepSeekError) throw error; fail('RESPONSE_INVALID'); }
  finally { reader.releaseLock(); }
}

export function createDeepSeekClient(options = {}) {
  // Explicit test/injected credentials remain fixed. Production credentials are
  // resolved at the request boundary so opening Settings before provisioning a
  // key cannot cache an empty credential for the lifetime of the application.
  const currentKey = () => options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? '';
  const baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? process.env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  if (baseUrl !== 'https://api.deepseek.com') fail('ENDPOINT_NOT_ALLOWED');
  if ((options.model ?? process.env.LLM_MODEL ?? DEEPSEEK_MODEL) !== DEEPSEEK_MODEL) fail('MODEL_NOT_ALLOWED');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const budget = budgetStore({ ...options, budgetFile: options.budgetFile ?? process.env.WORKLOOM_CONSULTING_BUDGET_FILE }, now);
  const timeoutMs = options.timeoutMs ?? 90000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('TIMEOUT_CONFIG');
  let metadataPromise;

  function headers() {
    const apiKey = currentKey();
    if (!apiKey.trim()) fail('CREDENTIAL_MISSING');
    return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  }
  function rejectSecrets(text, code = 'SECRET_IN_INPUT') {
    const apiKey = currentKey();
    if ((apiKey.length >= 8 && text.includes(apiKey)) || /\b(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9_]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/u.test(text)) fail(code);
  }
  async function http(path, body, signal) {
    if (signal?.aborted) fail('CANCELLED');
    const timeout = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { method: body ? 'POST' : 'GET', headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (error instanceof DeepSeekError) throw error;
      if (signal?.aborted) fail('CANCELLED');
      if (timeout.aborted) fail('PROVIDER_TIMEOUT');
      fail('PROVIDER_NETWORK');
    }
    if (!res.ok) { await res.body?.cancel(); fail(`PROVIDER_HTTP_${res.status}`); }
    return jsonResponse(res);
  }
  async function verifyModel(signal) {
    if (!metadataPromise) {
      metadataPromise = (async () => {
        const data = await http('/models', undefined, signal);
        const model = data.data?.find((m) => m.id === DEEPSEEK_MODEL);
        if (!model || !['DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash-1017'].includes(model.name) || model.context_window !== 1048576 || model.max_output_tokens !== 393216 || !model.input_modalities?.includes('text')) fail('MODEL_METADATA_DRIFT');
        return { id: model.id, name: model.name, contextWindow: model.context_window, maxOutputTokens: model.max_output_tokens, verifiedAt: new Date(now()).toISOString(), tokenizerProof: TOKENIZER_PROOF };
      })();
    }
    const current = metadataPromise;
    try { return await current; }
    finally { if (metadataPromise === current) metadataPromise = undefined; }
  }

  async function complete(input) {
    const { system = '', prompt, maxTokens = 2048, signal, jsonMode = false } = input ?? {};
    if (typeof system !== 'string' || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(system + prompt, 'utf8') > DEEPSEEK_MAX_INPUT_BYTES || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS || typeof jsonMode !== 'boolean') fail('MODEL_INPUT_INVALID');
    headers();
    rejectSecrets(system + prompt);
    if (signal?.aborted) fail('CANCELLED');
    const modelMetadata = await verifyModel(signal);
    const upperInput = inputTokenUpperBound(system, prompt);
    const reservation = budget.reserve('llm', upperInput + maxTokens);
    let data;
    try {
      data = await http('/chat/completions', { model: DEEPSEEK_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], thinking: { type: 'disabled' }, max_tokens: maxTokens, stream: false, temperature: 0.2, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }, signal);
      rejectSecrets(JSON.stringify(data), 'SECRET_IN_OUTPUT');
      const u = data.usage;
      if (!u || ![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(isInteger) || u.prompt_tokens + u.completion_tokens !== u.total_tokens) fail('USAGE_INVALID');
      if (data.model !== DEEPSEEK_MODEL || typeof data.id !== 'string' || !data.id) fail('MODEL_RECEIPT_INVALID');
      if (u.prompt_tokens > upperInput || u.completion_tokens > maxTokens) fail('USAGE_BOUND_EXCEEDED');
      const usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens };
      budget.settle(reservation.id, usage.totalTokens, { requestId: data.id, model: data.model, usage });
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop') fail('OUTPUT_INCOMPLETE', typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'missing finish reason');
      if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) fail('OUTPUT_EMPTY');
      return { text: choice.message.content, model: data.model, requestedModel: DEEPSEEK_MODEL, provider: 'deepseek', requestId: data.id, usage, finishReason: choice.finish_reason, reservationId: reservation.id, modelMetadata };
    } catch (error) {
      // Settled truncated/empty output has known usage. All other uncertainty
      // retains its reservation and freezes the shared cross-process ledger.
      if (!(error instanceof DeepSeekError && ['OUTPUT_INCOMPLETE', 'OUTPUT_EMPTY'].includes(error.code))) budget.freeze(reservation.id, error instanceof DeepSeekError ? error.code : 'PROVIDER_UNKNOWN');
      throw error instanceof DeepSeekError ? error : new DeepSeekError('PROVIDER_UNKNOWN');
    }
  }

  async function web(kind, body, signal) {
    headers();
    if (signal?.aborted) fail('CANCELLED');
    const reservation = budget.reserve(kind);
    try {
      const data = await http(`/v1/tools/${kind}`, body, signal);
      rejectSecrets(JSON.stringify(data), 'SECRET_IN_OUTPUT');
      if (kind === 'search') {
        if (!Array.isArray(data.results)) fail('SEARCH_RESPONSE_INVALID');
        const results = data.results.slice(0, body.count).map((r) => {
          if (typeof r.title !== 'string' || typeof r.url !== 'string') fail('SEARCH_RESPONSE_INVALID');
          return { title: r.title, url: safePublicUrl(r.url), summary: typeof r.summary === 'string' ? r.summary : '', snippet: typeof r.snippet === 'string' ? r.snippet : '', date: typeof r.date === 'string' ? r.date : null, authority: typeof r.authority === 'number' ? r.authority : -1 };
        });
        budget.settle(reservation.id, 0, { billable: results.length > 0, resultCount: results.length, provider: 'deepseek', kind });
        return { results, verified: results.length > 0, provider: 'deepseek', retrievedAt: new Date(now()).toISOString(), reservationId: reservation.id };
      }
      if (typeof data.content !== 'string' || !data.content.trim()) fail('FETCH_RESPONSE_INVALID');
      budget.settle(reservation.id, 0, { billable: true, provider: 'deepseek', kind });
      return { title: typeof data.title === 'string' ? data.title : '', content: data.content, url: body.url, provider: 'deepseek', retrievedAt: new Date(now()).toISOString(), reservationId: reservation.id };
    } catch (error) {
      budget.freeze(reservation.id, error instanceof DeepSeekError ? error.code : 'WEB_USAGE_UNKNOWN');
      throw error instanceof DeepSeekError ? error : new DeepSeekError('WEB_USAGE_UNKNOWN');
    }
  }

  return {
    complete,
    verifyModel,
    search({ query, count = 5, signal } = {}) {
      if (typeof query !== 'string' || !query.trim() || [...query].length > 128 || !Number.isSafeInteger(count) || count < 1 || count > 10) return Promise.reject(new DeepSeekError('SEARCH_INPUT'));
      try { rejectSecrets(query); } catch (error) { return Promise.reject(error); }
      return web('search', { query, count, need_content: false }, signal);
    },
    fetchPage({ url, signal } = {}) {
      try { if (typeof url !== 'string') fail('FETCH_URL'); rejectSecrets(url); return web('fetch', { url: safePublicUrl(url) }, signal); }
      catch (error) { return Promise.reject(error); }
    },
    getBudget: budget.get,
  };
}

let defaultClient;
export function getDefaultDeepSeekClient() { return defaultClient ??= createDeepSeekClient(); }

/**
 * Production quotas belong to a durable business task, not the lifetime of a
 * desktop process. An explicit evaluation ledger overrides EVERY task so moving
 * between sandbox/client, UI/CLI/MCP or restarting never resets the test budget.
 */
export function getDeepSeekClientForTask(taskIdentity) {
  if (typeof taskIdentity !== 'string' || !taskIdentity || taskIdentity.length > 1000) fail('TASK_ID_INVALID');
  if (process.env.WORKLOOM_CONSULTING_BUDGET_FILE) return getDefaultDeepSeekClient();
  const support = process.env.WORKLOOM_SUPPORT_DIR ?? resolve(homedir(), 'Library', 'Application Support', 'WorkRoomEagle');
  privateBudgetDirectory(resolve(support, 'consulting'));
  privateBudgetDirectory(resolve(support, 'consulting', 'budgets'));
  const id = createHash('sha256').update(taskIdentity).digest('hex');
  return createDeepSeekClient({ budgetFile: resolve(support, 'consulting', 'budgets', `${id}.json`) });
}

export function getDeepSeekBudgetStatus() {
  return process.env.WORKLOOM_CONSULTING_BUDGET_FILE
    ? { scope: 'explicit-shared-evaluation', ...getDefaultDeepSeekClient().getBudget() }
    : { scope: 'per-business-task', policy: { ...LIMITS }, note: 'Each durable consulting run receives its own budget; desktop uptime and completed jobs do not exhaust future tasks.' };
}
