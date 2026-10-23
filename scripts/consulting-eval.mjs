#!/usr/bin/env node
/** Real-model consulting delivery evaluation through the shipped CLI or MCP. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadCatalog, toolName } from './agent-capabilities.mjs';
import { TOKENIZER_PROOF } from '../bundles/consulting/connectors/deepseek.mjs';

const root = resolve(import.meta.dirname, '..');
const digest = (text) => createHash('sha256').update(text).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function checkArtifact(run, task, files) {
  check(run?.status === 'draft_ready', `task did not reach draft_ready: ${run?.status ?? 'missing'} / ${run?.error?.code ?? ''}`);
  check(run.humanReviewRequired === true, 'human final review flag missing');
  check(Array.isArray(run.steps) && Array.isArray(run.completed) && run.steps.length === run.completed.length, 'step/receipt count mismatch');
  if (task.employeeKey) check(run.steps.length === 1 && run.steps[0].employeeKey === task.employeeKey, 'selected employee was not executed');
  else {
    check(run.steps.length === task.stepCount, 'complex task step count mismatch');
    check(new Set(run.steps.map((s) => s.employeeKey)).size === task.stepCount, 'complex task did not use distinct employees');
    check(run.steps[0].employeeKey === task.requiredFirst, 'diagnosis prerequisite missing');
    check(run.steps.at(-2).employeeKey === task.requiredPenultimate, 'report prerequisite missing');
    check(run.steps.at(-1).employeeKey === task.requiredLast, 'independent quality gate missing');
    check(typeof run.rationale === 'string' && run.rationale.length >= 8, 'planner rationale missing');
    check(run.planModel?.provider === 'deepseek' && run.planModel?.requestId && run.planModel?.usage?.totalTokens > 0, 'real planner model receipt missing');
  }
  const sources = new Map(run.sources.map((s) => [s.id, s]));
  const fullText = [];
  const requests = new Set();
  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];
    const done = run.completed[i];
    check(done.stepId === step.id, 'steps executed out of declared order');
    check(JSON.stringify(step.dependsOn) === JSON.stringify(i ? [run.steps[i - 1].id] : []), 'dependency chain missing or altered');
    check(done.model?.provider === 'deepseek' && done.model?.model === 'deepseek-flash', 'real configured Flash model was not used');
    check(done.model?.requestId && done.model?.reservationId && !requests.has(done.model.requestId), 'missing/duplicate provider request receipt');
    requests.add(done.model.requestId);
    check(done.model?.usage?.totalTokens > 0 && done.model.usage.totalTokens === done.model.usage.promptTokens + done.model.usage.completionTokens, 'actual provider usage missing');
    check(typeof done.eventId === 'string' && /^[a-f0-9]{64}$/.test(done.hash), 'immutable event receipt missing');
    const artifact = done.artifact;
    check(artifact?.humanReviewRequired === true && artifact?.findings?.length > 0 && artifact?.recommendations?.length > 0, 'substantive draft structure missing');
    for (const finding of artifact.findings) {
      check(typeof finding.counterEvidence === 'string' && finding.counterEvidence.length >= 2, 'counter evidence missing');
      for (const ref of finding.evidence ?? []) check(sources.get(ref.sourceId)?.content.includes(ref.quote) && ref.quote.length >= 2, 'source quote is not present in authorized original');
    }
    for (const recommendation of artifact.recommendations) check(recommendation.owner && recommendation.verification && recommendation.basis?.every((id) => sources.has(id)), 'action ownership, verification or source basis missing');
    const file = files.find((f) => f.stepId === step.id);
    check(file?.receipt?.synced === true && file.receipt.eventId === done.eventId, 'artifact receipt not bound to same step event');
    check(typeof file.content === 'string' && digest(file.content) === done.file.sha256 && file.sha256 === done.file.sha256 && Buffer.byteLength(file.content) === done.file.bytes, 'artifact content/hash/readback mismatch');
    if (i) check(done.priorArtifactHashes?.some((prior) => prior.stepId === run.completed[i - 1].stepId && prior.sha256 === run.completed[i - 1].file.sha256 && prior.eventId === run.completed[i - 1].eventId), 'prior artifact hash was not consumed by dependent step');
    fullText.push(JSON.stringify(artifact));
  }
  const text = fullText.join('\n');
  const contentAssertions = (task.expectAny ?? []).map((pattern) => ({ pattern, passed: new RegExp(pattern, 'u').test(text) }));
  check(contentAssertions.every((a) => a.passed), `predeclared content check failed: ${contentAssertions.filter((a) => !a.passed).map((a) => a.pattern).join(', ')}`);
  return { stateAndReceiptPassed: true, contentAssertions, artifactCount: files.length, qualityLimit: 'Deterministic structure, source quotation and task-specific checks; independent human review remains required. One sample does not establish reliable employee competence.' };
}

export function checkBudgetBindings(run, ledger) {
  check(ledger?.schemaVersion === 'eagle.deepseek-budget/v1' && ledger.frozen === false, 'live budget ledger missing or frozen');
  check(ledger.llmAttempts <= 40 && ledger.actualTokens + ledger.reservedTokens <= 300000, 'live budget hard ceiling exceeded');
  const receipts = [...(run.planModel ? [run.planModel] : []), ...run.completed.map((step) => step.model)];
  for (const model of receipts) {
    const entry = ledger.reservations.find((candidate) => candidate.id === model.reservationId);
    check(entry?.kind === 'llm' && entry.status === 'settled', 'provider receipt is not in the same settled live budget ledger');
    check(entry.receipt?.requestId === model.requestId && entry.receipt?.model === model.model
      && ['promptTokens', 'completionTokens', 'totalTokens'].every((field) => entry.receipt?.usage?.[field] === model.usage?.[field]), 'provider request/usage differs from budget settlement');
    check(model.modelMetadata?.id === 'deepseek-flash' && ['DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash-1017'].includes(model.modelMetadata?.name) && model.modelMetadata?.contextWindow === 1048576 && model.modelMetadata?.maxOutputTokens === 393216, 'live model discovery evidence missing or drifted');
    check(model.modelMetadata?.tokenizerProof?.artifactSha256 === TOKENIZER_PROOF.artifactSha256 && model.modelMetadata?.tokenizerProof?.source === TOKENIZER_PROOF.source, 'live tokenizer proof is not bound to the reviewed official artifact');
  }
  return { passed: true, settledModelRequests: receipts.length, tokenizerArtifactSha256: TOKENIZER_PROOF.artifactSha256, accounting: 'provider-reported tokens; estimated costs, separate from invoice' };
}

function parse(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--environment', '--base-url', '--out', '--run-id', '--budget-file', '--transport', '--client-state-file'].includes(key) || !argv[i + 1]) throw new Error(`unknown/missing argument ${key}`);
    values[key] = argv[++i];
  }
  check(['sandbox', 'client-runtime'].includes(values['--environment']), '--environment must be sandbox or client-runtime');
  check(values['--out'] && values['--budget-file'], '--out and --budget-file are required');
  const url = new URL(values['--base-url'] ?? 'http://127.0.0.1:8787');
  check(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'evaluation target must be a plain loopback origin');
  if (values['--environment'] === 'client-runtime') check(values['--client-state-file'], 'installed client receipt is required for client-runtime');
  return { environment: values['--environment'], baseUrl: url.origin, out: resolve(values['--out']), runId: values['--run-id'] ?? `eval-${Date.now()}-${randomUUID().slice(0, 8)}`, budgetFile: resolve(values['--budget-file']), transport: values['--transport'] ?? 'cli', clientStateFile: values['--client-state-file'] };
}

function safeError(error) {
  // Persist diagnostic codes, not subprocess stderr or provider response bodies.
  return String(error?.message ?? 'evaluation failure').replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]').replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]+/gu, '[REDACTED]').slice(0, 600);
}

function transportEnvironment(overrides = {}) {
  const env = { ...process.env, WORKLOOM_DEV_AUTO_LOGIN: '0', ...overrides };
  // CLI/MCP authenticate to the local product; only its server needs a paid
  // model credential. Repository publishing credentials have no role here.
  for (const key of ['DEEPSEEK_API_KEY', 'LLM_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[key];
  return env;
}

function cliTransport(config, catalog) {
  return async (method, input, envOverride) => {
    const descriptor = [...catalog.entries.values()].find((d) => d.transport.kind === 'trpc' && d.transport.path === `consulting.${method}`);
    check(descriptor, `shipped capability not found: consulting.${method}`);
    return new Promise((resolveCall, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/workloom-agent.mjs'), 'invoke', descriptor.id, '--input-file', '-', '--base-url', config.baseUrl], { cwd: root, env: transportEnvironment(envOverride), stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      const errors = [];
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('CLI_TIMEOUT_NO_AUTOMATIC_RETRY')); }, 150000);
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => errors.push(chunk));
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // The shipped CLI deliberately exits nonzero for a genuine blocked
          // run while still printing its structured evidence envelope. Preserve
          // that run and its provider-safe error code rather than losing the
          // failure behind a generic process error or resubmitting the task.
          try {
            const failed = JSON.parse(Buffer.concat(out).toString());
            if (failed.schemaVersion === 'workloom.capability-result/v1' && failed.status === 'failed' && failed.result?.status === 'blocked') {
              failed.result.evaluationTransportExitCode = code;
              resolveCall(failed);
              return;
            }
          } catch { /* Only structured result envelopes are retained. */ }
          let label = 'CLI_FAILED';
          try { label = JSON.parse(Buffer.concat(errors).toString()).error?.code ?? label; } catch { /* Raw stderr may contain credentials; omit it. */ }
          reject(new Error(`${label} (exit ${code})`));
          return;
        }
        try { resolveCall(JSON.parse(Buffer.concat(out).toString())); } catch { reject(new Error('CLI_INVALID_JSON')); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  };
}

