import { clientNaturalText } from "../../lib/clientText";

export type ConsultingTaskStatus = "queued" | "collecting_sources" | "planning" | "working" | "draft_ready" | "blocked" | "human_required" | "cancelled";
export type ConsultingTaskAction = "resume" | "handoff" | "cancel";
export interface TaskReceipt { eventId: string; hash: string; synced: boolean }
export interface TaskSource {
  id: string; title: string; url: string; publishedAt: string | null; retrievedAt: string;
  sha256: string; excerptSha256: string; excerptRanges: Array<{ startByte: number; endByte: number }>;
  fullBytes: number; excerptBytes: number;
}
export interface ReportDescriptor { kind: "report"; sha256: string; bytes: number; eventId: string; hash: string; synced: boolean }
export interface ConsultingTaskView {
  threadId: string; runId: string | null; status: ConsultingTaskStatus; phase: string;
  stepsDone: number; stepsTotal: number; humanReviewRequired: boolean; sourceMode: "public-web";
  sources: TaskSource[]; finalArtifact: ReportDescriptor | null; error: { code: string; message: string } | null;
  availableActions: Record<ConsultingTaskAction, { enabled: boolean; reason: string | null }>;
  lastReceipt?: TaskReceipt | null;
  actionReceipt?: TaskReceipt;
}
export interface TaskReport {
  threadId: string; runId: string; content: string; sha256: string; bytes: number;
  receipt: TaskReceipt; humanReviewRequired: boolean;
}

const TASK_STATUS: Record<ConsultingTaskStatus, string> = {
  queued: "等待执行", collecting_sources: "正在收集公开资料", planning: "正在制定分析计划",
  working: "正在分析材料", draft_ready: "内部报告草稿已生成", blocked: "任务执行未完成",
  human_required: "等待人工处理", cancelled: "任务已停止",
};
export function consultingTaskStatusText(status: string): string {
  return TASK_STATUS[status as ConsultingTaskStatus] ?? "任务状态待确认";
}
export function taskNaturalText(value: unknown, fallback: string): string {
  return clientNaturalText(value, fallback);
}
export function sourceHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function hasTaskReceipt(receipt: TaskReceipt | null | undefined): receipt is TaskReceipt {
  return receipt?.synced === true && typeof receipt.eventId === "string" && receipt.eventId.length > 0
    && /^[a-f0-9]{64}$/i.test(receipt.hash);
}
export class ReportIntegrityError extends Error {
  constructor() { super("报告校验未通过，内容与已记录产物不一致；请刷新任务后重试。"); }
}
/** Only verified response bytes may be shown or downloaded; file paths are never accepted. */
export async function verifyTaskReport(view: ConsultingTaskView, report: TaskReport): Promise<TaskReport> {
  const expected = view.finalArtifact;
  if (!expected || expected.synced !== true || report.threadId !== view.threadId || report.runId !== view.runId
      || typeof report.content !== "string" || report.humanReviewRequired !== true
      || !hasTaskReceipt(report.receipt) || report.receipt.eventId !== expected.eventId || report.receipt.hash !== expected.hash
      || report.sha256 !== expected.sha256 || report.bytes !== expected.bytes || !/^[a-f0-9]{64}$/i.test(expected.sha256)) throw new ReportIntegrityError();
  const bytes = new TextEncoder().encode(report.content);
  if (bytes.byteLength !== expected.bytes) throw new ReportIntegrityError();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected.sha256) throw new ReportIntegrityError();
  return report;
}
