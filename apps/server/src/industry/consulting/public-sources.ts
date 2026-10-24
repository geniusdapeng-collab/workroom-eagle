/** Official public research inputs. Returned page bytes are immutable; model excerpts are explicit, bounded views. */
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { maskText } from "@workloom/base/workdata";
import type { DeepSeekClient, DeepSeekSearchResult } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { ConsultingError, assertNoCredentials, canonical, sha256, validateSources, type Source } from "./workflow-core.js";
import type { DraftFile, Scope } from "./workflow.js";

const MAX_PAGE_BYTES = 400000;
const MAX_FETCHES = 3;
const SOURCE_WINDOW_BYTES = 4000;
const SAFE_THREAD = /^T-[A-Za-z0-9_-]{1,110}$/;
const SHA = /^[a-f0-9]{64}$/;
const SENSITIVE_QUERY_KEY = /^(?:app[_-]?(?:secret|key)|access[_-]?token|token|api[_-]?key|key|(?:client[_-]?)?secret|authorization|signature|password|passwd|credential|redirect|redirect_uri|return_url|target_url|callback)$/i;
export const PUBLIC_SOURCE_DISCLOSURE = "完整网页返回正文已在本机不可变冻结。模型仅使用按议题词、数字、报告期间及风险提示选取的原文摘录；含个人信息的候选整段排除，不改写成所谓原文引文。每段均披露 UTF-8 字节范围，未声称模型通读完整网页。官网来源不等于独立审计，历史完成值、未来目标和分析推断须分别标注。";

export function assertOfficialPublicUrl(raw: string): string {
  if (typeof raw !== "string" || raw.length > 8192) throw new ConsultingError("PUBLIC_SOURCE_URL_INVALID", "公开来源 URL 无效");
  assertNoCredentials(raw);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new ConsultingError("PUBLIC_SOURCE_URL_INVALID", "公开来源必须是完整的 HTTPS 官网地址"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*gov\.cn$/.test(host)
    || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) {
    throw new ConsultingError("PUBLIC_SOURCE_URL_INVALID", "只读取无登录凭据、默认 HTTPS 端口的中国政府官网公开页面；不访问本机、任意域名或带令牌的接口");
  }
  return url.href;
}

