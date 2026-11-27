// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { navigationEntriesFromBundle } from "@workloom/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndustryRouteBoundary } from "../../../shell/IndustryRoutes";
import { industryRoutes } from "../routes";

const mock = vi.hoisted(() => ({
  access: {} as Record<string, unknown>,
  api: {
    context: { query: vi.fn() },
    previewFacts: { mutate: vi.fn() },
    confirmFacts: { mutate: vi.fn() },
    getBrief: { query: vi.fn() },
    getEvidence: { query: vi.fn() },
    listFacts: { query: vi.fn() },
    outcomeEvidence: { query: vi.fn() },
    listActions: { query: vi.fn() },
    confirmAction: { mutate: vi.fn() },
    recordActionOutcome: { mutate: vi.fn() },
    verifyActionOutcome: { mutate: vi.fn() },
    review: { query: vi.fn() },
    botStatus: { query: vi.fn() },
    grantMandate: { mutate: vi.fn() },
    revokeMandate: { mutate: vi.fn() },
    submitTask: { mutate: vi.fn() },
    taskView: { query: vi.fn() },
    taskEvents: { query: vi.fn() },
    cancelTask: { mutate: vi.fn() },
  },
}));
vi.mock("../../../lib/trpc", () => ({ trpc: { business: mock.api } }));
vi.mock("../../../shell/NavigationAccess", () => ({ useNavigationAccess: () => mock.access }));

const permissionEntry = navigationEntriesFromBundle("consulting", [{
  capabilityId: "consulting.business", title: "经营工作台", route: "/consulting/business", group: "operations",
  icon: "report", clients: ["pc"], permissions: ["consulting.business.read"],
}]);
const scope = { tenantId: "tenant-fixture", workspaceId: "workspace-fixture" };
const memberId = "member-fixture";
const sellerId = "seller-fixture";
const artifactId = "b475b1a8-0904-4e30-a7c2-a750ed9fc38a";
const factId = "10e23ebf-c2c5-4c35-8d81-5a23fcb86e38";
const mandateId = "ac062a5d-ec25-4f39-b545-7730bfeb7626";
const taskId = "0ca7f848-b583-44eb-b37f-13f40b12fca9";
const insightId = "0123456789abcdef01234567";
const receipt = { eventId: "eagle-fixture-receipt", hash: "a".repeat(64), synced: true as const };
const timestamp = "2026-11-27T00:00:00.000Z";
const future = "2099-12-31T00:00:00.000Z";

const insight = { id: insightId, kind: "commitment", title: "方案确认今日到期", detail: "商机已约定今天确认评审时间。", action: "请联系客户确认采购参会人。", evidenceFactIds: [factId] };
const fact = { id: factId, kind: "interaction", occurredOn: "2026-11-27", accountRef: "CUSTOMER-1", dealRef: "DEAL-1",
  ownerMemberId: sellerId, sourceKind: "manual", note: "客户说采购经理周五参会。", recordedAt: timestamp, receipt };
const brief = {
  artifactId, businessDate: "2026-11-27", asOf: timestamp, receipt, insights: [insight],
  metrics: {
    growth: { currentContractMinor: 120000, contractDeltaMinor: 40000 },
    leakage: { overdueInvoiceCount: 0, overdueBalanceMinor: 0 },
    competition: { lostDealCount: 0, competitors: [] },
    channels: [{ channel: "伙伴推荐", leads: 3, qualified: 2, advanced: 1, won: 0, comparable: false,
      previous: { leads: 2, qualified: 1, advanced: 1, won: 0 } }],
    channelCohorts: { current: { from: "2026-09-29", to: "2026-10-28" }, observationDays: 30, unmaturedLeadCount: 2 },
    coverage: { currentStart: "2026-10-29", currentEnd: "2026-11-27", currentContractCount: 1, previousContractCount: 1, kindCounts: {}, factCount: 3, disclosure: "证据仅涵盖已确认事实。" },
  },
};

const manager = {
  memberId, memberName: "管理者", role: "owner", dataMode: "simulated", canManage: true,
  canWrite: true, canConfigureBot: true, canDispatchBot: true, canConfirmAction: true,
  members: [{ id: sellerId, name: "销售员", memberNo: "MEM-2" }],
};
const seller = {
  ...manager, memberId: sellerId, memberName: "销售员", role: "staff", dataMode: "real",
  canManage: false, canConfigureBot: false, canDispatchBot: false, canConfirmAction: false, members: [],
};
const mandate = {
  id: mandateId, createdBy: "OWNER", createdAt: timestamp, expiresAt: future, maxRuns: 7, usedRuns: 0,
  maxRuntimeSeconds: 120, dailyAt: null, nextDueAt: null, revokedAt: null, receipt,
};
const task = {
  id: taskId, mandateId, businessUnit: scope.workspaceId, businessDate: "2026-11-27", trigger: "manual", status: "queued",
  scheduledAt: timestamp, deadline: future, attempts: 0, result: null, errorCode: null, receipt,
};
const worker = { state: "online", lastSeenAt: timestamp, lastSuccessfulTickAt: timestamp };

