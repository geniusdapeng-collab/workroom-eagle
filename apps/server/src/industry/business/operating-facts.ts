import { z } from "zod";
import { maskText } from "@workloom/base/workdata";
import { containsCredential, canonical, sha256 } from "../consulting/workflow-core.js";

export class OperatingError extends Error {
  constructor(public readonly code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "UNPROCESSABLE_CONTENT", message: string) {
    super(message);
    this.name = "OperatingError";
  }
}

export const businessDateInput = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value < "1900-01-01" || value > "9999-12-31") return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}, "业务日期必须是有效的 YYYY-MM-DD");
export const dateTimeInput = z.string().datetime({ offset: true });
export const operatingKey = z.string().trim().min(8).max(128);
export const referenceInput = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u);
const textInput = z.string().trim().min(1).max(600);
const amountInput = z.number().int().nonnegative().max(100_000_000_000);
const factBase = {
  occurredOn: businessDateInput,
  accountRef: referenceInput,
  dealRef: referenceInput,
  ownerMemberId: referenceInput.optional(),
  sourceKind: z.enum(["manual", "crm", "finance"]).default("manual"),
  sourceRef: referenceInput.optional(),
  supersedesFactId: z.string().uuid().optional(),
  note: textInput.optional(),
};
export const operatingFactInput = z.discriminatedUnion("kind", [
  z.object({ ...factBase, kind: z.literal("lead"), channel: z.string().trim().min(1).max(80), qualified: z.boolean() }).strict(),
  z.object({ ...factBase, kind: z.literal("interaction"), note: textInput }).strict(),
  z.object({ ...factBase, kind: z.literal("opportunity"), stage: z.enum(["qualified", "proposal", "evaluation", "negotiation", "won", "lost"]) }).strict(),
  z.object({ ...factBase, kind: z.literal("contract"), amountMinor: amountInput, customerType: z.enum(["new", "existing", "unknown"]) }).strict(),
  z.object({ ...factBase, kind: z.literal("invoice"), invoiceRef: referenceInput, amountMinor: amountInput, dueOn: businessDateInput }).strict(),
  z.object({ ...factBase, kind: z.literal("payment"), invoiceRef: referenceInput, amountMinor: amountInput }).strict(),
  z.object({ ...factBase, kind: z.literal("delivery_cost"), amountMinor: amountInput }).strict(),
  z.object({ ...factBase, kind: z.literal("deal_outcome"), outcome: z.enum(["won", "lost"]), competitor: z.string().trim().min(1).max(80).optional(), reason: textInput }).strict(),
  z.object({ ...factBase, kind: z.literal("commitment"), commitmentRef: referenceInput, state: z.enum(["open", "delivered"]), dueOn: businessDateInput }).strict(),
]);
export type OperatingFactInput = z.output<typeof operatingFactInput>;
export type OperatingFact = OperatingFactInput & { id: string; ownerMemberId: string; recordedAt: string };
export type NormalizedFact = OperatingFactInput & { ownerMemberId: string };

const capture = z.object({ rows: z.array(operatingFactInput).min(1).max(200).optional(), csv: z.string().min(1).max(128_000).optional() }).strict();
const hasSingleInput = (v: { rows?: unknown; csv?: unknown }) => (v.rows === undefined) !== (v.csv === undefined);
export const previewFactsInput = capture.refine(hasSingleInput, "必须提供 rows 或 csv 其中一种");
export const confirmFactsInput = capture.extend({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/u), idempotencyKey: operatingKey }).refine(hasSingleInput, "必须提供 rows 或 csv 其中一种");
export type CaptureInput = z.output<typeof previewFactsInput>;

const csvColumns = new Set(["kind", "occurredOn", "accountRef", "dealRef", "ownerMemberId", "sourceKind", "sourceRef", "supersedesFactId", "note", "channel", "qualified", "stage", "amountMinor", "customerType", "invoiceRef", "dueOn", "outcome", "competitor", "reason", "commitmentRef", "state"]);

function invalidCsv(message: string): never {
  throw new OperatingError("BAD_REQUEST", message);
}

function csvRows(csv: string): string[][] {
  const source = csv.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (state === "quoted") {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') state = "closed";
      else field += character;
      continue;
    }
    if (character === "," || character === "\n") {
      row.push(field);
      field = "";
      state = "plain";
      if (character === "\n") {
        if (row.some((column) => column.trim())) rows.push(row);
        row = [];
        if (rows.length > 201) invalidCsv("每批最多 200 条事实");
      }
      continue;
    }
    if (state === "closed") invalidCsv("CSV 引号后的字符无效");
    if (character === '"') {
      if (field.length) invalidCsv("CSV 引号应位于字段开头");
      state = "quoted";
    } else field += character;
  }
  if (state === "quoted") invalidCsv("CSV 存在未闭合的字段");
  row.push(field);
  if (row.some((column) => column.trim())) rows.push(row);
  if (rows.length < 2 || rows.length > 201) invalidCsv("CSV 须包含表头和 1 至 200 条事实");
  return rows;
}

