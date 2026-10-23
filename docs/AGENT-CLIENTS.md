# 鹰眼桌面 Agent 接入

本文面向需要把已安装鹰眼接入 Codex、DeepSeek Harness 或其他办公 Agent 的使用者。完整、随服务端流程更新的业务引导见 [EAGLE-AGENT-GUIDE.md](EAGLE-AGENT-GUIDE.md)；安装与正式身份见 [EAGLE-PRODUCTION-INSTALL.md](EAGLE-PRODUCTION-INSTALL.md)。

## 从安装实例接入

客户端在本机支持目录 `agent-config/` 生成 `codex.toml`、`mcp.json` 和 `AGENT-INSTRUCTIONS.md`。这些文件使用本次安装的实际 Node、runtime、回环端口，不写模型密钥或正式成员 token。使用设置页展示的位置，避免连接到另一份运行中的实例。

正式服务能力优先使用进程环境的 `WORKLOOM_ACCESS_TOKEN`；仅本机回环可读取安装进程提供的会话秘密或 macOS Keychain 正式 token。不会匿名登录演示成员，也不会回退游客。远程连接必须 HTTPS 且自行提供正式 token，不读取本机凭据。

Codex 将生成的 `[mcp_servers.eagle]` 配置并入用户配置；通用 STDIO MCP 客户端使用 `mcp.json` 中的启动命令与环境。DeepSeek Harness 可用终端执行 CLI；所安装版本若支持 STDIO MCP，同样启动 `scripts/workloom-agent-mcp.mjs`。客户端专属插件字段仍以该客户端当前官方文档为准。

配置与协议依据：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[MCP 工具](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## 源码环境验证

源码环境遵循仓库 `package.json` 的 Node 要求。以下本地清单命令不请求模型：

```sh
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs describe consulting.workflow.submit
node scripts/workloom-agent.mjs config
printf '%s\n' '{}' | node scripts/workloom-agent.mjs invoke consulting.repo.status --input-file -
```

MCP 必须完成初始化通知后再操作：

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node scripts/workloom-agent-mcp.mjs
```

业务顺序为 `consulting.workforce.catalog → dossier.put/get → workflow.submit → advance/get → artifact.read`。复杂任务由服务端模型拆六步，固定诊断证据、报告、独立质检关卡；单员工使用该岗位和已绑定技能全文。每次写操作需要稳定幂等键。只有 `draft_ready` 且所有文件回读散列/事件回执通过，才可说内部草稿已生成；人类顾问仍须审阅定调，系统不会声称已外发。

能力清单中的岗位数和技能文件数是资产数量。当前受控执行面为授权文字资料分析和本机 Markdown 草稿。DOCX/PPTX、会计系统对账、访谈、会议、报价与外发等能力以 catalog 的 `unsupportedExecution` 如实列出。
