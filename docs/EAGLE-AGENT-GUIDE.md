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
3. `consulting.workflow.submit`：提交企业 ID、完整原始目标、至少八字符的幂等键。保留原题的数量、周期、排序、负责人、验收、回退和人审要求，不以摘要替换原问题；提交前逐项比对，提交后回读 `goal` 核对。单员工任务明确 `employeeKey`，可选指定该员工已经绑定的 `skillId`；复杂任务省略这两项，让真实模型拆解。
4. 复杂任务由服务端检查六个步骤：诊断证据 → 三名不同的专业员工 → 报告草稿 → 独立质检官红队复核。专业角色与各环节具体目标由真实模型产生；服务端固定必需关卡并生成依赖，不接受客户端自造完成状态或任意步骤序号。质检官必须返回结构化 `reviewDecision`；`changes_requested` 或 `rejected` 会保留草稿供人处理，但任务进入 `human_required`，不能当作质检通过。
5. `consulting.workflow.advance`：服务端只推进下一个拥有前序产物与回执的步骤。每次推进传新的稳定幂等键；同一请求重传必须沿用原键。不要用不同键重发结果未知的模型调用。
6. `consulting.workflow.get`：每步后回读状态、模型请求 ID/usage/预算 reservation、前序产物散列及事件 ID。`queued` 可以继续；`running` 或 `planning` 应查询并等待；`blocked` 应保留失败回执并排查，不得自行编写结果或重复付费冒充修复。
7. 全部步骤完成后只会到 `draft_ready`，并保留 `humanReviewRequired=true`。调用 `consulting.artifact.read` 回读每件 Markdown，核对 `sha256`、`bytes` 与 `receipt.synced=true`。这表示内部草稿已生成，不表示客户事实已经审计、不表示人类顾问已定调或已向客户发送。

服务端不给 Agent “直接写产物”“修改执行状态”“跳到某一步”的入口。未知字段、未绑定技能、跨工作区任务、缺前序回执、被修改的本地文件、资产版本漂移和配额不足均失败关闭。分析模型接收资料的 `id` 与 `content`；存储的资料标题与摘要仍保留，但不作为可引用正文传入分析提示。引用必须逐字出现在对应 `content`，包括 Markdown 中实际存在的反斜杠；只有标题包含的期间、数字或其他事实不能推作正文已证实，必须列为资料缺口。

## 客户端、CLI 与 MCP 的公开研究报告

在经营主页提交地区或产业研究报告目标后，咨询行业执行桥会先检索和读取政府官网公开页面，在本机冻结供应商实际返回的完整正文，再向上述六员工流程提供有明确字节范围和散列的原文摘录。来源面板展示 URL、发布日期、采集时间、全文与摘录的字节数；摘录合计受 4000 UTF-8 字节的资料契约约束，不能据此声称模型通读了全部网页。报告正文、独立质检、引用目录和支撑分析汇编为一个可回读的 Markdown 内部待审稿。没有取得适用地区与行业的官网正文、没有真实模型或文件回执时，任务保留具体错误，不生成替代来源或完成状态。

公开研究入口不接受客户内部报表、私密资料、外发和代为访谈目标。客户授权资料继续走一企一档和受控 CLI/MCP 流程。旧任务保持原有执行来源和失败记录；不会因为标题中出现“报告”就被重分类成已经成功的新报告。

客户端在发送前持久保存本次提交标识。双击、运输中断或刷新后先查询原请求，禁止换标识重复购买分类、规划或报告。模型、搜索和网页读取都绑定同一任务预算；相同操作只能复用原始供应商回执，结果未知时停止后续调用。活动行业包无法核验时拒绝新的模型请求，不回退共享模型池。转人工会追加事件并暂停后续自动步骤；明确继续后沿用原流程。停止任务保留资料、已发生费用和草稿，不再启动后续步骤，也不声称撤销已经发生的外部动作。界面只有收到真实操作回执才展示动作已记录。

办公 Agent 可以通过同一份能力清单直接使用这条公开研究链路：

