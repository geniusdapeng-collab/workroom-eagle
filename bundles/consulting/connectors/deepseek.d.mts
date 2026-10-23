export class DeepSeekError extends Error { code: string; retryable: false; constructor(code: string, detail?: string); }
export const DEEPSEEK_MODEL: 'deepseek-flash';
export const DEEPSEEK_MAX_INPUT_BYTES: 64000;
export const DEEPSEEK_BUDGET_LIMITS: Readonly<DeepSeekBudgetPolicy>;
export const TOKENIZER_PROOF: Readonly<{ source: string; artifactSha256: string; reviewedOn: string; modelVersion: string; algorithm: string; framingAllowance: number }>;
export function inputTokenUpperBound(system?: string, prompt?: string): number;
export interface DeepSeekUsage { promptTokens: number; completionTokens: number; totalTokens: number; }
export interface DeepSeekBudgetPolicy { maxLlmCalls: number; maxLlmTokens: number; maxCostCny: number; maxWallClockMin: number; maxSearchCalls: number; maxFetchCalls: number; }
export interface DeepSeekBudget {
  schemaVersion: 'eagle.deepseek-budget/v1'; policy: DeepSeekBudgetPolicy; startedAt: number;
  llmAttempts: number; searchAttempts: number; fetchAttempts: number; actualTokens: number; reservedTokens: number;
  actualCostCny: number; reservedCostCny: number; frozen: boolean; freezeReason: string | null;
  reservations: Array<{ id: string; kind: 'llm' | 'search' | 'fetch'; tokens: number; estimatedCostCny: number; pid: number; status: 'pending' | 'unknown' | 'settled'; reservedAt: number; actualTokens?: number; estimatedActualCostCny?: number; receipt?: Record<string, unknown> }>;
  tokenizerProof: typeof TOKENIZER_PROOF;
}
export interface DeepSeekMetadata { id: string; name: string; contextWindow: number; maxOutputTokens: number; verifiedAt: string; tokenizerProof: typeof TOKENIZER_PROOF; }
export interface DeepSeekCompletion { text: string; model: 'deepseek-flash'; requestedModel: 'deepseek-flash'; provider: 'deepseek'; requestId: string; usage: DeepSeekUsage; finishReason: 'stop'; reservationId: string; modelMetadata: DeepSeekMetadata; }
export interface DeepSeekSearchResult { title: string; url: string; summary: string; snippet: string; date: string | null; authority: number; }
export interface DeepSeekClient {
  complete(input: { system?: string; prompt: string; maxTokens?: number; signal?: AbortSignal; jsonMode?: boolean }): Promise<DeepSeekCompletion>;
  verifyModel(signal?: AbortSignal): Promise<DeepSeekMetadata>;
  search(input: { query: string; count?: number; signal?: AbortSignal }): Promise<{ results: DeepSeekSearchResult[]; verified: boolean; provider: 'deepseek'; retrievedAt: string; reservationId: string }>;
  fetchPage(input: { url: string; signal?: AbortSignal }): Promise<{ title: string; content: string; url: string; provider: 'deepseek'; retrievedAt: string; reservationId: string }>;
  getBudget(): DeepSeekBudget;
}
export function createDeepSeekClient(options?: { apiKey?: string; baseUrl?: string; model?: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number; budgetFile?: string; budget?: Partial<DeepSeekBudgetPolicy> }): DeepSeekClient;
export function getDefaultDeepSeekClient(): DeepSeekClient;
export function getDeepSeekClientForTask(taskIdentity: string): DeepSeekClient;
export function getDeepSeekBudgetStatus(): ({ scope: 'explicit-shared-evaluation' } & DeepSeekBudget) | { scope: 'per-business-task'; policy: DeepSeekBudgetPolicy; note: string };
