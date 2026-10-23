export function checkArtifact(run: unknown, task: {
  employeeKey?: string; expectAny?: string[]; stepCount?: number;
  requiredFirst?: string; requiredPenultimate?: string; requiredLast?: string;
}, files: unknown[]): {
  stateAndReceiptPassed: boolean; contentAssertions: Array<{ pattern: string; passed: boolean }>;
  artifactCount: number; qualityLimit: string;
};
export function checkBudgetBindings(run: unknown, ledger: unknown): {
  passed: boolean; settledModelRequests: number; tokenizerArtifactSha256: string; accounting: string;
};
