import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeepSeekClient, DeepSeekError, inputTokenUpperBound, getDeepSeekClientForTask, getDeepSeekBudgetStatus, DEEPSEEK_MAX_INPUT_BYTES } from './deepseek.mjs';

const good = (overrides = {}) => ({ id: 'ds-request-1', model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '证据来自 S1；草稿待主理人复核。' } }], usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 }, ...overrides });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const metadata = { data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text', 'image'] }] };
const client = (fetchImpl, extra = {}) => createDeepSeekClient({ apiKey: 'unit-test-key', fetchImpl: (url, init) => url.endsWith('/models') ? Promise.resolve(response(metadata)) : fetchImpl(url, init), ...extra });

test('one call uses the documented exact Flash alias, bounded output and real usage', async () => {
  let sent;
  const api = client(async (url, init) => { sent = { url, ...JSON.parse(init.body) }; return response(good()); });
  const out = await api.complete({ system: '咨询员工', prompt: '核对 S1', maxTokens: 1600 });
  assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(sent.model, 'deepseek-flash');
  assert.equal(sent.max_tokens, 1600);
  assert.equal(sent.thinking.type, 'disabled');
  assert.equal(out.requestId, 'ds-request-1');
  assert.deepEqual(out.usage, { promptTokens: 12, completionTokens: 16, totalTokens: 28 });
  assert.equal(api.getBudget().actualTokens, 28);
  assert.equal(api.getBudget().reservedTokens, 0);
});

test('unsafe endpoint and silent model substitution are rejected before network I/O', () => {
  assert.throws(() => client(fetch, { baseUrl: 'https://example.com' }), /ENDPOINT_NOT_ALLOWED/);
  assert.throws(() => client(fetch, { model: 'deepseek-v4-pro' }), /MODEL_NOT_ALLOWED/);
});

test('missing key, oversized and malformed input make no HTTP request', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return response(good()); });
  for (const input of [{ prompt: '' }, { prompt: 'a'.repeat(DEEPSEEK_MAX_INPUT_BYTES + 1) }, { prompt: 'hi', maxTokens: 0 }, { prompt: 'hi', maxTokens: 65536 }]) {
    await assert.rejects(api.complete(input), DeepSeekError);
  }
  const empty = client(async () => { calls++; }, { apiKey: '' });
  await assert.rejects(empty.complete({ prompt: 'test' }), /CREDENTIAL_MISSING/);
  assert.equal(calls, 0);
});

test('token bound covers full UTF8 prompt and fixed chat framing', () => {
  assert.equal(inputTokenUpperBound('顾问', '😀甲'), Buffer.byteLength('顾问😀甲', 'utf8') + 1024);
});

test('complete full-upstream input stays finite and reserves all64000 UTF8bytes before paid I/O', async () => {
  const text = 'a'.repeat(DEEPSEEK_MAX_INPUT_BYTES);
  let reserved;
  const api = client(async () => { reserved = api.getBudget().reservedTokens; return response(good()); });
  await api.complete({ prompt: text, maxTokens: 4096 });
  assert.equal(reserved, 64000 + 1024 + 4096);
  await assert.rejects(api.complete({ system: '界', prompt: text }), /MODEL_INPUT_INVALID/);
  assert.equal(api.getBudget().llmAttempts, 1);
});

test('concurrent attempts reserve calls and tokens before I/O; no automatic retry', async () => {
  let release;
  let calls = 0;
  const api = client(async () => { calls++; await new Promise((r) => { release = r; }); return response(good()); }, { budget: { maxLlmCalls: 1 } });
  const first = api.complete({ prompt: 'test' });
  await assert.rejects(api.complete({ prompt: 'another' }), /BUDGET_CALLS/);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(api.getBudget().llmAttempts, 1);
});

test('token and cost reservations reject before network I/O', async () => {
  let calls = 0;
  const request = async () => { calls++; return response(good()); };
  await assert.rejects(client(request, { budget: { maxLlmTokens: 1050 } }).complete({ prompt: 'hi', maxTokens: 100 }), /BUDGET_TOKENS/);
  await assert.rejects(client(request, { budget: { maxCostCny: 0.000001 } }).complete({ prompt: 'hi' }), /BUDGET_COST/);
  assert.equal(calls, 0);
});

test('HTTP failures retain unknown reservation, freeze all paid I/O, and never expose body', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return response({ error: { message: 'SECRET-provider-body' } }, 429); });
  await assert.rejects(api.complete({ prompt: 'test' }), (e) => e.code === 'PROVIDER_HTTP_429' && !e.message.includes('SECRET'));
  assert.equal(api.getBudget().frozen, true);
  await assert.rejects(api.search({ query: 'public report' }), /BUDGET_FROZEN/);
  assert.equal(calls, 1);
});