async function mcpTransport(config, catalog) {
  const child = spawn(process.execPath, [join(root, 'scripts/workloom-agent-mcp.mjs')], { cwd: root, env: transportEnvironment({ WORKLOOM_BASE_URL: config.baseUrl }), stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0;
  let buffer = '';
  const pending = new Map();
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      const item = pending.get(value.id);
      if (item) { clearTimeout(item.timer); pending.delete(value.id); value.error ? item.reject(new Error('MCP_PROTOCOL_ERROR')) : item.resolve(value.result); }
    }
  });
  child.on('exit', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('MCP_EXITED')); } pending.clear(); });
  function request(method, params) {
    return new Promise((resolveCall, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('MCP_TIMEOUT_NO_AUTOMATIC_RETRY')); }, 150000);
      pending.set(requestId, { resolve: resolveCall, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eagle-real-evaluation', version: '1.0.0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const available = await request('tools/list', {});
  const invoke = async (method, input) => {
    const descriptor = [...catalog.entries.values()].find((d) => d.transport.kind === 'trpc' && d.transport.path === `consulting.${method}`);
    check(descriptor && available.tools.some((t) => t.name === toolName(descriptor)), `shipped MCP tool missing consulting.${method}`);
    const out = await request('tools/call', { name: toolName(descriptor), arguments: input });
    if (out.isError) {
      const failed = out.structuredContent;
      if (failed?.schemaVersion === 'workloom.capability-result/v1' && failed.status === 'failed' && failed.result?.status === 'blocked') return failed;
      let label = 'MCP_TOOL_FAILED';
      try { label = JSON.parse(out.content?.find((c) => c.type === 'text')?.text).error?.code ?? label; } catch { /* Only save the safe error code. */ }
      throw new Error(label);
    }
    return JSON.parse(out.content.find((c) => c.type === 'text').text);
  };
  return { invoke, initialized, close: () => { child.stdin.end(); child.kill('SIGTERM'); } };
}

function unwrap(value) { return value?.schemaVersion === 'workloom.capability-result/v1' ? value.result : value; }

async function main(argv) {
  const config = parse(argv);
  try {
    await readFile(join(config.out, 'report.json'));
    throw new Error('EVALUATION_OUTPUT_EXISTS: use a new output directory to preserve earlier run evidence');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const planFile = join(root, 'acceptance/consulting/tasks.json');
  const planText = await readFile(planFile, 'utf8');
  const plan = JSON.parse(planText);
  const catalog = await loadCatalog(root, 'consulting');
  check(plan.singleTasks.length === 22 && new Set(plan.singleTasks.map((t) => t.employeeKey)).size === 22, 'evaluation plan does not cover all 22 employees');
  const report = { schemaVersion: 'eagle.consulting-evaluation-report/v1', runId: config.runId, environment: config.environment, baseUrl: config.baseUrl, transport: config.transport, startedAt: new Date().toISOString(), planSha256: digest(planText), dataClassification: plan.dataClassification, disclosure: plan.disclosure, revisionDisclosure: plan.revisionDisclosure ?? null, statisticalLimit: plan.statisticalLimit, status: 'running', tasks: [], negativeTests: [], budget: null, fingerprint: {} };
  await mkdir(join(config.out, 'transcripts'), { recursive: true });
  await mkdir(join(config.out, 'artifacts'), { recursive: true });
  const writeReport = () => writeFile(join(config.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  let close = () => {};
  let invoke;
  try {
    const health = await fetch(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
    check(health.ok, 'target health failed');
    report.fingerprint.healthStatus = health.status;
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    report.fingerprint.sourceHead = git.status === 0 ? git.stdout.trim() : null;
    report.fingerprint.sourceFiles = {};
    for (const file of ['bundles/consulting/connectors/deepseek.mjs', 'apps/server/src/industry/consulting/workflow.ts', 'apps/server/src/industry/consulting/workflow-core.ts']) report.fingerprint.sourceFiles[file] = digest(await readFile(join(root, file)));
    if (config.clientStateFile) {
      const raw = await readFile(config.clientStateFile, 'utf8');
      const state = JSON.parse(raw);
      check(state.schemaVersion === 'workloom.install-state/v1' && state.status === 'complete' && state.phase === 'ready', 'installed client receipt is not complete/ready');
      report.fingerprint.installedClient = { sha256: digest(raw), schemaVersion: state.schemaVersion, targetVersion: state.targetVersion, status: state.status, phase: state.phase, updatedAt: state.updatedAt };
    }
    const cli = cliTransport(config, catalog);
    if (config.transport === 'mcp') { const mcp = await mcpTransport(config, catalog); invoke = mcp.invoke; close = mcp.close; report.fingerprint.mcp = mcp.initialized; }
    else { check(config.transport === 'cli', 'transport must be cli or mcp'); invoke = cli; }
    const remote = unwrap(await invoke('catalog', {}));
    check(remote.employees.length === 22 && plan.singleTasks.every((t) => remote.employees.some((e) => e.key === t.employeeKey)), 'actual workforce differs from evaluation matrix');
    report.fingerprint.workforceFingerprint = remote.workforceFingerprint;
    report.budgetBefore = remote.budget;
    const persisted = JSON.parse(await readFile(config.budgetFile, 'utf8'));
    check(persisted.startedAt === remote.budget.startedAt && persisted.llmAttempts === remote.budget.llmAttempts, 'target is not using the specified shared budget ledger');
    let negative;
    try { await cli('catalog', {}, { WORKLOOM_ACCESS_TOKEN: '', WORKLOOM_DESKTOP_SESSION_SECRET: '', WORKLOOM_KEYCHAIN_ACCESS: '0' }); negative = false; } catch (error) { negative = /UNAUTHORIZED|FORBIDDEN/.test(error.message); }
    report.negativeTests.push({ id: 'NO-CREDENTIAL', precondition: 'access token and installation session secret removed from this child; Keychain lookup disabled', expected: 'access rejected, no model call', passed: negative });
    check(negative, 'no-credential negative probe did not fail closed');
    const stage = plan.environments[config.environment];
    const tasks = [...plan.singleTasks.filter((task) => stage.singleEmployeeKeys === 'all' || stage.singleEmployeeKeys.includes(task.employeeKey)), plan.complexTask];
    for (const task of tasks) {
      const record = { id: task.id, employeeKey: task.employeeKey ?? null, status: 'running', precondition: 'isolated, explicitly marked evaluation-only dossier; real provider and one shared persisted budget', goal: task.goal, expected: task.employeeKey ? 'one selected employee, substantive cited internal draft, real model usage, real event/file receipt' : 'one real model plan plus six ordered distinct employees, persistent dependency receipts, independent final quality review', steps: [], startedAt: new Date().toISOString() };
      report.tasks.push(record);
      try {
        const enterpriseId = `eval-${digest(`${config.runId}:${task.id}`).slice(0, 24)}`;
        const sources = plan.sources.filter((source) => task.sourceIds.includes(source.id));
        record.dossier = unwrap(await invoke('dossierPut', { enterpriseId, sources, idempotencyKey: `${config.runId}:${task.id}:dossier` }));
        let run = unwrap(await invoke('submit', { enterpriseId, goal: task.goal, ...(task.employeeKey ? { employeeKey: task.employeeKey } : {}), idempotencyKey: `${config.runId}:${task.id}:submit` }));
        record.runId = run.id;
        record.lastObservedRun = run;
        check(['queued', 'draft_ready'].includes(run.status), `submit blocked: ${run.error?.code ?? run.status}`);
        record.reusedCompletedSteps = run.completed.map((step) => ({ stepId: step.stepId, eventId: step.eventId, artifactSha256: step.file.sha256, modelRequestId: step.model.requestId }));
        record.initialPlan = { steps: run.steps, rationale: run.rationale, planModel: run.planModel, planReceipt: run.planReceipt };
        // Same business idempotency keys can be resumed into a NEW evidence
        // directory. Already completed, hash-verified steps are read back, never
        // re-inferred; this also permits safe checker fixes without buying the
        // same successful model answer twice.
        for (let i = run.completed.length; i < run.steps.length; i++) {
          const key = `${config.runId}:${task.id}:advance:${i}`;
          run = unwrap(await invoke('advance', { runId: run.id, idempotencyKey: key }));
          record.lastObservedRun = run;
          check(run.completed.length === i + 1, `step ${i + 1} failed: ${run.error?.code ?? run.status}`);
          const budgetBeforeRepeat = unwrap(await invoke('catalog', {})).budget;
          const repeated = unwrap(await invoke('advance', { runId: run.id, idempotencyKey: key }));
          const budgetAfterRepeat = unwrap(await invoke('catalog', {})).budget;
          check(repeated.completed.length === run.completed.length && budgetBeforeRepeat.llmAttempts === budgetAfterRepeat.llmAttempts, 'idempotent repeat caused another model call');
          record.steps.push({ stepId: run.steps[i].id, employeeKey: run.steps[i].employeeKey, realModelRequestId: run.completed[i].model.requestId, idempotencyPassed: true });
          if (!task.employeeKey && i === 1 && [...catalog.entries.values()].some((d) => d.transport.path === 'consulting.pause')) {
            const paused = unwrap(await invoke('pause', { runId: run.id, idempotencyKey: `${config.runId}:${task.id}:pause` }));
            check(paused.status === 'paused', 'pause not persisted');
            const reread = unwrap(await invoke('get', { runId: run.id }));
            check(reread.status === 'paused' && reread.completed.length === 2, 'pause readback lost progress');
            run = unwrap(await invoke('resume', { runId: run.id, idempotencyKey: `${config.runId}:${task.id}:resume` }));
            check(run.status === 'queued' && run.completed.length === 2, 'resume failed to preserve progress');
            record.pauseResumePassed = true;
          }
        }
        run = unwrap(await invoke('get', { runId: run.id }));
        const files = [];
        for (const step of run.steps) {
          const file = unwrap(await invoke('artifact', { runId: run.id, stepId: step.id }));
          files.push(file);
          await writeFile(join(config.out, 'artifacts', `${task.id}-${step.id}.md`), file.content, { mode: 0o600 });
        }
        record.assertions = checkArtifact(run, task, files);
        record.budgetBindings = checkBudgetBindings(run, JSON.parse(await readFile(config.budgetFile, 'utf8')));
        record.finalRun = run;
        record.status = 'passed';
        record.actual = 'internal draft, source quotation, model usage, event receipt and file hash readback met the predeclared assertions';
      } catch (error) { record.status = 'failed'; record.error = safeError(error); }
      record.finishedAt = new Date().toISOString();
      await writeFile(join(config.out, 'transcripts', `${task.id}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      report.budget = JSON.parse(await readFile(config.budgetFile, 'utf8'));
      await writeReport();
      process.stdout.write(`${JSON.stringify({ id: task.id, status: record.status, error: record.error ?? null, llmAttempts: report.budget.llmAttempts, actualTokens: report.budget.actualTokens })}\n`);
      if (report.budget.frozen) throw new Error(`BUDGET_FROZEN: ${report.budget.freezeReason}`);
    }
    report.status = report.tasks.every((t) => t.status === 'passed') && report.negativeTests.every((t) => t.passed) ? 'passed' : 'failed';
    report.coverage = { tasksPlanned: tasks.length, tasksExecuted: report.tasks.length, tasksPassed: report.tasks.filter((t) => t.status === 'passed').length, employeesPlanned: tasks.filter((t) => t.employeeKey).length, employeeClaims: 'one observed task each, not a statistical competency certification', complexRunsPlanned: 1, complexRunsPassed: report.tasks.filter((t) => !t.employeeKey && t.status === 'passed').length };
  } catch (error) { report.status = 'failed'; report.error = safeError(error); }
  finally { close(); report.finishedAt = new Date().toISOString(); await writeReport(); }
  process.stdout.write(`${JSON.stringify({ report: join(config.out, 'report.json'), status: report.status, coverage: report.coverage ?? null })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
}
