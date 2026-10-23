/**
 * welcomeScripts · 首装欢迎仪式话术配置（基座能力）
 *
 * 结构：S1 简短自我介绍 / S3 官方详细自我介绍 / S4 过渡引出团队 —— 全项目通用；
 *       S2 系统介绍 —— 由已验证的 Bundle UI 投影提供，缺省使用行业无关说明。
 *
 * 同步机制：仪式实现由基座共享；新项目按《欢迎仪式升级方案》§3.2-B-④
 *          在 Bundle 中补充自己的行业话术：
 *          必须基于该项目真实资产（README/配置/代码）撰写，名词数字逐条可溯源。
 */
import { clientChineseText } from "@workloom/ui";

export interface MateScript {
  /** S1 简短自我介绍（通用） */
  intro: string;
  /** S2 系统介绍（按行业切换，逐行字幕） */
  system: string[];
  /** S2 背景浮现的行业关键词 */
  keywords: string[];
  /** S3 官方详细自我介绍（通用，逐行字幕） */
  detail: string[];
  /** S4 过渡引出团队（通用） */
  bridge: string[];
}

/* ---------------- 通用段（全项目一致） ---------------- */

/** S1 · 简短自我介绍（v1.2 定稿） */
const INTRO =
  "老板您好，我是织伴，您的 AI 小秘书。";

/** S3 · 官方详细自我介绍（深入 + 通用，基座默认版） */
const DETAIL: string[] = [
  "请先提供授权资料和明确目标，系统按当前已接通的能力推进任务。",
  "我会说明任务依据和缺少的信息，未接通的工具不会被当作已经执行。关键判断仍由您确认。",
];

/** S4 · 过渡引出团队（衔接现有 CEO 带队仪式） */
const BRIDGE: string[] = [
  "接下来，请认识当前已装配的数字团队。",
];

/* ---------------- S2 · Bundle 投影 ---------------- */

/** 通用默认版（基座兜底） */
const SYSTEM_DEFAULT: string[] = [
  "这是您的数字工作区，当前已经装配的团队、技能和规则会在这里展示。",
  "您提供资料和任务后，系统只按当前实际支持的流程执行。",
  "每一步需要真实执行回执，缺少证据时会停下说明，结果与建议由您复核。",
];
const KEYWORDS_DEFAULT = ["授权资料", "受控流程", "关键判断人审", "结果可复核"];

export interface BundleWelcomeProjection {
  system: string[];
  keywords: string[];
  /** 主弹窗行业场景卡（真实业务价值前置）；缺省回落基座通用机制卡。 */
  cards?: Array<{ t: string; d: string }>;
}

function projectedChineseLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((line) => clientChineseText(line, ""))
    .filter((line) => line.length > 0);
}

/** 主弹窗场景卡投影：标题与正文都必须通过客户端中文校验，任一不合格即整组回落基座通用卡。 */
export function welcomeCardsOf(projection?: BundleWelcomeProjection | null): Array<{ t: string; d: string }> | null {
  if (!Array.isArray(projection?.cards)) return null;
  const cards = projection.cards
    .map((card) => ({
      t: clientChineseText(card?.t, ""),
      d: clientChineseText(card?.d, ""),
    }))
    .filter((card) => card.t.length > 0 && card.d.length > 0)
    .slice(0, 4);
  return cards.length > 0 ? cards : null;
}

/** 合并通用仪式文案与 Bundle 行业投影；基座不识别任何具体行业标识。 */
export function mateScriptOf(projection?: BundleWelcomeProjection | null): MateScript {
  const projectedSystem = projectedChineseLines(projection?.system);
  const projectedKeywords = projectedChineseLines(projection?.keywords);
  return {
    intro: INTRO,
    system: projectedSystem.length ? projectedSystem : SYSTEM_DEFAULT,
    keywords: projectedKeywords.length ? projectedKeywords : KEYWORDS_DEFAULT,
    detail: DETAIL,
    bridge: BRIDGE,
  };
}
