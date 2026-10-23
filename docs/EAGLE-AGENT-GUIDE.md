# 鹰眼：供 Codex、DeepSeek Harness 与其他办公 Agent 使用

这份引导面向调用已经安装的鹰眼系统的办公 Agent。默认使用真实、空白的客户工作区和正式安装所有者身份。首次安装不会写入模拟企业、模拟业绩、模拟对话或游客账号。模型密钥由本机受保护凭据提供，不能复制到本文件、客户端 MCP 配置、提示词或 Git 仓库。

装机人员需要导入或更换模型密钥时，遵循同目录的 [正式本机安装说明](EAGLE-PRODUCTION-INSTALL.md)。正式客户端的落地向导只验证当前受保护配置，不通过网页保存明文模型密钥。

## 先检查当前安装与能力边界

先读取 `consulting.workforce.catalog`，确认工作区的咨询装配已经通过验证，并读取每名员工当前绑定的技能与支持面。22 名员工和 199 个技能文件是资产清单；能力是否已接通，应看 `supportedExecution`、`unsupportedExecution` 与实际任务回执。

当前受控任务入口实际支持：创建和读取客户授权的文字资料档案；装配员工的真实岗位提示与一项已绑定技能全文；使用 DeepSeek 真实推理生成材料分析；逐条核对引用是否存在于原资料；生成本机 Markdown 内部草稿；写盘后回读 SHA256、字节数和五元事件回执；六员工有序协作和步骤间暂停/恢复。岗位中列出的 DOCX/PPTX 排版、业务系统会计对账、真实录音转写、专家联络、正式报价、对外发送、访谈或会面不因此自动成为已接通的执行能力。

