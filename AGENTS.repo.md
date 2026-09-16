# 鹰眼咨询仓库专属规则

## 责任边界

- 本仓是咨询行业经营体，产品身份由根目录 `product.manifest.json` 持有，默认行业包为 `bundles/consulting/`。
- `bundles/ai-pm/` 与 `bundles/hotel/` 仅暂留给既有双种子、桌面引导和回归测试兼容；它们不是本产品的默认包，也不得成为三端 UI 主导航来源。
- 咨询岗位、技能、企业档案、服务流程、前台文案和行业投影属于咨询 Bundle；不得硬编码进 WorkLoom IM 公共基座。
- 三端公共壳、导航、布局、状态模式和基础组件只能从 WorkLoom IM 的同一稳定标签升级。行业前端差异只能进入基座许可的 `extensions`、`projections`、`config/industry`、`theme/industry` 或 `public/industry` 路径。
- 初次会面、关键访谈、最终诊断和高风险建议必须保留人类顾问裁决；数字员工不得把草稿、模拟或无回执结果表述为正式咨询结论。
- 企业原始资料不得跨租户或直接上行蜂群；共享经验必须最小化、匿名化、白名单化并可审计。

## 本仓最低验证

在公共基座升级后，除基座统一下发的消费者门禁外，至少运行：

1. `pnpm product:verify`
2. `pnpm typecheck`
3. `pnpm test`
4. 使用隔离数据库运行 `pnpm db:seed`，确认咨询种子与三端行业投影一致
5. 具备隔离数据库时运行 `pnpm suite` 与 `pnpm release:gate`

发布前必须验证“一企一档”的租户负向用例、咨询行业主流程、C 端资料提交与工单真实回执，并完成秘密扫描。