let container: HTMLDivElement;
let root: Root;

async function show(url = "/consulting/business") {
  const route = industryRoutes.find((entry) => entry.capabilityId === "consulting.business");
  if (!route) throw new Error("经营路由未注册");
  await act(async () => root.render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={route.path} element={<IndustryRouteBoundary definition={route}>{route.element}</IndustryRouteBoundary>} />
      </Routes>
    </MemoryRouter>,
  ));
}
function content() { return container.textContent ?? ""; }

async function click(name: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === name);
  if (!button) throw new Error(`没有找到按钮 ${name}`);
  await act(async () => button.click());
}
async function idle() {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  }, { interval: 5 });
}

async function field(label: string, value: string) {
  const node = Array.from(container.querySelectorAll("label")).find((item) => item.textContent?.trim().startsWith(label));
  const input = node?.querySelector("input,textarea,select");
  if (!input) throw new Error(`没有找到输入框 ${label}`);
  const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype
    : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

beforeEach(() => {
  for (const endpoint of Object.values(mock.api)) for (const method of Object.values(endpoint)) method.mockReset();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  mock.access = { entries: permissionEntry, knownEntries: permissionEntry, status: "ready", bundleStatus: "ready",
    identityKey: "fixture-identity", scope, subject: { kind: "member" } };
  mock.api.context.query.mockResolvedValue(manager);
  mock.api.getBrief.query.mockResolvedValue(brief);
  mock.api.listActions.query.mockResolvedValue([]);
  mock.api.listFacts.query.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("经营工作台的授权与业务交互", () => {
  it("没有经营页面授权时拦截直达链接", async () => {
    mock.access.entries = [];
    await show();
    expect(content()).toContain("当前身份不能访问此页面");
    expect(mock.api.context.query).not.toHaveBeenCalled();
  });

  it("经理可查看晨报事实、选择负责人并取得派发回执", async () => {
    mock.api.getEvidence.query.mockResolvedValue([fact]);
    mock.api.confirmAction.mutate.mockResolvedValue({ receipt });
    await show();
    expect(content()).toContain("示例工作区");
    expect(content()).toContain("方案确认今日到期");
    expect(content()).toContain("待接入");
    await click("查看依据");
    expect(mock.api.getEvidence.query).toHaveBeenCalledExactlyOnceWith({ factIds: [factId] });
    expect(content()).toContain("客户说采购经理周五参会");
    await click("派发内部行动");
    await field("负责人", sellerId);
    await field("截止时间", "2026-11-28T14:00");
    await field("验收条件", "收到客户参会人名单");
    await click("确认派发");
    await idle();
    expect(mock.api.confirmAction.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      artifactId, insightId, ownerMemberId: sellerId, dueAt: "2026-11-28T06:00:00.000Z", acceptanceCondition: "收到客户参会人名单",
    }));
    expect(content()).toContain("操作已入账");
  });

  it("销售直达自动运行链接落回自己的今日，先预览再确认事实", async () => {
    mock.api.context.query.mockResolvedValue(seller);
    mock.api.previewFacts.mutate.mockResolvedValue({ rows: [fact], previewDigest: "a".repeat(64) });
    mock.api.confirmFacts.mutate.mockResolvedValue({ facts: [fact], receipt });
    await show("/consulting/business?view=bot");
    expect(mock.api.botStatus.query).not.toHaveBeenCalled();
    expect(mock.api.listActions.query).toHaveBeenCalledExactlyOnceWith({ ownerMemberId: sellerId, limit: 100 });
    await click("记一条");
    await field("客户", "CUSTOMER-1");
    await field("商机", "DEAL-1");
    await field("沟通日期", "2026-11-27");
    await field("沟通原话或纪要", "客户说采购经理周五参会。");
    await click("预览记录");
    expect(mock.api.previewFacts.mutate).toHaveBeenCalledExactlyOnceWith({ rows: [
      { kind: "interaction", occurredOn: "2026-11-27", accountRef: "CUSTOMER-1", dealRef: "DEAL-1", sourceKind: "manual", note: "客户说采购经理周五参会。" },
    ] });
    expect(mock.api.confirmFacts.mutate).not.toHaveBeenCalled();
    await click("确认并保存");
    await idle();
    expect(mock.api.confirmFacts.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ previewDigest: "a".repeat(64) }));
    expect(content()).toContain("操作已入账");
  });

  it("仅在真实回执后声明入账，未知请求用原幂等键重试", async () => {
    mock.api.confirmAction.mutate.mockResolvedValueOnce({ receipt: { ...receipt, synced: false } }).mockResolvedValueOnce({ receipt });
    await show();
    await click("派发内部行动");
    await field("负责人", sellerId);
    await field("截止时间", "2026-11-28T14:00");
    await click("确认派发");
    await idle();
    expect(content()).not.toContain("操作已入账");
    await click("确认派发");
    await idle();
    const keys = mock.api.confirmAction.mutate.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(content()).toContain("操作已入账");
  });

  it("行动回填只显示服务端返回的关联证据并保留回执", async () => {
    const action = {
      id: "action-fixture", artifactId, insightId, ownerMemberId: sellerId, dueAt: timestamp,
      title: "确认客户采购参会人", description: "请向客户取证", acceptanceCondition: "客户给出人员名单",
      status: "open", outcome: null,
    };
    const closed = { ...action, status: "reported", outcome: { id: "outcome-fixture", description: "已收到名单", reportedAt: timestamp, reporterMemberId: sellerId, evidenceFactIds: [factId] } };
    mock.api.context.query.mockResolvedValue(seller);
    mock.api.listActions.query.mockResolvedValueOnce([action]).mockResolvedValue([closed]);
    mock.api.listFacts.query.mockResolvedValue([{ ...fact, id: "unrelated-fact", accountRef: "OTHER-ACCOUNT", note: "不应进入证据选项" }]);
    mock.api.outcomeEvidence.query.mockResolvedValue([fact]);
    mock.api.recordActionOutcome.mutate.mockResolvedValue({ action: closed, receipt });
    await show();
    expect(content()).toContain("客户给出人员名单");
    await click("回填结果");
    expect(mock.api.outcomeEvidence.query).toHaveBeenCalledExactlyOnceWith({ actionId: action.id });
    const evidenceLabels = Array.from(container.querySelectorAll("fieldset label"));
    expect(evidenceLabels).toHaveLength(1);
    expect(evidenceLabels[0]?.textContent).toContain("CUSTOMER-1");
    await field("实际发生了什么", "已收到名单");
    const checkbox = evidenceLabels[0]?.querySelector("input");
    await act(async () => checkbox?.click());
    await click("提交结果");
    await idle();
    expect(mock.api.recordActionOutcome.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actionId: action.id, description: "已收到名单", evidenceFactIds: [factId],
    }));
    expect(content()).toContain("操作已入账");
  });

  it("管理者也看不到本人回填结果的复核按钮", async () => {
    mock.api.listActions.query.mockResolvedValue([{
      id: "action-fixture", artifactId, insightId, ownerMemberId: memberId, dueAt: timestamp,
      title: "核对客户承诺", description: "请联系客户", acceptanceCondition: "客户确认时间",
      status: "reported",
      outcome: { id: "outcome-fixture", description: "执行人已回填", reportedAt: timestamp, reporterMemberId: memberId, evidenceFactIds: [factId] },
    }]);
    await show();
    expect(content()).toContain("客户确认时间");
    expect(content()).not.toContain("复核结果");
  });

  it("手动提交先进入队列，运行历史只展示已回执状态", async () => {
    mock.api.botStatus.query.mockResolvedValueOnce({ mandates: [mandate], tasks: [], worker })
      .mockResolvedValue({ mandates: [mandate], tasks: [task], worker });
    mock.api.submitTask.mutate.mockResolvedValue(task);
    mock.api.taskView.query.mockResolvedValue(task);
    mock.api.taskEvents.query.mockResolvedValue({ events: [
      { cursor: "9", ...receipt, at: timestamp, action: "eagle.bot.task.accepted" },
    ], nextCursor: "9" });
    await show("/consulting/business?view=bot");
    expect(content()).toContain("后台执行器在线");
    expect(content()).toContain("新建委托");
    await field("经营日期", "2026-11-27");
    await click("手动运行");
    await idle();
    expect(mock.api.submitTask.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mandateId, businessDate: "2026-11-27" }));
    expect(content()).toContain("等待执行");
    expect(content()).not.toContain("已生成并回执");
    await click("查看运行记录");
    expect(content()).toContain("任务已受理");
    expect(mock.api.taskEvents.query).toHaveBeenCalledExactlyOnceWith({ taskId, after: undefined, limit: 40 });
  });
});