DeepSeek 的请求模型 ID 为 `deepseek-flash`；连接器先读取供应商 `/models` 元数据，核对 V4.1 Flash 系列与已核验的上下文/输出上限，拒绝静默换模型。产品显示名为 `DeepSeek V4.1 Flash 1017`。真实搜索使用供应商独立搜索/抓取接口；普通文本推理本身不代表已经联网搜索。搜索摘要也不等于事实已独立核实。模型与搜索接口依据：[DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing/)、[搜索文档](https://api-docs.deepseek.com/guides/search/)。

## 必须执行的业务顺序

1. `consulting.dossier.put`：为本工作区的企业创建授权资料快照。每份资料含唯一 `id`、`title`、`content`；1–8 份合计至多 4000 UTF-8 字节。资料与目标中的明显凭据及服务端已知密钥在写入前拒绝；其余资料经 PII 脱敏后进入本机一企一档，事实属性是“客户提供、未独立核实”。超过上限要按议题拆分，禁止悄悄删资料。
2. `consulting.dossier.get`：回读企业资料版本、`sourceDigest` 和事件回执。企业 ID 不能用来指定其他租户或工作区。
3. `consulting.workflow.submit`：提交企业 ID、明确目标、至少八字符的幂等键。单员工任务明确 `employeeKey`，可选指定该员工已经绑定的 `skillId`；复杂任务省略这两项，让真实模型拆解。
4. 复杂任务由服务端检查六个步骤：诊断证据 → 三名不同的专业员工 → 报告草稿 → 独立质检官红队复核。专业角色与各环节具体目标由真实模型产生；服务端固定必需关卡并生成依赖，不接受客户端自造完成状态或任意步骤序号。
5. `consulting.workflow.advance`：服务端只推进下一个拥有前序产物与回执的步骤。每次推进传新的稳定幂等键；同一请求重传必须沿用原键。不要用不同键重发结果未知的模型调用。
6. `consulting.workflow.get`：每步后回读状态、模型请求 ID/usage/预算 reservation、前序产物散列及事件 ID。`queued` 可以继续；`running` 或 `planning` 应查询并等待；`blocked` 应保留失败回执并排查，不得自行编写结果或重复付费冒充修复。
7. 全部步骤完成后只会到 `draft_ready`，并保留 `humanReviewRequired=true`。调用 `consulting.artifact.read` 回读每件 Markdown，核对 `sha256`、`bytes` 与 `receipt.synced=true`。这表示内部草稿已生成，不表示客户事实已经审计、不表示人类顾问已定调或已向客户发送。

服务端不给 Agent “直接写产物”“修改执行状态”“跳到某一步”的入口。未知字段、未绑定技能、跨工作区任务、缺前序回执、被修改的本地文件、资产版本漂移和配额不足均失败关闭。模型引用必须逐字出现在原始资料中；虚构出处不会被记为成功。

## CLI

使用安装包自带的 Node 和 runtime 路径；从设置页“Agent 接入”读取实际文件位置。源码开发时可在已安装 Node 24 的环境从仓库根执行：

```sh
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs describe consulting.workflow.submit
printf '%s\n' '{}' | node scripts/workloom-agent.mjs invoke consulting.workforce.catalog --input-file -
```

建立档案的输入示例（仅说明字段，企业资料须由使用者提供真实授权内容）：

```json
{"enterpriseId":"customer-a","sources":[{"id":"meeting-note","title":"客户授权纪要","content":"在此放入已获授权的原文资料"}],"idempotencyKey":"customer-a-dossier-v1"}
```

依次保存实际请求为本机输入文件，再执行：

```sh
node scripts/workloom-agent.mjs invoke consulting.dossier.put --input-file dossier-input.json
node scripts/workloom-agent.mjs invoke consulting.workflow.submit --input-file task-input.json
node scripts/workloom-agent.mjs invoke consulting.workflow.advance --input-file advance-input.json
node scripts/workloom-agent.mjs invoke consulting.workflow.get --input-file run-input.json
node scripts/workloom-agent.mjs invoke consulting.artifact.read --input-file artifact-input.json
```

`task-input.json` 使用 `enterpriseId`、`goal`、`idempotencyKey`；`advance-input.json` 使用服务端返回的 `runId` 和本次 `idempotencyKey`；`run-input.json` 只有 `runId`；产物读取再加 `stepId`。文件只留在客户本机受保护资料区，不进入源码仓库。服务端运输超时对执行能力为 120 秒，客户端工具超时应大于此值；网络中断后先回读原任务，禁止换幂等键盲重试。

## Codex 与通用 MCP 配置

安装后由客户端在本机支持目录的 `agent-config/` 生成三份无秘密文件：`codex.toml`、`mcp.json` 和 `AGENT-INSTRUCTIONS.md`。它们使用本次安装的实际 Node、runtime 与回环端口，无需全局安装 Node，也不把 Keychain token 写进配置。生成器为 `scripts/agent-client-config.mjs`；完整引导为本文件。源码调试可用 CLI 的 `config` 命令输出与当前根目录绑定的配置。

Codex 将生成的 `[mcp_servers.eagle]` 配置并入自己的用户配置。其 `command`、`args`、`cwd`、`env`、`startup_timeout_sec`、`tool_timeout_sec` 字段已按[官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp)核对。其他支持 STDIO MCP 的办公平台使用 `mcp.json` 中的服务器命令和环境；界面字段名称按该平台当前文档填写，不要将通用 JSON 误称为某个平台已验证的插件格式。

DeepSeek Harness 可直接用其终端工具执行上述 CLI；如果所安装版本支持 STDIO MCP，服务器进程也是 `workloom-agent-mcp.mjs`。客户端是否支持某版本的插件安装方式应另按其当前官方文档核对，本引导不虚报已验证的 DSH 桌面插件接口。

MCP 先 `initialize`、再发 `notifications/initialized`，之后才可 `tools/list` / `tools/call`。`initialize.instructions` 同样包含禁止跳步与内部草稿边界；工具注解不代替服务端授权。协议依据：[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## 正式身份、数据与恢复

CLI/MCP 优先读取进程环境的 `WORKLOOM_ACCESS_TOKEN`。仅连接本机回环地址时，还可用桌面进程持有的 `WORKLOOM_DESKTOP_SESSION_SECRET` 获取正式会话，或在 macOS 从 Keychain `com.workloom.eagle.agent-access` / `local-owner` 读取客户端启动时更新的正式 token。远程 HTTPS 不读取本机 Keychain；不匿名登录演示成员，也不回退游客。Windows 当前需通过进程环境提供正式 token；本轮本地客户端实测目标为 macOS arm64。

默认已安装服务地址从 `product.manifest.json#desktop.portOffset` 计算；当前产品偏移 110，即 `127.0.0.1:8897`。源码启动、隔离沙箱或多实例显式设置 `WORKLOOM_BASE_URL`，必须指向本次测试的同一实例。不要靠端口已响应来猜它是本次启动的实例。

档案与执行状态由带租户/工作区双边界的只增事件持久化；每个任务还冻结岗位与技能指纹。草稿保存在本机支持目录的 `consulting/`，或显式的 `WORKLOOM_CONSULTING_DATA_DIR`。每个步骤之间可调用 `consulting.workflow.pause` / `resume`，恢复沿用同一计划和已核验产物。进程在付费请求中断时，未知用量保留预算预占并停止后续调用，不把重启当作配额重置。

每个业务任务的硬上限为 40 次 LLM / 30 万累计 token / 45 分钟 / 估算人民币 120 元，搜索与抓取各至多 8 次；预算按任务持久化。验收可以用 `WORKLOOM_CONSULTING_BUDGET_FILE` 显式共用一个跨沙箱/客户端总账本。每份结构化草稿上限为 10000 UTF-8 字节，单次完整输入上限为 64000 UTF-8 字节。每名员工接收岗位与所选技能全文、完整原始授权资料，以及所有更早已完成步骤的完整结构化产物、事件 ID 和文件散列；服务端交接前逐件回读文件并核验，不以摘要或散列代替前序正文。提交时预检后续每步的完整提示长度上界，发请求前再次检查实际字节数；超限先报错，不截断资料或专业意见。新完成事件中的 `inputDisclosure` 记录完整前序步骤清单、输入字节数与摘要；旧事件没有该记录时不能追认为已使用新上下文。已产生但未通过结构、引用或显式数值矛盾校验的真实模型回复会保存为“被拒候选输出”及模型用量回执，不能当成交付物，也不会进入下一环节。

数值检查只覆盖有限语法内可识别的显式算式、紧邻数值推导的百分比与确定的单位/除零矛盾。未支持的公式、来源真实性、业务假设、财务含义和只写文字的测算仍需人工复核。最终全文交接与数值检查已用原始付费产物回放和免费夹具测试验证；本轮 40 次真实调用来自此前仅直接依赖全文的版本，不能视作最终版本的真实模型完整复考。实测范围与原始内容失败见 [真实模型验收说明](CONSULTING-LIVE-EVALUATION.md)。

若失败来自本机产物 JSON/结构/大小校验，并且已保存完整候选文件和供应商回执，可在修复校验实现后调用 `consulting.workflow.revalidate`，输入仍仅为 `runId`、`idempotencyKey`。服务端只读原始候选文件，核对路径、散列、字节数、原执行认领与真实请求，再重跑来源引用、显式数值矛盾、前序产物和当前员工/围栏检查。原失败与候选文件完整保留，接受时另写 Markdown 并追加引用原失败的重验事件；不会再次请求模型或重复记录原调用用量。显式数值矛盾不能通过重验入口被提升为成功；资料/提示/模型版本发生变化、原调用结果未知、原文件缺失/篡改或内容仍不满足现行契约时，重验失败。客户端没有上传或改写候选的入口。

## 结果核对清单

- 回执确实属于当前租户、企业、任务与步骤，且每件本地文件可回读、散列相符。
- 引用文字确实存在于冻结的原资料；客户自述、模型推断、测算假设和缺失证据没有混为已核实事实。
- 专业岗位、绑定技能全文、模型版本、真实请求 ID、usage 与配额 reservation 可追溯。
- 六步复杂任务没有跳过诊断、前序依赖、报告或独立红队；单员工任务没有虚报其他员工协作。
- 人类顾问的会面、访谈、诊断定调、谈判和外发审批仍由人完成，内部草稿不会被表述成正式生效结果。
