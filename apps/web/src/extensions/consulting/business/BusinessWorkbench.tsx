import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { AsyncState, Badge, SectionNavigation } from "@workloom/ui";
import { useNavigationAccess } from "../../../shell/NavigationAccess";
import { trpc } from "../../../lib/trpc";
import { BotPanel } from "./BotPanel";
import { BriefPanel } from "./BriefPanel";
import { SellerPanel } from "./SellerPanel";
import { useBusinessResource } from "./useWork";
import type { BusinessContext } from "./types";
type Mode = "brief" | "today" | "bot";

function BusinessMode({ scope, business, mode, artifactId, onViewBrief }: {
  scope: string;
  business: BusinessContext;
  mode: Mode;
  artifactId: string | null;
  onViewBrief: (artifactId: string) => void;
}) {
  const { memberId, members, canManage, canConfigureBot, canWrite, canConfirmAction, canDispatchBot } = business;
  const load = useCallback(async () => {
    if (mode === "bot") return { actions: [], facts: [] };
    const mine = mode === "today" ? { ownerMemberId: memberId } : {};
    const [actions, facts] = await Promise.all([
      trpc.business.listActions.query({ ...mine, limit: 100 }),
      mode === "today" ? trpc.business.listFacts.query({ ...mine, limit: 30 }) : Promise.resolve([]),
    ]);
    return { actions, facts };
  }, [memberId, mode]);
  const { value, loading, message, reload } = useBusinessResource(load);
  if (mode === "bot") {
    return <BotPanel scope={scope} canManage={canDispatchBot} canConfigure={canConfigureBot} onViewBrief={onViewBrief} />;
  }
  if (mode === "brief") {
    return <BriefPanel
      key={artifactId ?? "latest"}
      scope={scope}
      viewerMemberId={memberId}
      artifactId={artifactId}
      members={members}
      canAssign={canConfirmAction}
      canVerify={canConfirmAction}
      onViewBrief={onViewBrief}
      actions={value?.actions ?? []}
      actionsLoading={loading}
      actionsMessage={message}
      reloadActions={reload}
    />;
  }
  return <SellerPanel
    scope={scope}
    viewerMemberId={memberId}
    canCapture={canWrite}
    canImport={canManage && canWrite}
    actions={value?.actions ?? []}
    facts={value?.facts ?? []}
    loading={loading}
    message={message}
    reload={reload}
  />;
}

function Workbench({ scope }: { scope: string }) {
  const [params, setParams] = useSearchParams();
  const load = useCallback(() => trpc.business.context.query(), []);
  const context = useBusinessResource(load);
  const { value, loading, message, reload } = context;
  const allowed: Mode[] = value?.canManage ? ["brief", "today", "bot"] : ["today"];
  const requested = params.get("view");
  const mode = allowed.find((item) => item === requested) ?? (value?.canManage ? "brief" : "today");
  const artifactId = mode === "brief" ? params.get("artifact") : null;
  const names: Record<Mode, string> = { brief: "经营晨报", today: "我的今日", bot: "自动运行" };

  useEffect(() => {
    function refresh() { if (document.visibilityState === "visible") void reload(); }
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [reload]);

  function openMode(next: Mode, nextArtifact?: string) {
    setParams(nextArtifact ? { view: next, artifact: nextArtifact } : { view: next });
  }

  return <main className="mx-auto w-full max-w-[1320px] min-w-0 space-y-5 py-5 pl-24 pr-3 text-ink sm:pr-6 min-[821px]:pl-6">
    <header className="space-y-1 border-b border-line pb-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-ink">鹰眼经营工作台</h1>
        {value && <div className="flex flex-wrap items-center gap-2">
          {value.dataMode === "simulated" && <Badge tone="warning">示例工作区</Badge>}
          <Badge tone="neutral">{value.memberName}</Badge>
        </div>}
      </div>
    </header>
    {message && <AsyncState status="error" title="暂时无法打开经营工作台" description={message} onRetry={reload} />}
    {loading && !value && <AsyncState status="loading" title="正在确认此工作区的经营权限" />}
    {value && <div className={allowed.length > 1 ? "grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(128px,184px)_minmax(0,1fr)]" : "min-w-0"}>
      {allowed.length > 1 && <SectionNavigation
        label="经营工作台分区"
        items={allowed.map((id) => ({ id, label: names[id] }))}
        activeId={mode}
        onSelect={(item) => {
          const next = allowed.find((candidate) => candidate === item.id);
          if (next) openMode(next);
        }}
      />}
      <BusinessMode
        key={mode}
        scope={scope}
        business={value}
        mode={mode}
        artifactId={artifactId}
        onViewBrief={(artifact) => openMode("brief", artifact)}
      />
    </div>}
  </main>;
}

export default function BusinessWorkbench() {
  const { identityKey, scope, subject } = useNavigationAccess();
  if (!scope || !subject || subject.kind !== "member") {
    return <AsyncState status="forbidden" title="请使用有经营权限的企业成员账号" />;
  }
  const key = `${scope.tenantId}:${scope.workspaceId}:${identityKey}`;
  return <Workbench key={key} scope={key} />;
}
