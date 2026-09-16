import { AsyncState, Badge, Card, Icon } from "@workloom/ui";
import { useNavigationAccess } from "../../shell/NavigationAccess";

type ConsultingView = "archives" | "issues" | "interviews" | "diagnosis" | "deliveries";

const VIEW_COPY: Record<ConsultingView, {
  title: string;
  description: string;
  focus: string;
  boundary: string;
  icon: "folder" | "tasks" | "document" | "radar" | "report";
}> = {
  archives: {
    title: "企业档案",
    description: "围绕同一家企业持续沉淀资料、访谈、判断依据与交付回执。",
    focus: "当前工作区的企业上下文与可追溯资料",
    boundary: "企业原始资料只在当前租户内使用；共享经验必须先完成最小化、匿名化与审计。",
    icon: "folder",
  },
  issues: {
    title: "咨询议题",
    description: "把经营问题拆成目标、事实、假设、证据和需要人类裁决的节点。",
    focus: "待分诊议题、处理中议题与阻断原因",
    boundary: "信息不足时先补证据，不把推测包装成正式结论。",
    icon: "tasks",
  },
  interviews: {
    title: "访谈资料",
    description: "统一整理访谈计划、纪要、来源和待确认事项。",
    focus: "访谈材料、来源状态与后续追问",
    boundary: "关键访谈由人类顾问主持；数字员工只负责准备、整理与提示矛盾。",
    icon: "document",
  },
  diagnosis: {
    title: "诊断研判",
    description: "将诊断过程与事实证据、反例和围栏裁决放在同一条可回放链路中。",
    focus: "诊断假设、证据强度与待审核判断",
    boundary: "最终诊断和高风险建议必须由人类顾问明确审核后才能对外。",
    icon: "radar",
  },
  deliveries: {
    title: "交付复盘",
    description: "跟踪报告审核、正式交付、客户反馈与后续价值兑现。",
    focus: "交付状态、真实回执与复盘动作",
    boundary: "没有客户可核验的真实回执，不把草稿、模拟或已发送等同于完成。",
    icon: "report",
  },
};

export default function ConsultingHub({ view }: { view: ConsultingView }) {
  const { bundle, bundleStatus, reload } = useNavigationAccess();
  const copy = VIEW_COPY[view];

  if (bundleStatus === "loading") {
    return <AsyncState status="loading" title={`正在读取${copy.title}`} description="正在核对当前工作区已安装的咨询行业包。" />;
  }
  if (bundleStatus === "error") {
    return <AsyncState status="error" title={`${copy.title}暂时无法读取`} description="行业投影未通过安全加载，系统没有使用默认数据兜底。" onRetry={reload} />;
  }
  if (!bundle || bundle.bundleId !== "consulting") {
    return <AsyncState status="empty" title="尚未装配咨询行业包" description="请先在装配中心为当前工作区启用鹰眼咨询行业包。" />;
  }

  return (
    <main className="mx-auto w-full max-w-[1180px] min-w-0 px-4 py-5 text-ink sm:px-6">
      <header className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2 text-gold">
            <Icon name={copy.icon} size={20} />
            <span className="text-caption font-semibold tracking-[.16em]">咨询经营</span>
          </div>
          <h1 className="break-words text-xl font-bold">{copy.title}</h1>
          <p className="mt-1 max-w-[52rem] break-words text-body leading-relaxed text-ink2">{copy.description}</p>
        </div>
        <Badge tone="neutral">{bundle.bundleName}</Badge>
      </header>

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="min-w-0">
          <h2 className="break-words text-body font-bold">当前关注</h2>
          <p className="mt-2 break-words text-body leading-relaxed text-ink2">{copy.focus}</p>
          <div className="mt-3 flex min-w-0 flex-wrap gap-2">
            {bundle.ui.objects.map((item) => (
              <Badge key={item} tone="neutral">{item}</Badge>
            ))}
          </div>
        </Card>

        <Card className="min-w-0">
          <h2 className="break-words text-body font-bold">人机协作边界</h2>
          <p className="mt-2 break-words text-body leading-relaxed text-ink2">{copy.boundary}</p>
          <p className="mt-3 break-words text-caption leading-relaxed text-ink3">
            页面只展示当前工作区已经验证的行业投影；权限、审批与回执仍由基座统一裁决。
          </p>
        </Card>
      </div>

      <Card className="mt-3 min-w-0">
        <h2 className="break-words text-body font-bold">标准咨询流程</h2>
        <ol className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {bundle.ui.workflows.map((item, index) => (
            <li key={item} className="min-w-0 rounded-lg border border-line bg-bg900 px-3 py-2">
              <span className="text-caption text-ink3">第 {index + 1} 步</span>
              <div className="mt-1 break-words text-body font-semibold text-ink">{item}</div>
            </li>
          ))}
        </ol>
      </Card>
    </main>
  );
}
