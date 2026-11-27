import { describe, expect, it } from "vitest";
import { composeOperatingBrief } from "./operating-brief.js";
import { normalizeCapture, operatingFactInput, parseOperatingCsv, type OperatingFact, type OperatingFactInput } from "./operating-facts.js";

const staff = { memberId: "user-1", manager: false };
const manager = { memberId: "manager", manager: true };
const base = { occurredOn: "2026-11-25", accountRef: "account-a", dealRef: "deal-a", sourceKind: "manual" as const };
const asOf = "2026-11-27T01:00:00.000Z";
const recordedAt = "2026-11-26T01:00:00.000Z";

describe("operating evidence capture", () => {
  it("normalizes text deterministically and stably accepts quoted CSV", () => {
    const csv = '\uFEFFkind,occurredOn,accountRef,dealRef,channel,qualified,note\r\nlead,2026-11-25,account-a,deal-a,转介绍,true,"与客户沟通, 回电\r\n明天确认"\r\n';
    const rows = parseOperatingCsv(csv);
    expect(rows).toEqual([{ ...base, kind: "lead", channel: "转介绍", qualified: true, note: "与客户沟通, 回电\n明天确认" }]);
    expect(normalizeCapture({ csv }, manager)).toEqual(normalizeCapture({ rows }, manager));
    expect(operatingFactInput.safeParse({ ...base, kind: "interaction", occurredOn: "2026-02-30", note: "回电" }).success).toBe(false);
    expect(operatingFactInput.safeParse({ ...base, kind: "contract", amountMinor: 1.1, customerType: "unknown" }).success).toBe(false);
  });

  it("fails closed on invalid CSV, unauthorized imports, arbitrary sales finance, and identity collisions", () => {
    expect(() => parseOperatingCsv('kind,kind\n"lead,lead')).toThrow();
    expect(() => parseOperatingCsv("kind,unexpected\nlead,go")).toThrow(/表头/u);
    expect(() => normalizeCapture({ csv: "not actually csv" }, staff)).toThrow(/仅主管/u);
    expect(() => normalizeCapture({ rows: [{ ...base, kind: "payment", amountMinor: 100, invoiceRef: "P-12" }] }, staff)).toThrow(/本人/u);
    expect(() => normalizeCapture({ rows: [{ ...base, kind: "interaction", ownerMemberId: "another", note: "客户回电" }] }, staff)).toThrow(/本人/u);
    expect(() => normalizeCapture({ rows: [
      { ...base, kind: "lead", channel: "转介绍", qualified: false, sourceRef: "L-01" },
      { ...base, kind: "lead", channel: "转介绍", qualified: true, sourceRef: "L-01" },
    ] }, manager)).toThrow(/重复/u);
    expect(() => normalizeCapture({ rows: [
      { ...base, kind: "interaction", note: "确认进展" },
      { ...base, kind: "interaction", accountRef: "account-other", note: "确认进展" },
    ] }, manager)).toThrow(/同一客户/u);
  });

  it("rejects known credential/PII refs and masks free text before digest or persistence", () => {
    const value = normalizeCapture({ rows: [{ ...base, kind: "interaction", note: "联系 sales@example.com 复核" }] }, staff);
    expect(value.rows[0]?.note).toMatch(/联系 \[PII:EMAIL:[a-f0-9]+\] 复核/u);
    expect(() => normalizeCapture({ rows: [{ ...base, accountRef: "13800001234", kind: "interaction", note: "测试" }] }, staff)).toThrow(/个人号码/u);
    const syntheticCredential = ["ghp", "fake".repeat(8)].join("_");
    expect(() => normalizeCapture({ rows: [{ ...base, kind: "interaction", note: syntheticCredential }] }, staff)).toThrow(/凭据/u);
  });
});