| 能力 | 输入与核对 |
|---|---|
| `consulting.task.dispatch` | `requestId` 为新建任务前已保存的 UUID；`title` 为公开议题；`runImmediately` 默认 `false`，交正常后台调度。`goalRef`、`presetKey` 为可选字段，可显式为 `null`。提交返回 `pending` 仅表示尚无报告交付证明。 |
| `consulting.task.dispatch_request` | 只传原 `requestId`，找回原提交与当前 `threadId`。只读恢复不会重新分类或派遣；`dispatching`、`not-found` 或未知响应时保留原标识与错误，禁止换号重购。 |
| `core.threads.get` / `consulting.task.view` | 只传服务端返回的 `threadId`，轮询线程与咨询流程。`task.view` 保留真实 `lastReceipt`、`runId`、进度、官网来源、全文/摘录散列和可用控制动作；刚排队尚未绑定咨询流程时继续查询原线程。 |
| `consulting.task.report` | `task.view.status` 达到 `draft_ready` 后回读原 `threadId` 的实际 Markdown `content`，独立计算 SHA256 和 UTF-8 字节数，与 `sha256`、`bytes`、报告 `receipt.eventId` 及视图 `finalArtifact` 对照。需要核对每步时，用返回的 `runId` 读取 `consulting.workflow.get` 与每件 `consulting.artifact.read`，无需重新执行。 |
| `consulting.task.action` | 传 `threadId`、`action`（`resume` / `handoff` / `cancel`）、至少八字符的稳定 `idempotencyKey`，可附 `reason`。只在服务端表示动作可用时操作；回读并核对该次 `actionReceipt`，不能借另一条 `lastReceipt` 宣称操作成功。 |

`task.dispatch` 的幂等字段明确为 `requestId`；其余变更能力默认使用 `idempotencyKey`。输入不接受完成状态、任意阶段、产物或租户覆盖字段。`task.view`、`task.report`、`task.action` 的回执字段由受审能力清单分别声明为 `lastReceipt`、`receipt`、`actionReceipt`；缺失、格式错误、未同步或没有非空事件 ID 均失败。运输层不会凭任务状态补造回执，也不把“已转人工”当成“报告已交付”。

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

公开研究使用独立输入文件，先生成并保存本次 UUID，再填入如下字段；重传和恢复使用同一 UUID：

```json
{"requestId":"6d82ac53-32cb-4b27-b468-a6d829f4a2e5","title":"做一个温州地区制造业的分析报告","runImmediately":false}
```

```sh
node scripts/workloom-agent.mjs invoke consulting.task.dispatch --input-file public-task-input.json
node scripts/workloom-agent.mjs invoke consulting.task.dispatch_request --input-file original-request-input.json
node scripts/workloom-agent.mjs invoke consulting.task.view --input-file original-thread-input.json
node scripts/workloom-agent.mjs invoke consulting.task.report --input-file original-thread-input.json
```

`original-request-input.json` 只有原 `requestId`；`original-thread-input.json` 只有服务端实际返回的 `threadId`。示例 UUID 只用于说明格式；新业务任务必须自行生成自己的标识，不能把示例当作所有任务共用的提交键。公开研究会产生实际模型与搜索费用；列工具、描述输入、查原状态和回读文件不会发起新的报告生成。

## Codex 与通用 MCP 配置

安装后由客户端在本机支持目录的 `agent-config/` 生成三份无秘密文件：`codex.toml`、`mcp.json` 和 `AGENT-INSTRUCTIONS.md`。它们使用本次安装的实际 Node、runtime 与回环端口，无需全局安装 Node，也不把 Keychain token 写进配置。生成器为 `scripts/agent-client-config.mjs`；完整引导为本文件。源码调试可用 CLI 的 `config` 命令输出与当前根目录绑定的配置。

Codex 将生成的 `[mcp_servers.eagle]` 配置并入自己的用户配置。其 `command`、`args`、`cwd`、`env`、`startup_timeout_sec`、`tool_timeout_sec` 字段已按[官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp)核对。其他支持 STDIO MCP 的办公平台使用 `mcp.json` 中的服务器命令和环境；界面字段名称按该平台当前文档填写，不要将通用 JSON 误称为某个平台已验证的插件格式。

DeepSeek Harness 可直接用其终端工具执行上述 CLI；如果所安装版本支持 STDIO MCP，服务器进程也是 `workloom-agent-mcp.mjs`。客户端是否支持某版本的插件安装方式应另按其当前官方文档核对，本引导不虚报已验证的 DSH 桌面插件接口。

