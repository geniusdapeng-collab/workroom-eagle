/** This Eagle distribution ships no real IM transport; absent credentials never imply simulated delivery. */
export function imDriverPolicy(env: NodeJS.ProcessEnv = process.env): { mode: "mock" | "disabled"; dataMode: "simulated" | "unconfigured"; reason: string } {
  if (env.NODE_ENV !== "production" && env.IM_DRIVER === "mock") {
    return { mode: "mock", dataMode: "simulated", reason: "显式开发模拟通道；不构成真实外发回执" };
  }
  return { mode: "disabled", dataMode: "unconfigured", reason: env.NODE_ENV === "production" && env.IM_DRIVER === "mock"
    ? "正式安装禁止模拟 IM 发送；未配置经验证的真实通道"
    : "本安装尚未配置经验证的真实 IM 驱动，消息未发送" };
}
