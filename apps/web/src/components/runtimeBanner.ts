import type { OnboardingStatus } from "./SimBanner";

export interface RuntimeBanner {
  tone: "example" | "production" | "pending";
  title: string;
  detail: string;
  action: string;
  href: string;
}

/** 安装、资料、模型配置和经营资格是不同事实；缺少向导凭据不能冒充模拟模型。 */
export function runtimeBanner(status: OnboardingStatus): RuntimeBanner | null {
  if (status.bundle?.isExample || status.installation?.mode === "example") return {
    tone: "example", title: "行业示例版",
    detail: `当前工作区为${status.workspace.name}，示例资料保留明确标识。可按引导配置您的专属行业版。`,
    action: "配置专属行业版", href: "/onboarding?mode=customize",
  };
  const provider = status.llm.provider;
  const configured = status.installation?.modelConfigured
    ?? (provider !== "mock" && Boolean(status.llm.baseUrl));
  const model = configured
    ? `已配置 ${provider}${status.llm.model ? `（${status.llm.model}）` : ""}。`
    : provider === "mock" ? "当前选择内置模拟模型。" : "真实模型尚未完成配置，任务会明确报错。";
  const proof = configured && !status.llm.real ? "落地向导尚未留存当前配置的连接测试记录。" : "";
  if (status.installation?.mode === "production") {
    const factChecks = status.activationGate?.checks.filter((check) => check.key !== "owner");
    const blockers = factChecks?.filter((check) => !check.ok).length;
    const readiness = status.formalActivationRecorded && status.dataMode === "real"
      ? "经营门禁已通过当前事实核验。"
      : factChecks && factChecks.length > 0 && factChecks.every((check) => check.ok)
        ? "经营门禁已具备，待负责人启用。"
        : `经营门禁${blockers ? `尚待 ${blockers} 项条件` : "尚待核验"}，请按引导补齐。`;
    return {
      tone: "production", title: "正式安装",
      detail: `${status.installation.customerDataReady ? "客户名单已接入。" : "客户名单尚未接入。"}${model}${proof}${readiness}`,
      action: "查看经营配置", href: "/onboarding",
    };
  }
  if (status.dataMode === "real" && status.llm.real) return null;
  return {
    tone: "pending", title: provider === "mock" ? "模拟模式" : "经营配置待完成",
    detail: `${status.dataMode === "real" ? "客户资料使用真实模式。" : "经营资料尚未完成正式接入核验。"}${model}${proof}`,
    action: "查看接入引导", href: "/onboarding",
  };
}
