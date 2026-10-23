/**
 * ValueCounters · 累计价值计数器（方案 V4 §6.2「数得清的战果」）
 * 真实咨询草稿、待审批项和已装配成员分别计数。
 * 欢迎、安装和配置事件不属于业务产物，首次启动允许为零。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../lib/trpc";

interface Counts { artifacts: number | null; agents: number; pending: number }

export function ValueCounters() {
  const [c, setC] = useState<Counts | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (!stop) setBusy(true);
      try {
        await ensureDemoLogin();
        const [st, th] = await Promise.all([
          trpc.onboarding.status.query() as Promise<{ workspace?: { verifiedArtifacts?: number; agents?: number } }>,
          trpc.captain.theater.query() as Promise<{ pendingByTier?: Record<string, number> }>,
        ]);
        if (!st.workspace || typeof st.workspace.agents !== "number" || !Number.isInteger(st.workspace.agents) || st.workspace.agents < 0) throw new Error("工作区统计未返回有效成员数");
        const pending = Object.values(th.pendingByTier ?? {}).reduce((s, n) => s + n, 0);
        const artifacts = st.workspace?.verifiedArtifacts;
        if (!stop) {
          setC({ artifacts: typeof artifacts === "number" && Number.isInteger(artifacts) && artifacts >= 0 ? artifacts : null, agents: st.workspace.agents, pending });
          setError(false);
        }
      } catch {
        if (!stop) setError(true);
      } finally {
        if (!stop) setBusy(false);
      }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => { stop = true; clearInterval(id); };
  }, [retry]);
  const retryButton = <button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)} className="rounded border border-line px-2 py-1 text-body text-holo transition-colors hover:border-gline disabled:opacity-50">{busy ? "正在更新…" : "重试统计"}</button>;
  if (!c) return <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-1.5 text-body text-ink3">{error ? <>统计暂不可用{retryButton}</> : "正在读取工作区统计…"}</div>;

  const items = [
    { label: "可复核草稿", value: c.artifacts, unit: "份", tone: "text-holo" },
    { label: "待您拍板", value: c.pending, unit: "项", tone: c.pending > 0 ? "text-gold" : "text-ink3" },
    { label: "团队成员", value: c.agents, unit: "人", tone: "text-go" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-card px-3 py-1.5">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5 text-body text-ink3">
          <span>{it.label}</span>
          <span className={`font-orb text-[15px] font-bold tracking-wider ${it.tone}`}
            style={{ animation: it.value !== null && it.value > 0 ? "wl-counter-breathe 2.4s ease-in-out infinite" : undefined }}>
            {it.value === null ? "—" : it.value.toLocaleString()}
          </span>
          <span>{it.unit}</span>
        </div>
      ))}
      {error && <div role="status" className="flex flex-wrap items-center gap-2 text-body text-warn"><span>统计暂不可用，当前显示上次结果</span>{retryButton}</div>}
      <style>{`@keyframes wl-counter-breathe { 0%,100% { opacity: 1; } 50% { opacity: .62; } }`}</style>
    </div>
  );
}
