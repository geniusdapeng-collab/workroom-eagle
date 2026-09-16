import ConsultingHub from "./ConsultingHub";

/**
 * 鹰眼咨询页面只在行业扩展目录注册。入口、权限与排序均来自已经验证的
 * consulting Bundle；受管 App 壳和左侧导航保持由 WorkLoom IM 基座统一提供。
 */
export const industryRoutes = [
  { path: "/consulting/archives", capabilityId: "consulting.archives", element: <ConsultingHub view="archives" /> },
  { path: "/consulting/issues", capabilityId: "consulting.issues", element: <ConsultingHub view="issues" /> },
  { path: "/consulting/interviews", capabilityId: "consulting.interviews", element: <ConsultingHub view="interviews" /> },
  { path: "/consulting/diagnosis", capabilityId: "consulting.diagnosis", element: <ConsultingHub view="diagnosis" /> },
  { path: "/consulting/deliveries", capabilityId: "consulting.deliveries", element: <ConsultingHub view="deliveries" /> },
] as const;
