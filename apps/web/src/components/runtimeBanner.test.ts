import { describe, expect, it } from "vitest";
import type { OnboardingStatus } from "./SimBanner";
import { runtimeBanner } from "./runtimeBanner";

const fresh: OnboardingStatus = {
  dataMode: "simulated", persistedDataMode: "real", formalActivationRecorded: false,
  installation: { mode: "production", customerDataReady: false, modelConfigured: true },
  llm: { provider: "deepseek", model: "deepseek-flash", baseUrl: "https://api.deepseek.com", real: false },
  workspace: { name: "鹰眼正式工作区", events: 2, members: 1, agents: 22, memories: 0, verifiedArtifacts: 0 },
  bundle: { id: "consulting", isExample: false },
  activationGate: { canActivate: false, blockers: ["经营主体待配置"], checks: [{ key: "business", label: "经营主体", ok: false, detail: "尚未接入" }] },
};

describe("安装与经营事实分别呈现", () => {
  it("已配真实模型但缺向导凭据时，不把正式空安装改称模拟或伪造门禁通过", () => {
    const banner = runtimeBanner(fresh)!;
    expect(banner.title).toBe("正式安装");
    expect(banner.detail).toContain("客户名单尚未接入");
    expect(banner.detail).toContain("deepseek-flash");
    expect(banner.detail).toContain("尚未留存当前配置的连接测试记录");
    expect(banner.detail).toContain("尚待 1 项条件");
    expect(banner.detail).not.toMatch(/模拟运行态|内置确定性|门禁已通过/);
  });
  it("模型密钥未配时明确配置未完成；只有实际mock才描述模拟模型", () => {
    const pending = runtimeBanner({ ...fresh, installation: { ...fresh.installation!, modelConfigured: false } })!;
    expect(pending.detail).toContain("真实模型尚未完成配置");
    expect(pending.detail).not.toContain("已配置 deepseek");
    const mock = runtimeBanner({ ...fresh, installation: { ...fresh.installation!, modelConfigured: false }, llm: { provider: "mock", model: "", baseUrl: "", real: false } })!;
    expect(mock.detail).toContain("当前选择内置模拟模型");
  });
  it("示例身份保持明示，不提供无条件清空客户资料承诺", () => {
    const example = runtimeBanner({ ...fresh, bundle: { id: "hotel", isExample: true } })!;
    expect(example.title).toBe("行业示例版");
    expect(example.detail).not.toContain("清空");
  });
  it("只读成员不拥有激活权限，不会把已核验工作区重新显示为门禁失败", () => {
    const ready = runtimeBanner({ ...fresh, dataMode: "real", formalActivationRecorded: true,
      activationGate: { canActivate: false, blockers: ["仅负责人可激活"], checks: [{ key: "owner", label: "责任人", ok: false, detail: "仅负责人可激活" }] } })!;
    expect(ready.detail).toContain("经营门禁已通过当前事实核验");
    expect(ready.detail).not.toContain("尚待 1 项条件");
  });
});