for (const [name, payload] of [
  ['missing usage', good({ usage: undefined })],
  ['negative usage', good({ usage: { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 } })],
  ['inconsistent usage', good({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 7 } })],
  ['unverified model', good({ model: 'other-model' })],
]) {
  test(`${name} fails closed and freezes budget`, async () => {
    const api = client(async () => response(payload));
    await assert.rejects(api.complete({ prompt: 'test' }), DeepSeekError);
    assert.equal(api.getBudget().frozen, true);
  });
}

test('truncated or empty answers cannot be presented as a successful deliverable', async () => {
  for (const choice of [{ finish_reason: 'length', message: { content: 'incomplete' } }, { finish_reason: 'stop', message: { content: '' } }]) {
    const api = client(async () => response(good({ choices: [choice] })));
    await assert.rejects(api.complete({ prompt: 'test' }), /OUTPUT_/);
    assert.equal(api.getBudget().actualTokens, 28);
  }
});

test('actual usage above reserved bound freezes budget and rejects success', async () => {
  const api = client(async () => response(good({ usage: { prompt_tokens: 999999, completion_tokens: 16, total_tokens: 1000015 } })));
  await assert.rejects(api.complete({ prompt: 'test' }), /USAGE_BOUND_EXCEEDED/);
  assert.equal(api.getBudget().frozen, true);
});

test('caller abort propagates and no retry occurs', async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const api = client(async () => { calls++; return response(good()); });
  await assert.rejects(api.complete({ prompt: 'test', signal: abort.signal }), /CANCELLED/);
  assert.equal(calls, 0);
});

test('search and fetch use dedicated documented endpoints and keep source receipts', async () => {
  const sent = [];
  const api = client(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return response(url.endsWith('/search') ? { results: [{ title: 'Official', url: 'https://example.com/report', summary: 'Public data', authority: 4 }] } : { title: 'Official', content: '# Public report' });
  });
  const search = await api.search({ query: '公开资料', count: 2 });
  const page = await api.fetchPage({ url: 'https://example.com/report' });
  assert.equal(sent[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(sent[0].body.need_content, false);
  assert.equal(sent[1].url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(search.results[0].url, 'https://example.com/report');
  assert.equal(page.content, '# Public report');
  assert.equal(api.getBudget().searchAttempts, 1);
  assert.equal(api.getBudget().fetchAttempts, 1);
});

test('invalid search and private/credentialed fetch URLs are denied before network', async () => {
  let calls = 0;
  const api = client(async () => { calls++; });
  for (const query of ['', 'a'.repeat(129)]) await assert.rejects(api.search({ query }), /SEARCH_INPUT/);
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1', 'https://user:password@example.com', 'http://10.1.2.3', 'http://[::1]/', 'https://localhost/']) await assert.rejects(api.fetchPage({ url }), /FETCH_URL/);
  assert.equal(calls, 0);
});

test('search empty result is explicit, not a fabricated source', async () => {
  const api = client(async () => response({ results: [] }));
  const out = await api.search({ query: 'no matches' });
  assert.deepEqual(out.results, []);
  assert.equal(out.verified, false);
});

test('persisted budget survives a new client; another environment cannot reset quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eagle-budget-'));
  const file = join(dir, 'ledger.json');
  try {
    const first = client(async () => response(good()), { budgetFile: file, budget: { maxLlmCalls: 1 } });
    await first.complete({ prompt: 'sandbox' });
    let calls = 0;
    const second = client(async () => { calls++; return response(good()); }, { budgetFile: file, budget: { maxLlmCalls: 1 } });
    await assert.rejects(second.complete({ prompt: 'installed client' }), /BUDGET_CALLS/);
    assert.equal(second.getBudget().actualTokens, 28);
    assert.equal(calls, 0);
    const ledger = readFileSync(file, 'utf8');
    assert.ok(!ledger.includes('unit-test-key'));
    assert.ok(!ledger.includes('installed client'));
  } finally { rmSync(dir, { recursive: true }); }
});

test('corrupt or policy-changed persistent ledger cannot be silently replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eagle-budget-'));
  const file = join(dir, 'ledger.json');
  try {
    writeFileSync(file, '{corrupt');
    assert.throws(() => client(fetch, { budgetFile: file }).getBudget(), /BUDGET_LEDGER_INVALID/);
    assert.equal(readFileSync(file, 'utf8'), '{corrupt');
  } finally { rmSync(dir, { recursive: true }); }
});