MCP 先 `initialize`、再发 `notifications/initialized`，之后才可 `tools/list` / `tools/call`。`initialize.instructions` 同样包含禁止跳步与内部草稿边界；工具注解不代替服务端授权。协议依据：[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## 正式身份、数据与恢复

CLI/MCP 优先读取进程环境的 `WORKLOOM_ACCESS_TOKEN`。仅连接本机回环地址时，还可用桌面进程持有的 `WORKLOOM_DESKTOP_SESSION_SECRET` 获取正式会话，或在 macOS 从 Keychain `com.workloom.eagle.agent-access` / `local-owner` 读取客户端启动时更新的正式 token。远程 HTTPS 不读取本机 Keychain；不匿名登录演示成员，也不回退游客。Windows 当前需通过进程环境提供正式 token；本轮本地客户端实测目标为 macOS arm64。

默认已安装服务地址从 `product.manifest.json#desktop.portOffset` 计算；当前产品偏移 110，即 `127.0.0.1:8897`。源码启动、隔离沙箱或多实例显式设置 `WORKLOOM_BASE_URL`，必须指向本次测试的同一实例。不要靠端口已响应来猜它是本次启动的实例。

档案与执行状态由带租户/工作区双边界的只增事件持久化；每个任务还冻结岗位与技能指纹。草稿保存在本机支持目录的 `consulting/`，或显式的 `WORKLOOM_CONSULTING_DATA_DIR`。每个步骤之间可调用 `consulting.workflow.pause` / `resume`，恢复沿用同一计划和已核验产物。进程在付费请求中断时，未知用量保留预算预占并停止后续调用，不把重启当作配额重置。

每个业务任务的硬上限为 40 次 LLM / 30 万累计 token / 45 分钟 / 估算人民币 120 元，搜索与抓取合计至多 8 次；预算按稳定任务身份持久化。验收可以用 `WORKLOOM_CONSULTING_BUDGET_FILE` 显式共用一个跨沙箱/客户端总账本，目录及账本须为本机私有普通文件，不得以目录链接、文件链接或放宽权限改变其边界。每份结构化草稿上限为 14000 UTF-8 字节，单次完整输入上限为 100000 UTF-8 字节。每名员工接收岗位与所选技能全文、完整原始授权资料，以及所有更早已完成步骤的完整结构化产物、事件 ID 和文件散列；服务端交接前逐件回读文件并核验，不以摘要或散列代替前序正文。提交时预检后续每步的完整提示长度上界，发请求前再次检查实际字节数；超限先报错，不截断资料或专业意见。新完成事件中的 `inputDisclosure` 记录完整前序步骤清单、输入字节数与摘要；旧事件没有该记录时不能追认为已使用新上下文。已产生但未通过结构、引用或显式数值矛盾校验的真实模型回复会保存为“被拒候选输出”及模型用量回执，不能当成交付物，也不会进入下一环节。含凭据的供应商回复会在持久化前拒绝，保留不能自动重购的错误状态。

数值检查只覆盖有限语法内可识别的显式算式、紧邻数值推导的百分比与确定的单位/除零矛盾。未支持的公式、来源真实性、业务假设、财务含义和只写文字的测算仍需人工复核。全文交接与数值检查已用原始付费产物回放和免费夹具测试验证；2026-10-23 开始的首轮 40 次真实调用来自此前仅直接依赖全文的版本，不能视作后续版本的真实模型完整复考。各轮实测应分别回读源码版本、原始任务、账本和产物，不得把历史成功移记到当前版本。首轮范围与原始内容失败见 [真实模型验收说明](CONSULTING-LIVE-EVALUATION.md)。

若失败来自本机产物 JSON/结构/大小校验，并且已保存完整候选文件和供应商回执，可在修复校验实现后调用 `consulting.workflow.revalidate`，输入仍仅为 `runId`、`idempotencyKey`。服务端只读原始候选文件，核对路径、散列、字节数、原执行认领与真实请求，再重跑来源引用、显式数值矛盾、前序产物和当前员工/围栏检查。原失败与候选文件完整保留，接受时另写 Markdown 并追加引用原失败的重验事件；不会再次请求模型或重复记录原调用用量。显式数值矛盾不能通过重验入口被提升为成功；资料/提示/模型版本发生变化、原调用结果未知、原文件缺失/篡改或内容仍不满足现行契约时，重验失败。客户端没有上传或改写候选的入口。

## 结果核对清单

- 把原始问题和每件真实产物逐项对照；`draft_ready`、事件同步及岗位覆盖只证明执行结构，不代表专业质量或客户放行。
- 复杂任务终态必须核对第六步质检官的 `reviewDecision=approved`；若为 `changes_requested`/`rejected`，报告仅是可读草稿，任务仍需人类按质检意见处理。
- 独立复算金额、天数和收益差值，区分工时与金额单位；核对完整数量、排序、责任矩阵、回退条件和人审要求。质检官本身也可能漏错，其“挂起”意见必须保留。
- 未检索到资源、没有可用资源库或没有检索回执，分别按实际缺口表述；不能推成“无人选”。资料不涉密也不能推出跨境风险不存在，建议话术不得虚构其他客户经历。
- 回执确实属于当前租户、企业、任务与步骤，且每件本地文件可回读、散列相符。
- 引用文字确实存在于冻结的原资料；客户自述、模型推断、测算假设和缺失证据没有混为已核实事实。
- 专业岗位、绑定技能全文、模型版本、真实请求 ID、usage 与配额 reservation 可追溯。
- 六步复杂任务没有跳过诊断、前序依赖、报告或独立红队；单员工任务没有虚报其他员工协作。
- 人类顾问的会面、访谈、诊断定调、谈判和外发审批仍由人完成，内部草稿不会被表述成正式生效结果。