describe("deterministic observed business facts", () => {
  const fact = (id: string, input: OperatingFactInput, capturedAt = recordedAt): OperatingFact => ({ ...input, id, ownerMemberId: staff.memberId, recordedAt: capturedAt });
  it("reproduces amounts, matched channel stages, and outstanding commitments with evidence", () => {
    const report = composeOperatingBrief([
      fact("old-contract", { ...base, occurredOn: "2026-10-15", kind: "contract", amountMinor: 600, customerType: "new" }),
      fact("sale", { ...base, kind: "contract", amountMinor: 1_000, customerType: "existing" }),
      fact("invoice", { ...base, kind: "invoice", invoiceRef: "INV-A", amountMinor: 800, dueOn: "2026-11-26" }),
      fact("paid", { ...base, kind: "payment", amountMinor: 200, invoiceRef: "INV-A" }),
      fact("orphan", { ...base, kind: "payment", amountMinor: 100_000, invoiceRef: "INV-UNMATCHED" }),
      fact("cost", { ...base, kind: "delivery_cost", amountMinor: 1_700 }),
      fact("won", { ...base, occurredOn: "2026-10-12", kind: "deal_outcome", outcome: "won", reason: "已签署" }),
      fact("lost", { ...base, kind: "deal_outcome", dealRef: "b", outcome: "lost", reason: "预算", competitor: "竞对乙" }),
      fact("lead", { ...base, occurredOn: "2026-10-05", kind: "lead", channel: "转介绍", qualified: true }),
      fact("dupe", { ...base, kind: "lead", channel: "展会", qualified: false }),
      fact("stage", { ...base, occurredOn: "2026-10-09", kind: "opportunity", stage: "proposal" }),
      fact("open", { ...base, kind: "commitment", commitmentRef: "C-01", state: "open", dueOn: "2026-11-28" }),
      fact("late", { ...base, kind: "contract", amountMinor: 100_000, customerType: "new" }, "2026-11-27T02:00:00.000Z"),
    ], "2026-11-27", asOf);
    expect(report.metrics.growth).toEqual({ currentContractMinor: 1_000, previousContractMinor: 600, contractDeltaMinor: 400,
      newCustomerContractMinor: 0, existingCustomerContractMinor: 1_000, unknownCustomerContractMinor: 0 });
    expect(report.metrics.leakage).toEqual({ overdueInvoiceCount: 1, overdueBalanceMinor: 600, negativeContributionDealCount: 1, unlinkedPaymentCount: 1 });
    expect(report.metrics.competition.competitors).toEqual([{ name: "竞对乙", count: 1 }]);
    expect(report.metrics.channels).toEqual([{ channel: "转介绍", leads: 1, qualified: 1, advanced: 1, won: 1,
      comparable: false, evidenceFactIds: ["lead", "stage", "won"], previous: { leads: 0, qualified: 0, advanced: 0, won: 0, evidenceFactIds: [] } }]);
    expect(report.metrics.openCommitmentCount).toBe(1);
    expect(report.insights.find((insight) => insight.kind === "commitment")?.evidenceFactIds).toEqual(["open"]);
    expect(report.insights.find((insight) => insight.kind === "leakage")?.evidenceFactIds).toEqual(["invoice", "paid"]);
  });

  it("anchors the first eligible source and compares only equally mature 30-day cohorts", () => {
    const report = composeOperatingBrief([
      fact("unqualified", { ...base, occurredOn: "2026-10-01", kind: "lead", channel: "展会", qualified: false }),
      fact("attributed", { ...base, occurredOn: "2026-10-05", kind: "lead", channel: "转介绍", qualified: true }),
      fact("later", { ...base, occurredOn: "2026-10-10", kind: "lead", channel: "付费", qualified: true }),
      fact("late-stage", { ...base, occurredOn: "2026-11-05", kind: "opportunity", stage: "proposal" }),
      fact("late-won", { ...base, occurredOn: "2026-11-05", kind: "deal_outcome", outcome: "won", reason: "已确认" }),
      fact("prior-lead", { ...base, accountRef: "account-b", occurredOn: "2026-09-10", kind: "lead", channel: "转介绍", qualified: true }),
      fact("prior-stage", { ...base, accountRef: "account-b", occurredOn: "2026-10-10", kind: "opportunity", stage: "evaluation" }),
      fact("immature", { ...base, accountRef: "account-c", occurredOn: "2026-10-28", kind: "lead", channel: "转介绍", qualified: true }),
      fact("unknown", { ...base, accountRef: "account-d", occurredOn: "2026-10-27", kind: "lead", channel: "unknown", qualified: true }),
      fact("unknown-won", { ...base, accountRef: "account-d", occurredOn: "2026-11-26", kind: "deal_outcome", outcome: "won", reason: "已确认" }),
    ], "2026-11-27", asOf);
    expect(report.metrics.channelCohorts).toEqual({
      current: { from: "2026-09-28", to: "2026-10-27" }, previous: { from: "2026-08-29", to: "2026-09-27" },
      minimumComparableLeads: 10, observationDays: 30, unmaturedLeadCount: 1, unknownSourceLabel: "未知来源",
    });
    expect(report.metrics.channels).toEqual(expect.arrayContaining([
      { channel: "转介绍", leads: 1, qualified: 1, advanced: 0, won: 0, comparable: false, evidenceFactIds: ["attributed"],
        previous: { leads: 1, qualified: 1, advanced: 1, won: 0, evidenceFactIds: ["prior-lead", "prior-stage"] } },
      { channel: "未知来源", leads: 1, qualified: 1, advanced: 1, won: 1, comparable: false, evidenceFactIds: ["unknown", "unknown-won"],
        previous: { leads: 0, qualified: 0, advanced: 0, won: 0, evidenceFactIds: [] } },
    ]));
    expect(report.metrics.channels).toHaveLength(2);
    expect(report.insights.filter(({ kind }) => kind === "channel")).toEqual([]);
  });

  it("raises an evidence-linked channel alert only with two large enough samples and a 20-point drop", () => {
    const rows = (channel: string, size: number) => Array.from({ length: size }, (_, index) => {
      const evidence = {
        ...base,
        accountRef: `client-${channel}-${index}`,
        dealRef: "same-link-id",
      };
      return [
        fact(`${channel}-current-${index}`, { ...evidence, occurredOn: "2026-10-02", kind: "lead", channel, qualified: true }),
        fact(`${channel}-prior-${index}`, { ...evidence, dealRef: "other-deal", occurredOn: "2026-09-14", kind: "lead", channel, qualified: true }),
        ...(index < 2 ? [fact(`${channel}-stage-${index}`, { ...evidence, occurredOn: "2026-10-11", kind: "opportunity", stage: "proposal" })] : []),
        ...(index < 4 ? [fact(`${channel}-prior-stage-${index}`, { ...evidence, dealRef: "other-deal", occurredOn: "2026-09-20", kind: "opportunity", stage: "proposal" })] : []),
      ];
    }).flat();
    const report = composeOperatingBrief([...rows("转介绍", 10), ...rows("交流会", 9), ...rows("未知", 10)], "2026-11-27", asOf);
    const signals = report.insights.filter(({ kind }) => kind === "channel");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ title: "抽查 转介绍 的推进卡点", detail: expect.stringContaining("本批 2/10") });
    expect(signals[0]?.evidenceFactIds).toHaveLength(26);
    expect(signals[0]?.evidenceFactIds).toContain("转介绍-prior-stage-3");
    expect(report.metrics.channels.map(({ channel, comparable }) => [channel, comparable])).toEqual(expect.arrayContaining([
      ["转介绍", true], ["交流会", false], ["未知来源", false],
    ]));
  });

  it("keeps cost comparisons and lost deals separate across customers with a matching deal number", () => {
    const report = composeOperatingBrief([
      fact("contract-a", { ...base, kind: "contract", amountMinor: 150, customerType: "new" }),
      fact("contract-b", { ...base, accountRef: "account-b", kind: "contract", amountMinor: 900, customerType: "new" }),
      fact("cost-a", { ...base, kind: "delivery_cost", amountMinor: 300 }),
      fact("loss-a", { ...base, kind: "deal_outcome", outcome: "lost", reason: "客户选了竞对", competitor: "乙" }),
      fact("won-b", { ...base, accountRef: "account-b", occurredOn: "2026-11-26", kind: "deal_outcome", outcome: "won", reason: "客户确认" }),
    ], "2026-11-27", asOf);
    expect(report.metrics.leakage.negativeContributionDealCount).toBe(1);
    expect(report.metrics.competition.lostDealCount).toBe(1);
    expect(report.insights.find(({ kind }) => kind === "leakage")?.evidenceFactIds).toEqual(["contract-a", "cost-a"]);
  });

  it("prevents a different deal's matching commitment number from closing an open promise", () => {
    const pending = fact("open", { ...base, kind: "commitment", commitmentRef: "C-01", state: "open", dueOn: "2026-11-28" });
    const other = fact("delivered", { ...base, accountRef: "account-b", dealRef: "deal-b", kind: "commitment", commitmentRef: "C-01",
      state: "delivered", occurredOn: "2026-11-26", dueOn: "2026-11-28" });
    const report = composeOperatingBrief([pending, other], "2026-11-27", asOf);
    expect(report.metrics.openCommitmentCount).toBe(1);
    expect(report.insights.find((insight) => insight.kind === "commitment")?.evidenceFactIds).toEqual(["open"]);
  });

  it("keeps partial coverage explicit and reconstructs original as-of after append-only correction", () => {
    const original = fact("contract", { ...base, kind: "contract", amountMinor: 1_000, customerType: "unknown" });
    const later = fact("corrected", { ...base, kind: "contract", amountMinor: 250, customerType: "new", supersedesFactId: "contract" }, "2026-11-27T03:00:00.000Z");
    const old = composeOperatingBrief([later, original], "2026-11-27", asOf);
    const revised = composeOperatingBrief([later, original], "2026-11-27", "2026-11-27T04:00:00.000Z");
    expect(old.metrics.growth.currentContractMinor).toBe(1000);
    expect(old.metrics.coverage.previousContractCount).toBe(0);
    expect(old.insights.some((insight) => insight.title === "补齐签约额对照期")).toBe(true);
    expect(revised.metrics.growth.currentContractMinor).toBe(250);
    expect(revised.metrics.coverage.factCount).toBe(1);
    expect(composeOperatingBrief([], "2026-11-27", asOf).insights).toEqual([]);
  });
});
