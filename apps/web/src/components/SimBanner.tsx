/**
 * 模拟数据横幅（D24 落地向导入口）
 *
 * 事实源 = onboarding.status：安装身份、客户资料、模型配置与经营门禁分别呈现。
 * 缺少向导激活凭据不能把已配置的真实模型描述成模拟模型。
 * 挂载点：P0 经营主页顶栏下方 + Bridge 工作台顶栏下方（全覆盖所有页面）。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../lib/trpc";
import { Icon } from "@workloom/ui";
import { runtimeBanner } from "./runtimeBanner";

export interface OnboardingStatus {
  dataMode: "simulated" | "real";
  persistedDataMode?: "simulated" | "real";
  formalActivationRecorded?: boolean;
  installation?: { mode: "production" | "example" | "simulated"; customerDataReady: boolean; modelConfigured: boolean };
  llm: { provider: string; model: string; baseUrl: string; real: boolean };
  workspace: { name: string; events: number; members: number; agents: number; memories: number; verifiedArtifacts?: number };
  business?: { name: string; industry: string; note: string; configuredAt: string; source: string } | null;
  bundle?: { id: string | null; isExample: boolean };
  activationGate?: {
    canActivate: boolean;
    blockers: string[];
    checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
  };
}

export function SimBanner() {
  const [st, setSt] = useState<OnboardingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (!stop) setBusy(true);
      try {
        await ensureDemoLogin();
        const s = (await trpc.onboarding.status.query()) as OnboardingStatus;
        if (!stop) { setSt(s); setFailed(false); }
      } catch {
        if (!stop) setFailed(true);
      } finally {
        if (!stop) setBusy(false);
      }
    };
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [retry]);
  const retryButton = <button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)} className="rounded border border-line px-2 py-1 text-body text-holo hover:border-gline disabled:opacity-50">{busy ? "核对中…" : "重新核对"}</button>;
  if (!st) return <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line bg-bg800 px-4 py-2 text-body text-ink3">{failed ? <>运行配置暂不可核验{retryButton}</> : "正在核对运行配置…"}</div>;
  const banner = runtimeBanner(st);
  if (!banner) return failed ? <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line bg-bg800 px-4 py-2 text-body text-warn">运行配置暂不可核验{retryButton}</div> : null;
  const pending = banner.tone === "pending";
  return (
    <div className={`relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-body backdrop-blur ${pending ? "border-amber-500/50 bg-amber-100/80 text-amber-800" : "border-line bg-bg800/90 text-ink2"}`}>
      <Icon name={pending ? "warning" : "star"} size={16} />
      <span className="min-w-0 flex-1 break-words">
        <b>{banner.title}</b> · {banner.detail}
        {failed && <span className="ml-2 text-warn">本次核对暂不可用，当前显示上次结果。</span>}
      </span>
      {failed && retryButton}
      <a
        href={banner.href}
        className={`shrink-0 rounded border px-3 py-1 font-bold no-underline transition-colors ${pending ? "border-amber-500/60 bg-amber-200/60 text-amber-900 hover:bg-amber-300/60" : "border-gline bg-bg700 text-ink hover:bg-bg700/80"}`}
      >
        {banner.action} →
      </a>
    </div>
  );
}
