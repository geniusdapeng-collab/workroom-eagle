import { useEffect, useState } from "react";
import { AsyncState, Button } from "@workloom/ui";

interface Configuration {
  dataMode: string; guestEnabled: boolean; provider: string; model: string;
  modelLabel: string; credentialConfigured: boolean; credentialStorage: string; agentGuide: string;
  agentCredentialReady: boolean;
  agentFiles: { codexFile: string; mcpFile: string; instructionsFile: string; guideFile: string } | null;
}
interface DesktopBridge {
  configuration: () => Promise<Configuration>;
  openAgentGuide: () => Promise<{ opened: boolean }>;
}

export function ProductionConfiguration() {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bridge = () => (window as unknown as { workloomDesktop?: DesktopBridge }).workloomDesktop;
  const load = async () => {
    setError("");
    try {
      const desktop = bridge();
      if (!desktop) throw new Error("本机安装配置仅在鹰眼桌面客户端可用。网页账号的模型配置以当前服务器为准。");
      setConfig(await desktop.configuration());
    } catch { setError("无法读取本机安装配置，请确认桌面服务已启动后重试。"); }
  };
  useEffect(() => { void load(); }, []);
  const openGuide = async () => {
    setBusy(true); setError("");
    try {
      const desktop = bridge();
      if (!desktop || !(await desktop.openAgentGuide()).opened) throw new Error("无法打开 办公助手引导文档");
    } catch { setError("使用引导未打开，请确认本机文档可访问后重试。"); }
    finally { setBusy(false); }
  };
  return (
    <section className="mb-5 min-w-0 rounded-xl border border-gline bg-card p-4" aria-label="正式安装与 办公助手接入配置">
      <h2 className="text-base font-bold text-ink">正式安装与 办公助手接入配置</h2>
      {error && <AsyncState status="error" title="配置读取或文档打开未完成" description={error} onRetry={() => void load()} />}
      {!config && !error && <AsyncState status="loading" title="正在读取本机安装配置" />}
      {config && <>
        <dl className="mt-3 grid min-w-0 grid-cols-1 gap-3 text-body sm:grid-cols-2">
          <div><dt className="text-ink3">运行环境</dt><dd className={config.dataMode === "real" && !config.guestEnabled ? "text-go" : "text-alert"}>{config.dataMode === "real" && !config.guestEnabled ? "正式工作区 · 客户资料由您接入 · 游客已关闭" : "配置异常：当前环境或身份未满足正式安装要求"}</dd></div>
          <div><dt className="text-ink3">内置模型</dt><dd className="break-words text-ink">{config.modelLabel}（{config.provider} / {config.model}）</dd></div>
          <div><dt className="text-ink3">模型密钥</dt><dd className={config.credentialConfigured ? "text-go" : "text-alert"}>{config.credentialConfigured ? `已配置 · ${config.credentialStorage}` : "未配置，真实任务将明确失败，请完成安全导入"}</dd></div>
          <div><dt className="text-ink3">AI 办公软件引导文件</dt><dd className="break-all text-ink">{config.agentGuide}</dd></div>
          <div><dt className="text-ink3">本机办公助手会话</dt><dd className={config.agentCredentialReady ? "text-go" : "text-warn"}>{config.agentCredentialReady ? "已写入系统钥匙串，命令行与工具服务可直接连接" : "尚未写入钥匙串，接入工具需显式提供正式访问令牌"}</dd></div>
        </dl>
        {config.agentFiles && <div className="mt-3 text-body text-ink2"><p>安装时已生成以下无秘密配置文件：</p><ul className="mt-1 space-y-1 break-all"><li>代码办公软件：{config.agentFiles.codexFile}</li><li>通用工具服务：{config.agentFiles.mcpFile}</li><li>办公助手流程约束：{config.agentFiles.instructionsFile}</li><li>完整使用引导：{config.agentFiles.guideFile}</li></ul></div>}
        <p className="mt-3 text-body leading-relaxed text-ink2">外部办公助手必须使用鹰眼提供的命令行或工具服务入口。服务端按顺序执行资料核对、分析、复核与交付关卡；跳步、过期依据和缺少回执都会被拒绝。</p>
        <p className="mt-2 text-body leading-relaxed text-ink3">当前接入支持授权文字档案、员工与技能分析、原文引用校验、文本草稿及其校验回执和多员工有序协作。实际会面、访谈、对外发送、会计对账以及 文字文档与演示文稿制作仍需对应工具与人工业务关卡。</p>
        <Button className="mt-3" variant="quiet" busy={busy} disabled={busy} onClick={() => void openGuide()}>打开办公助手接入引导</Button>
      </>}
    </section>
  );
}