function publicTopic(goal: string): string {
  return goal.normalize("NFKC").replace(/[\r\n\t]+/g, " ")
    .replace(/(?:请|帮我|为我|给我|做一[个份]|一份|制作|撰写|生成|提供|出一份|分析报告|研究报告|调研报告|简报)/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()
    .replace(/^(?:(?:写|做|分析|研究|调研|了解|一下|详细|关于|针对|围绕|对)\s*)+/u, "");
}
export function buildPublicResearchQuery(goal: string): string {
  assertNoCredentials(goal);
  if (maskText(goal).text !== goal || /\[PII:/i.test(goal)) {
    throw new ConsultingError("PUBLIC_QUERY_SENSITIVE", "公开搜索议题含个人信息或脱敏标记；请只提交公开地区与行业问题，未向检索服务发送该内容");
  }
  const topic = publicTopic(goal);
  const year = /(?:19|20)\d{2}/u.test(topic) ? "" : ` ${new Date().getUTCFullYear()}年`;
  const query = `${topic}${year} 官方 统计 产业 site:gov.cn`;
  if ([...topic].length < 2 || [...query].length > 128) {
    throw new ConsultingError("PUBLIC_QUERY_INVALID", "公开研究议题须能表达为 2–100 字的公开地区、行业与问题；请拆分过长议题，系统没有截断原目标");
  }
  return query;
}

export interface FrozenSearch {
  query: string;
  goalHash: string;
  results: DeepSeekSearchResult[];
  provider: "deepseek";
  retrievedAt: string;
  reservationId: string;
  file: DraftFile;
}
export interface FrozenPublicSource {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  publicationDateSource: "page-text" | "search-result" | "unknown";
  retrievedAt: string;
  provider: "deepseek";
  reservationId: string;
  sha256: string;
  fullBytes: number;
  file: DraftFile;
}
export interface SelectedPublicSource extends FrozenPublicSource {
  excerptSha256: string;
  excerptBytes: number;
  excerptRanges: Array<{ startByte: number; endByte: number }>;
}
export interface SourceCollectionCheckpoint { search: FrozenSearch | null; sources: FrozenPublicSource[] }
export interface SourceCollectionJournal {
  read(): Promise<SourceCollectionCheckpoint>;
  /** The task-control check and durable operation claim precede every external call. */
  beforeCall(operation: { id: string; kind: "search" | "fetch" }): Promise<void>;
  saveSearch(search: FrozenSearch): Promise<void>;
  saveSource(source: FrozenPublicSource): Promise<void>;
}
export interface CollectedPublicSources {
  query: string;
  sources: SelectedPublicSource[];
  modelSources: Source[];
  sourceDigest: string;
  disclosure: string;
  manifestFile: DraftFile;
}

/** Only this server chooses filenames. Neither query API nor callers can read an arbitrary local path. */
export class PublicSourceVault {
  constructor(private readonly base = join(process.env.WORKLOOM_CONSULTING_DATA_DIR
    ?? join(process.env.WORKLOOM_SUPPORT_DIR ?? join(homedir(), "Library", "Application Support", "WorkRoomEagle"), "consulting"), "public-research")) {}
  private async directory(scope: Scope, threadId: string): Promise<string> {
    if (!SAFE_THREAD.test(threadId)) throw new ConsultingError("PUBLIC_SOURCE_PATH_INVALID", "研究任务标识无效");
    await mkdir(this.base, { recursive: true, mode: 0o700 });
    const root = await realpath(this.base);
    const scopeDirectory = join(root, sha256(`${scope.tenantId}:${scope.workspaceId}`).slice(0, 32));
    const target = join(scopeDirectory, threadId);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const actual = await realpath(target);
    if (!actual.startsWith(root + sep) || (await lstat(scopeDirectory)).isSymbolicLink() || (await lstat(target)).isSymbolicLink()) {
      throw new ConsultingError("PUBLIC_SOURCE_PATH_INVALID", "公开资料目录越出当前工作区或使用了符号链接");
    }
    return actual;
  }
  async write(scope: Scope, threadId: string, kind: "search" | "source" | "selection" | "report", identity: string, content: string): Promise<DraftFile> {
    assertNoCredentials(content);
    const directory = await this.directory(scope, threadId);
    const path = join(directory, `${kind}-${sha256(identity)}.${kind === "source" || kind === "report" ? "md" : "json"}`);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { mode: 0o600, flag: "wx", encoding: "utf8" });
    try { await link(temp, path); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      if ((await lstat(path)).isSymbolicLink() || await readFile(path, "utf8") !== content) {
        throw new ConsultingError("PUBLIC_SOURCE_IMMUTABLE_CONFLICT", "同一资料或报告标识已有不同内容，保留原件并停止，不能覆盖历史");
      }
    } finally { await unlink(temp); }
    const file = { path, sha256: sha256(content), bytes: Buffer.byteLength(content) };
    await this.read(scope, threadId, file); return file;
  }
  async read(scope: Scope, threadId: string, file: DraftFile): Promise<string> {
    if (!SHA.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new ConsultingError("PUBLIC_SOURCE_HASH_MISMATCH", "资料散列或字节数无效");
    }
    const directory = await this.directory(scope, threadId);
    let actual: string;
    try {
      if ((await lstat(file.path)).isSymbolicLink()) throw new ConsultingError("PUBLIC_SOURCE_PATH_INVALID", "资料文件不得使用符号链接");
      actual = await realpath(file.path);
    } catch (error) {
      if (error instanceof ConsultingError) throw error;
      throw new ConsultingError("PUBLIC_SOURCE_PATH_INVALID", "已冻结的资料文件不存在或不可读取");
    }
    if (dirname(actual) !== directory || basename(actual) !== basename(file.path)) {
      throw new ConsultingError("PUBLIC_SOURCE_PATH_INVALID", "资料不属于当前租户、工作区与任务");
    }
    const content = await readFile(actual, "utf8");
    if (Buffer.byteLength(content) !== file.bytes || sha256(content) !== file.sha256) {
      throw new ConsultingError("PUBLIC_SOURCE_HASH_MISMATCH", "完整资料或报告散列不一致，不能标记为已验证产物");
    }
    return content;
  }
}

function publicationDate(content: string, searchDate: string | null): Pick<FrozenPublicSource, "publishedAt" | "publicationDateSource"> {
  const matched = /(?:发布日期|发布时间|发布时期|发布时间)[：:\s]*(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/u.exec(content.slice(0, 3000));
  if (matched) {
    const iso = `${matched[1]}-${matched[2]!.padStart(2, "0")}-${matched[3]!.padStart(2, "0")}`;
    if (Number.isFinite(Date.parse(iso))) return { publishedAt: iso, publicationDateSource: "page-text" };
  }
  if (searchDate && Number.isFinite(Date.parse(searchDate))) return { publishedAt: searchDate, publicationDateSource: "search-result" };
  return { publishedAt: null, publicationDateSource: "unknown" };
}

interface Excerpt { text: string; startByte: number; endByte: number; score: number }
function topicTerms(goal: string): string[] {
  const cleaned = publicTopic(goal).replace(/(?:地区|区域|报告|官方|统计|的)/gu, " ");
  const terms = new Set<string>();
  for (const token of cleaned.match(/[\p{Script=Han}]{2,}|[a-zA-Z0-9]{2,}/gu) ?? []) {
    if (/^[a-zA-Z0-9]+$/.test(token)) terms.add(token.toLowerCase());
    else for (let i = 0; i + 1 < token.length; i++) terms.add(token.slice(i, i + 2));
  }
  return [...terms].slice(0, 50);
}
function assertPageRelevance(goal: string, content: string): void {
  const topic = publicTopic(goal).replace(/(?:19|20)\d{2}年?/gu, "").replace(/\s+/g, "");
  const region = /^([\p{Script=Han}]{2,8}?)(?:地区|区域|市|省|县)/u.exec(topic)?.[1];
  if (region && !content.includes(region)) {
    throw new ConsultingError("PUBLIC_SOURCE_OFF_TOPIC", "官网正文未覆盖本次要求的地区，不能以其他地区材料冒充研究证据");
  }
  const terms = topicTerms(goal).filter((term) => !/^\d+$/.test(term) && (!region || !region.includes(term)));
  if (terms.length && !terms.some((term) => content.toLowerCase().includes(term))) {
    throw new ConsultingError("PUBLIC_SOURCE_OFF_TOPIC", "官网正文未覆盖本次要求的行业或议题；仅域名属于官网不能证明内容适用");
  }
}
function excerptCandidates(content: string, terms: string[], maxBytes: number): Excerpt[] {
  const candidates: Excerpt[] = [];
  for (const match of content.matchAll(/[^\n。！？]+[。！？\n]*/gu)) {
    const sentence = match[0];
    // Candidate offsets derive from the original returned text, including all intervening whitespace.
    let chunkStart = match.index!; let chunk = ""; let bytes = 0;
    const add = () => {
      if (!chunk.trim()) return;
      const left = chunk.search(/\S/u); const right = chunk.search(/\s*$/u);
      const text = chunk.slice(left, right); if (!text) return;
      // A later dossier mask must not turn a purported exact source quotation into
      // different bytes. Omit the whole PII-bearing candidate and retain the full
      // frozen page; do not send a silently rewritten quotation to the model.
      if (maskText(text).text !== text || /\[PII:/i.test(text)) return;
      const startByte = Buffer.byteLength(content.slice(0, chunkStart + left));
      const lower = text.toLowerCase();
      const score = terms.filter((term) => lower.includes(term)).length * 10
        + (/\d/.test(text) ? 3 : 0) + (/%|％|亿元|万元|增加值|投资/.test(text) ? 3 : 0)
        + (/风险|不确定|困难|挑战|不足|目标|报告期|年度/.test(text) ? 2 : 0);
      candidates.push({ text, startByte, endByte: startByte + Buffer.byteLength(text), score });
    };
    for (const character of sentence) {
      const size = Buffer.byteLength(character);
      if (bytes + size > maxBytes && chunk) { add(); chunkStart += chunk.length; chunk = ""; bytes = 0; }
      chunk += character; bytes += size;
    }
    add();
  }
  return candidates;
}
function selectExcerpt(content: string, goal: string, maximum: number): { content: string; ranges: SelectedPublicSource["excerptRanges"] } {
  const candidates = excerptCandidates(content, topicTerms(goal), Math.min(450, maximum));
  const selected: Excerpt[] = []; let used = 0;
  for (const candidate of candidates.sort((a, b) => b.score - a.score || a.startByte - b.startByte)) {
    const extra = Buffer.byteLength(candidate.text) + (selected.length ? 2 : 0);
    if (used + extra > maximum) continue;
    selected.push(candidate); used += extra;
    if (selected.length === 3) break;
  }
  if (!selected.length) throw new ConsultingError("PUBLIC_SOURCE_EMPTY", "官网正文没有足够的可引用文字，不能用标题或搜索摘要冒充原始证据");
  selected.sort((a, b) => a.startByte - b.startByte);
  return { content: selected.map((item) => item.text).join("\n\n"), ranges: selected.map(({ startByte, endByte }) => ({ startByte, endByte })) };
}

export async function collectPublicSources(input: { scope: Scope; threadId: string; goal: string }, deps: {
  client: DeepSeekClient; vault: PublicSourceVault; journal: SourceCollectionJournal;
}): Promise<CollectedPublicSources> {
  const { scope, threadId, goal } = input;
  let checkpoint = await deps.journal.read();
  const query = checkpoint.search?.query ?? buildPublicResearchQuery(goal);
  if (checkpoint.search) {
    const raw = await deps.vault.read(scope, threadId, checkpoint.search.file);
    const { file: _file, ...stored } = checkpoint.search;
    if (raw !== canonical(stored) || stored.goalHash !== sha256(goal)) throw new ConsultingError("PUBLIC_SOURCE_IMMUTABLE_CONFLICT", "已有检索回执与原议题不一致");
  } else {
    await deps.journal.beforeCall({ id: `search:${sha256(query)}`, kind: "search" });
    const result = await deps.client.search({ query, count: 6 });
    if (!Array.isArray(result.results) || result.provider !== "deepseek" || !result.reservationId || !result.retrievedAt) {
      throw new ConsultingError("PUBLIC_SOURCE_RESPONSE_INVALID", "检索没有可校验的供应商回执");
    }
    const saved = { query, goalHash: sha256(goal), results: result.results, provider: result.provider, retrievedAt: result.retrievedAt, reservationId: result.reservationId };
    const file = await deps.vault.write(scope, threadId, "search", query, canonical(saved));
    await deps.journal.saveSearch({ ...saved, file }); checkpoint = await deps.journal.read();
  }
  const search = checkpoint.search!;
  const selected = new Map<string, DeepSeekSearchResult>();
  for (const item of search.results) {
    try {
      const url = assertOfficialPublicUrl(item.url);
      if (/\.(?:pdf|docx?|xlsx?|zip|rar|7z)(?:$|[?#])/i.test(url)) continue;
      if (!selected.has(url)) selected.set(url, item);
    }
    catch (error) { if (!(error instanceof ConsultingError)) throw error; }
    if (selected.size >= MAX_FETCHES) break;
  }
  if (!selected.size) throw new ConsultingError("PUBLIC_SOURCES_MISSING", "未取得可读取的政府官网来源；任务已暂停，不能凭空编写地区统计与行业事实");
  for (const [url, searchItem] of selected) {
    const prior = checkpoint.sources.find((source) => source.url === url);
    if (prior) { await deps.vault.read(scope, threadId, prior.file); continue; }
    await deps.journal.beforeCall({ id: `fetch:${sha256(url)}`, kind: "fetch" });
    const page = await deps.client.fetchPage({ url });
    if (page.provider !== "deepseek" || page.url !== url || !page.reservationId || !page.retrievedAt || typeof page.content !== "string"
      || Buffer.byteLength(page.content) < 80 || Buffer.byteLength(page.content) > MAX_PAGE_BYTES) {
      throw new ConsultingError("PUBLIC_SOURCE_RESPONSE_INVALID", "官网正文或回执无效、为空或超过全文冻结上限；没有截断或替换成搜索摘要");
    }
    assertNoCredentials(page.content);
    assertPageRelevance(goal, page.content);
    const file = await deps.vault.write(scope, threadId, "source", url, page.content);
    const source: FrozenPublicSource = { id: `PUBLIC_${checkpoint.sources.length + 1}`, title: page.title || searchItem.title,
      url, ...publicationDate(page.content, searchItem.date), retrievedAt: page.retrievedAt, provider: page.provider,
      reservationId: page.reservationId, sha256: file.sha256, fullBytes: file.bytes, file };
    await deps.journal.saveSource(source); checkpoint = await deps.journal.read();
  }
  if (!checkpoint.sources.length) throw new ConsultingError("PUBLIC_SOURCES_MISSING", "尚无已冻结的官网正文，不能生成报告");
  const complete = await Promise.all(checkpoint.sources.map(async (source) => ({ source, content: await deps.vault.read(scope, threadId, source.file) })));
  let window = Math.floor(3000 / complete.length);
  let modelSources: Source[] = []; let sources: SelectedPublicSource[] = [];
  while (window >= 100) {
    modelSources = []; sources = [];
    for (const item of complete) {
      const excerpt = selectExcerpt(item.content, goal, window);
      modelSources.push({ id: item.source.id, title: item.source.title.slice(0, 80), content: excerpt.content });
      sources.push({ ...item.source, excerptSha256: sha256(excerpt.content), excerptBytes: Buffer.byteLength(excerpt.content), excerptRanges: excerpt.ranges });
    }
    if (Buffer.byteLength(JSON.stringify(modelSources)) <= SOURCE_WINDOW_BYTES) break;
    window -= 50;
  }
  validateSources(modelSources);
  const record = { query, sources, modelSources, sourceDigest: sha256(canonical(modelSources)), disclosure: PUBLIC_SOURCE_DISCLOSURE };
  const manifestFile = await deps.vault.write(scope, threadId, "selection", query, canonical(record));
  return { ...record, manifestFile };
}
