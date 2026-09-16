/**
 * 鹰眼咨询行业巡检适配器登记表。
 *
 * 咨询 Bundle 当前未声明行业巡检实现。保持空目录使任何未知 adapterId
 * 失败关闭，并防止基座示例行业成为咨询产品的隐式回退。
 */
import type { InspectionAdapterRegistration } from "../service/inspection-adapter.js";

export const BUNDLED_INSPECTION_ADAPTERS: readonly InspectionAdapterRegistration[] = Object.freeze([]);