test('metadata drift stops before any paid call', async () => {
  let calls = 0;
  const api = createDeepSeekClient({ apiKey: 'unit-test-key', fetchImpl: async (url) => { if (!url.endsWith('/models')) calls++; return response({ data: [{ ...metadata.data[0], name: 'DeepSeek-V5-Flash' }] }); } });
  await assert.rejects(api.complete({ prompt: 'test' }), /MODEL_METADATA_DRIFT/);
  assert.equal(api.getBudget().llmAttempts, 0);
  assert.equal(calls, 0);
});

test('network failures and malformed JSON never get converted into completed work', async () => {
  for (const request of [async () => { throw new Error('potentially secret diagnostics'); }, async () => new Response('{not-json')]) {
    const api = client(request);
    await assert.rejects(api.complete({ prompt: 'test' }), (e) => !e.message.includes('potentially secret'));
    assert.equal(api.getBudget().frozen, true);
    assert.ok(api.getBudget().reservedTokens > 0);
  }
});

test('wall-clock budget and web-request count are checked before I/O', async () => {
  let clock = 1000;
  let calls = 0;
  const api = client(async () => { calls++; return response({ results: [] }); }, { now: () => clock, budget: { maxSearchCalls: 1, maxWallClockMin: 1 } });
  await api.search({ query: 'first' });
  await assert.rejects(api.search({ query: 'second' }), /BUDGET_CALLS/);
  clock += 60001;
  await assert.rejects(api.fetchPage({ url: 'https://example.com/' }), /BUDGET_TIME/);
  assert.equal(calls, 1);
});

test('production uses per-task durable quotas; finishing 40 calls cannot disable the next business task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eagle-production-budget-'));
  const saved = { support: process.env.WORKLOOM_SUPPORT_DIR, budget: process.env.WORKLOOM_CONSULTING_BUDGET_FILE, key: process.env.DEEPSEEK_API_KEY, url: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL };
  const originalFetch = globalThis.fetch;
  try {
    process.env.WORKLOOM_SUPPORT_DIR = dir;
    process.env.DEEPSEEK_API_KEY = 'unit-test-key';
    process.env.LLM_MODEL = 'deepseek-flash';
    process.env.LLM_BASE_URL = 'https://api.deepseek.com';
    delete process.env.WORKLOOM_CONSULTING_BUDGET_FILE;
    globalThis.fetch = async (url) => response(String(url).endsWith('/models') ? metadata : good());
    const first = getDeepSeekClientForTask('tenant:workspace:run-A');
    for (let i = 0; i < 40; i++) await first.complete({ prompt: 'bounded task', maxTokens: 100 });
    await assert.rejects(getDeepSeekClientForTask('tenant:workspace:run-A').complete({ prompt: 'same task again' }), /BUDGET_CALLS/);
    const next = getDeepSeekClientForTask('tenant:workspace:run-B');
    await next.complete({ prompt: 'a later customer task' });
    assert.equal(next.getBudget().llmAttempts, 1);
    assert.equal(getDeepSeekBudgetStatus().scope, 'per-business-task');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ WORKLOOM_SUPPORT_DIR: saved.support, WORKLOOM_CONSULTING_BUDGET_FILE: saved.budget, DEEPSEEK_API_KEY: saved.key, LLM_BASE_URL: saved.url, LLM_MODEL: saved.model })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(dir, { recursive: true });
  }
});

test('credentials cannot be sent as prompt text, search query or fetched URL', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return response(good()); });
  await assert.rejects(api.complete({ prompt: 'accidentally pasted unit-test-key' }), /SECRET_IN_INPUT/);
  await assert.rejects(api.search({ query: 'unit-test-key' }), /SECRET_IN_INPUT/);
  await assert.rejects(api.fetchPage({ url: 'https://example.com/?token=unit-test-key' }), /SECRET_IN_INPUT/);
  assert.equal(calls, 0);
});

test('JSON workflow output explicitly enables the official JSON response mode; UI prose does not', async () => {
  const requests = [];
  const api = client(async (_url, init) => { requests.push(JSON.parse(init.body)); return response(good()); });
  await api.complete({ prompt: 'Only return JSON {"ok":true}', jsonMode: true });
  await api.complete({ prompt: '用自然中文回答' });
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(requests[1].response_format, undefined);
  await assert.rejects(api.complete({ prompt: 'JSON', jsonMode: 'true' }), /MODEL_INPUT_INVALID/);
});
