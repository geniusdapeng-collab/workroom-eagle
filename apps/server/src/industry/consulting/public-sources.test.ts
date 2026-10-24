import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DeepSeekClient } from "../../../../../bundles/consulting/connectors/deepseek.mjs";
import { assertOfficialPublicUrl, buildPublicResearchQuery, collectPublicSources, PublicSourceVault,
  type SourceCollectionCheckpoint, type SourceCollectionJournal } from "./public-sources.js";
import { sha256, validateSources } from "./workflow-core.js";

const scope = { tenantId: "public-source-fixture-tenant", workspaceId: "public-source-fixture-workspace" };
const other = { tenantId: "other-fixture-tenant", workspaceId: "other-fixture-workspace" };
const goal = "做一个温州地区制造业的分析报告";
const firstUrl = "https://fixture.wenzhou.gov.cn/research/industry.html";
const secondUrl = "https://fixture.stats.gov.cn/research/investment.html";
const paragraphs = [
  "这是明确标注的单元测试公开网页夹具，不是实际温州统计资料。",
  "温州制造业测试材料：本夹具报告期为2025年；规模以上工业增加值增长8%，制造业投资增长9%。",
  "下一年政策目标与上一年度完成值口径不同，不能把目标当成已实现结果。",
  "本夹具指出需求存在不确定性，企业订单、现金流与产能利用率仍需补充证据。",
];
const content = `${paragraphs.join("\n\n")}\n\n${"与研究无关的单元夹具段落。\n".repeat(220)}`;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

class Journal implements SourceCollectionJournal {
  checkpoint: SourceCollectionCheckpoint = { search: null, sources: [] };
  calls: string[] = [];
  active = true;
  async read() { return structuredClone(this.checkpoint); }
  async beforeCall(operation: { id: string; kind: "search" | "fetch" }) {
    if (!this.active) throw Object.assign(new Error("unit task stopped"), { code: "TASK_CANCELLED" });
    this.calls.push(`${operation.kind}:${operation.id}`);
  }
  async saveSearch(value: NonNullable<SourceCollectionCheckpoint["search"]>) { this.checkpoint.search = value; }
  async saveSource(value: SourceCollectionCheckpoint["sources"][number]) { this.checkpoint.sources.push(value); }
}

async function fixture(extraResults: Array<{ title: string; url: string }> = []) {
  const base = await mkdtemp(join(tmpdir(), "eagle-public-source-unit-")); dirs.push(base);
  const journal = new Journal(); let searchCalls = 0; let fetchCalls = 0;
  const client = {
    search: async (input: { query: string }) => { searchCalls++; return {
      results: [{ title: "单元夹具产业资料", url: firstUrl }, { title: "单元夹具投资资料", url: secondUrl }, ...extraResults]
        .map((item) => ({ ...item, snippet: "单元夹具", summary: "不可作为实际研究证据", date: null, authority: 3 })),
      verified: true, provider: "deepseek", retrievedAt: "2026-10-24T01:00:00.000Z", reservationId: "fixture-search-reservation", query: input.query,
    }; },
    fetchPage: async ({ url }: { url: string }) => { fetchCalls++; return { url, title: "单元夹具网页全文", content,
      provider: "deepseek", retrievedAt: "2026-10-24T01:00:01.000Z", reservationId: `fixture-fetch-${fetchCalls}` }; },
  } as unknown as DeepSeekClient;
  return { base, journal, client, vault: new PublicSourceVault(base), counts: () => ({ searchCalls, fetchCalls }) };
}