export function parseOperatingCsv(csv: string): OperatingFactInput[] {
  const [headers, ...rows] = csvRows(csv);
  const names = headers!.map((value) => value.trim());
  if (new Set(names).size !== names.length || names.some((name) => !csvColumns.has(name))) invalidCsv("CSV 表头含未知或重复字段");
  return rows.map((row, index) => {
    if (row.length !== names.length) invalidCsv(`CSV 第 ${index + 2} 行的字段数与表头不一致`);
    const cells: Record<string, unknown> = {};
    for (const [column, raw] of row.entries()) {
      const value = raw.trim();
      if (!value) continue;
      const name = names[column]!;
      if (name === "amountMinor" && /^\d+$/u.test(value)) cells[name] = Number(value);
      else if (name === "qualified" && (value === "true" || value === "false")) cells[name] = value === "true";
      else cells[name] = value;
    }
    const parsed = operatingFactInput.safeParse(cells);
    if (!parsed.success) invalidCsv(`CSV 第 ${index + 2} 行字段或格式不符合事实类型`);
    return parsed.data;
  });
}

function rejectOperatingCredentials(value: string): void {
  if (containsCredential(value)) throw new OperatingError("BAD_REQUEST", "经营记录不得包含凭据");
}
export function cleanOperatingText(value: string): string {
  rejectOperatingCredentials(value);
  return maskText(value).text;
}

export function normalizeCapture(input: CaptureInput, actor: { memberId: string; manager: boolean }) {
  if (input.csv !== undefined && !actor.manager) throw new OperatingError("FORBIDDEN", "仅主管可以批量导入 CSV");
  const provided = input.csv === undefined ? input.rows! : parseOperatingCsv(input.csv);
  if (!actor.manager && provided.length !== 1) throw new OperatingError("FORBIDDEN", "销售每次确认一条本人记录");
  const externalKeys = new Set<string>();
  const invoiceRefs = new Set<string>();
  const superseded = new Set<string>();
  const subjects = new Map<string, string>();
  const rows: NormalizedFact[] = provided.map((row) => {
    const ownerMemberId = row.ownerMemberId ?? actor.memberId;
    if (!actor.manager && (ownerMemberId !== actor.memberId || row.sourceKind !== "manual" || ["contract", "invoice", "payment", "delivery_cost"].includes(row.kind))) {
      throw new OperatingError("FORBIDDEN", "销售仅可提交本人确认的过程记录");
    }
    if (row.sourceKind !== "manual" && !row.sourceRef) throw new OperatingError("BAD_REQUEST", "CRM 或财务导入须填写来源记录 ID");
    if (row.kind === "invoice" && row.dueOn < row.occurredOn) throw new OperatingError("BAD_REQUEST", "应收截止日期不能早于开票日期");
    if (row.sourceRef) {
      const key = canonical([row.kind, row.sourceKind, row.sourceRef]);
      if (externalKeys.has(key)) throw new OperatingError("CONFLICT", "同一批次有重复来源记录");
      externalKeys.add(key);
    }
    if (row.kind === "invoice") {
      if (invoiceRefs.has(row.invoiceRef)) throw new OperatingError("CONFLICT", "同一批次有重复应收编号");
      invoiceRefs.add(row.invoiceRef);
    }
    if (row.supersedesFactId) {
      if (superseded.has(row.supersedesFactId)) throw new OperatingError("CONFLICT", "同一事实仅可在一次确认中更正一次");
      superseded.add(row.supersedesFactId);
    }
    const priorAccount = subjects.get(row.dealRef);
    if (priorAccount && priorAccount !== row.accountRef) throw new OperatingError("CONFLICT", "同批次同一商机必须关联同一客户");
    subjects.set(row.dealRef, row.accountRef);
    rejectOperatingCredentials(canonical(row));
    for (const value of [row.accountRef, row.dealRef, row.sourceRef, row.kind === "invoice" || row.kind === "payment" ? row.invoiceRef : undefined, row.kind === "commitment" ? row.commitmentRef : undefined]) {
      if (value && maskText(value).hits) throw new OperatingError("BAD_REQUEST", "业务引用须使用系统内编号，不能使用个人号码");
    }
    const base = { ownerMemberId, ...(row.note ? { note: cleanOperatingText(row.note) } : {}) };
    if (row.kind === "lead") return { ...row, ...base, channel: cleanOperatingText(row.channel) };
    if (row.kind === "deal_outcome") return { ...row, ...base, reason: cleanOperatingText(row.reason), ...(row.competitor ? { competitor: cleanOperatingText(row.competitor) } : {}) };
    if (row.kind === "interaction") return { ...row, ...base, note: cleanOperatingText(row.note) };
    return { ...row, ...base };
  });
  return { rows, previewDigest: sha256(canonical(rows)) };
}
