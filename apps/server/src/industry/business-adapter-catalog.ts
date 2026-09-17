/**
 * 鹰眼咨询行业业务适配器登记表。
 *
 * 当前咨询服务前台只使用通用对话与工单，没有声明行业数据适配器；保持空表可
 * 让未知或伪造的适配器标识失败关闭，也避免兼容酒店包成为咨询产品的默认实现。
 */
import type { BusinessAdapterRegistration } from "../service/adapters/business.js";

export const BUNDLED_BUSINESS_ADAPTERS: readonly BusinessAdapterRegistration[] = Object.freeze([]);
