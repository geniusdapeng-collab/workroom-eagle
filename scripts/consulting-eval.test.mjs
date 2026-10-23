import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkArtifact, checkBudgetBindings } from './consulting-eval.mjs';
import { TOKENIZER_PROOF } from '../bundles/consulting/connectors/deepseek.mjs';

function fixture() {
  const content = '# Internal draft\n\nS1 source quote; human review required.';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const artifact = { summary: '有依据的内部草稿', findings: [{ claim: '材料不足，不能定调', evidence: [{ sourceId: 'S1', quote: 'source quote' }], counterEvidence: '缺少独立取数' }], recommendations: [{ action: '核实原始凭证', basis: ['S1'], owner: '主理人', verification: '原始凭证与数据勾稽' }], missingEvidence: ['原始凭证'], humanReviewRequired: true };
  const run = { status: 'draft_ready', humanReviewRequired: true, sources: [{ id: 'S1', content: 'Authorized source quote.' }], steps: [{ id: 's1', employeeKey: 'diagnosis-analyst', dependsOn: [] }], completed: [{ stepId: 's1', artifact, model: { provider: 'deepseek', model: 'deepseek-flash', requestId: 'ds1', reservationId: 'reservation1', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }, eventId: 'ev1', hash: 'a'.repeat(64), file: { sha256, bytes: Buffer.byteLength(content) } }] };
  const files = [{ stepId: 's1', content, sha256, receipt: { eventId: 'ev1', synced: true } }];
  return { run, files, task: { employeeKey: 'diagnosis-analyst', expectAny: ['依据|材料不足'] } };
}

test('evaluation verifies source quotes, event identity, real usage and readable file hashes together', () => {
  const { run, task, files } = fixture();
  assert.equal(checkArtifact(run, task, files).stateAndReceiptPassed, true);
});

test('completion status or matching keyword alone cannot fake evaluation success', () => {
  for (const change of [
    ({ run }) => { run.completed[0].model.provider = 'mock'; },
    ({ run }) => { run.completed[0].model.usage.totalTokens = 0; },
    ({ run }) => { run.completed[0].artifact.findings[0].evidence[0].quote = 'invented quote'; },
    ({ files }) => { files[0].content += 'tampered'; },
    ({ files }) => { files[0].receipt.eventId = 'other-thread'; },
    ({ run }) => { run.completed[0].artifact.humanReviewRequired = false; },
    ({ run }) => { run.steps[0].employeeKey = 'other-employee'; },
  ]) {
    const data = fixture(); change(data);
    assert.throws(() => checkArtifact(data.run, data.task, data.files));
  }
});

test('task-specific arithmetic expectations fail independently of structural validity', () => {
  const data = fixture();
  assert.throws(() => checkArtifact(data.run, { ...data.task, expectAny: ['25[%％]'] }, data.files), /predeclared content check failed/);
});

test('evaluation matrix explicitly covers all employees, stays isolated and fits dossier limits', () => {
  const plan = JSON.parse(readFileSync(new URL('../acceptance/consulting/tasks.json', import.meta.url), 'utf8'));
  assert.equal(plan.dataClassification, 'evaluation-fixture-only');
  assert.equal(plan.singleTasks.length, 22);
  assert.equal(new Set(plan.singleTasks.map((t) => t.employeeKey)).size, 22);
  assert.ok(Buffer.byteLength(JSON.stringify(plan.sources)) <= 4000);
  assert.equal(plan.environments.sandbox.expectedMaxLlmCalls + plan.environments['client-runtime'].expectedMaxLlmCalls + plan.revisionDisclosure.initialFailedLlmCalls, 40);
  for (const task of plan.singleTasks) {
    assert.ok(task.sourceIds.every((id) => plan.sources.some((source) => source.id === id)));
    for (const pattern of task.expectAny) assert.doesNotThrow(() => new RegExp(pattern, 'u'));
  }
});

test('live claims must bind every model receipt to the same settled budget and official tokenizer proof', () => {
  const { run } = fixture();
  run.completed[0].model.modelMetadata = { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, maxOutputTokens: 393216, tokenizerProof: TOKENIZER_PROOF };
  const ledger = { schemaVersion: 'eagle.deepseek-budget/v1', frozen: false, llmAttempts: 1, actualTokens: 30, reservedTokens: 0, reservations: [{ id: 'reservation1', kind: 'llm', status: 'settled', receipt: { requestId: 'ds1', model: 'deepseek-flash', usage: run.completed[0].model.usage } }] };
  assert.equal(checkBudgetBindings(run, ledger).settledModelRequests, 1);
  const reordered = structuredClone(run);
  reordered.completed[0].model.usage = { totalTokens: 30, completionTokens: 20, promptTokens: 10 };
  assert.equal(checkBudgetBindings(reordered, ledger).settledModelRequests, 1, 'PostgreSQL JSONB key reordering preserves usage meaning');
  assert.throws(() => checkBudgetBindings(run, { ...ledger, reservations: [] }), /same settled live budget/);
  assert.throws(() => checkBudgetBindings(run, { ...ledger, frozen: true }), /missing or frozen/);
  run.completed[0].model.modelMetadata.tokenizerProof = { ...TOKENIZER_PROOF, artifactSha256: '0'.repeat(64) };
  assert.throws(() => checkBudgetBindings(run, ledger), /not bound/);
});