describe("official public research sources (local fixtures, no paid requests)", () => {
  it.each([
    "http://www.wenzhou.gov.cn/a", "https://wenzhou.gov.cn.evil.example/a", "https://evilgov.cn/a",
    "https://www.wenzhou.gov.cn@127.0.0.1/a", "https://127.0.0.1/a", "https://[::1]/a",
    "https://www.wenzhou.gov.cn:8443/a", "https://www.wenzhou.gov.cn/a#secret", "file:///etc/passwd",
    "https://www.wenzhou.gov.cn/a?appsecret=not-a-public-source",
    "https://www.wenzhou.gov.cn/a?appkey=opaque-fixture",
    "https://www.wenzhou.gov.cn/a?api-key=opaque-fixture",
    "https://www.wenzhou.gov.cn/a?client_secret=opaque-fixture",
  ])("rejects nonofficial, credentialed, local, alternate-port or secret-bearing URL %s before I/O", (url) => {
    expect(() => assertOfficialPublicUrl(url)).toThrow();
  });

  it("accepts exact official DNS suffixes and builds a disclosed bounded public query without arbitrary operators", () => {
    expect(assertOfficialPublicUrl("https://wzrd.wenzhou.gov.cn/research/report.html")).toBe("https://wzrd.wenzhou.gov.cn/research/report.html");
    const query = buildPublicResearchQuery(goal);
    expect(query).toContain("温州"); expect(query).toContain("制造业"); expect(query).toContain("site:gov.cn");
    expect(query).toContain(String(new Date().getUTCFullYear()));
    expect([...query].length).toBeLessThanOrEqual(128);
    expect(() => buildPublicResearchQuery(`请用这个凭据sk-${"f".repeat(32)}研究制造业`)).toThrow();
    expect(() => buildPublicResearchQuery("温州制造业分析报告，客户电话13800000000")).toThrow();
  });
  it.each(["请给我一份2024年温州市制造业的研究报告", "请分析一下2024年温州市制造业产业报告"])("keeps the requested year and recognizes the region after ordinary wording: %s", async requestedGoal => {
    const f = await fixture(); const originalFetch = f.client.fetchPage;
    f.client.fetchPage = async input => ({ ...await originalFetch(input), content: content.replace("2025年", "2024年") });
    expect(buildPublicResearchQuery(requestedGoal)).toContain("2024");
    expect(buildPublicResearchQuery(requestedGoal)).not.toContain(`${new Date().getUTCFullYear()}年`);
    await expect(collectPublicSources({ scope, threadId: "T-UNIT-WORDING", goal: requestedGoal }, f)).resolves.toMatchObject({ sources: expect.any(Array) });
  });

  it("excludes PII-bearing sentences from model excerpts instead of silently masking original quotations", async () => {
    const f = await fixture();
    f.client.fetchPage = async ({ url }) => ({ url, title: "含公开联络信息的单元夹具", provider: "deepseek", retrievedAt: "2026-10-24T01:00:00Z", reservationId: "pii-page-fixture",
      content: "温州制造业投资研究夹具，联系电话13800000000，制造业投资增长8%。\n\n温州制造业公开资料单元夹具，报告期为2025年；行业总量不能证明单个企业的经营状况。\n\n统计范围和未来政策目标应分别核对。" });
    const result = await collectPublicSources({ scope, threadId: "T-UNIT-PII-EXCERPT", goal }, f);
    for (const excerpt of result.modelSources) {
      expect(excerpt.content).not.toContain("13800000000"); expect(excerpt.content).not.toContain("[PII:");
    }
  });

  it.each([
    "杭州市旅游业单元夹具：这是其他地区公开材料，不能证明目标地区的制造业状况。".repeat(4),
    "温州旅游活动单元夹具：这是旅游与景区宣传材料，不是本次要求的产业研究证据。".repeat(4),
  ])("does not accept an official-domain page from the wrong region or sector as relevant evidence", async (wrongContent) => {
    const f = await fixture(); let calls = 0;
    f.client.fetchPage = async ({ url }) => { calls++; return { url, title: "不适用的单元资料", content: wrongContent,
      provider: "deepseek", retrievedAt: "2026-10-24T01:00:00Z", reservationId: "wrong-source-fixture" }; };
    await expect(collectPublicSources({ scope, threadId: "T-UNIT-WRONG", goal }, f)).rejects.toMatchObject({ code: "PUBLIC_SOURCE_OFF_TOPIC" });
    expect(calls).toBe(1); expect(f.journal.checkpoint.sources).toHaveLength(0);
  });

  it("freezes the complete returned bytes, uses exact UTF8 excerpt ranges and discloses the model's smaller evidence window", async () => {
    const f = await fixture([{ title: "untrusted unit result", url: "https://evil.example/article" }]);
    const selected = await collectPublicSources({ scope, threadId: "T-UNIT-1", goal }, f);
    expect(f.counts()).toEqual({ searchCalls: 1, fetchCalls: 2 });
    expect(selected.sources).toHaveLength(2); validateSources(selected.modelSources);
    expect(Buffer.byteLength(JSON.stringify(selected.modelSources))).toBeLessThanOrEqual(4000);
    for (const source of selected.sources) {
      const full = await f.vault.read(scope, "T-UNIT-1", source.file);
      expect(full).toBe(content); expect(sha256(full)).toBe(source.sha256);
      expect(source.fullBytes).toBe(Buffer.byteLength(content)); expect(source.excerptBytes).toBeLessThan(source.fullBytes);
      const raw = Buffer.from(full, "utf8");
      const exact = source.excerptRanges.map((range) => raw.subarray(range.startByte, range.endByte).toString("utf8")).join("\n\n");
      expect(exact).toBe(selected.modelSources.find((item) => item.id === source.id)!.content);
      expect(sha256(exact)).toBe(source.excerptSha256); expect(exact).not.toContain("\uFFFD");
    }
    expect(selected.disclosure).toMatch(/摘录|全文/);
  });

  it("restart reuses frozen search/documents without another request and rejects cross-scope reads", async () => {
    const f = await fixture(); const input = { scope, threadId: "T-UNIT-2", goal };
    const original = await collectPublicSources(input, f);
    const repeated = await collectPublicSources(input, { ...f, vault: new PublicSourceVault(f.base) });
    expect(f.counts()).toEqual({ searchCalls: 1, fetchCalls: 2 });
    expect(repeated).toEqual(original);
    await expect(f.vault.read(other, input.threadId, original.sources[0]!.file)).rejects.toMatchObject({ code: "PUBLIC_SOURCE_PATH_INVALID" });
  });

  it("stops before a fetch after a human handoff and does not invent an empty-source report", async () => {
    const f = await fixture();
    const saveSearch = f.journal.saveSearch.bind(f.journal);
    f.journal.saveSearch = async (value) => { await saveSearch(value); f.journal.active = false; };
    await expect(collectPublicSources({ scope, threadId: "T-UNIT-3", goal }, f)).rejects.toMatchObject({ code: "TASK_CANCELLED" });
    expect(f.counts()).toEqual({ searchCalls: 1, fetchCalls: 0 });
    const empty = await fixture();
    empty.client.search = async () => ({ results: [], verified: false, provider: "deepseek", retrievedAt: "2026-10-24T01:00:00Z", reservationId: "empty-unit-search" });
    await expect(collectPublicSources({ scope, threadId: "T-UNIT-4", goal }, empty)).rejects.toMatchObject({ code: "PUBLIC_SOURCES_MISSING" });
    expect(empty.counts().fetchCalls).toBe(0);
  });

  it("retains provider failure and never retries a source automatically", async () => {
    const f = await fixture(); let attempts = 0;
    f.client.fetchPage = async () => { attempts++; throw Object.assign(new Error("fixture provider timeout"), { code: "PROVIDER_TIMEOUT" }); };
    await expect(collectPublicSources({ scope, threadId: "T-UNIT-5", goal }, f)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(attempts).toBe(1); expect(f.journal.checkpoint.sources).toEqual([]);
  });

  it("detects immutable snapshot tampering and refuses symlink substitution", async () => {
    const f = await fixture(); const selected = await collectPublicSources({ scope, threadId: "T-UNIT-6", goal }, f);
    const first = selected.sources[0]!; await writeFile(first.file.path, "changed unit source");
    await expect(f.vault.read(scope, "T-UNIT-6", first.file)).rejects.toMatchObject({ code: "PUBLIC_SOURCE_HASH_MISMATCH" });
    const second = selected.sources[1]!; const outside = join(f.base, "outside-unit-source.md");
    await writeFile(outside, content); await rm(second.file.path); await symlink(outside, second.file.path);
    await expect(f.vault.read(scope, "T-UNIT-6", second.file)).rejects.toMatchObject({ code: "PUBLIC_SOURCE_PATH_INVALID" });
    expect(await readFile(outside, "utf8")).toBe(content);
  });
});
