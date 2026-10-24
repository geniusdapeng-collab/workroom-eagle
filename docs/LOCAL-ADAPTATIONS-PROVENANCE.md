# 鹰眼本地适配与共享 UI 来源记录

这份文档面向本仓维护者与发布复核者。任务 `T-2026-1023-0001` 修复正式空白安装、正式成员鉴权、模型配置引导和真实结果展示，同时解决共享 UI 原下载地址不可用导致的冷安装阻断，见 [Eagle #21](https://github.com/geniusdapeng-collab/workroom-eagle/issues/21)。后续任务 `T-2026-1024-0001` 修复正常客户端的公开资料报告派单、实际错误和受控恢复动作，见 [Eagle #25](https://github.com/geniusdapeng-collab/workroom-eagle/issues/25)。当前累计清单继续以消费者审计基线 `2771ffeab0250c88ae25185c4f2eed923a773e6a` 为比较对象，保留此前适配和上游原始来源，并将新增必要修改逐文件登记到当前任务。

## 三份记录分别说明什么

- `.workloom-client-foundation.json` 保留原客户端壳的稳定标签、来源提交、版本和 `managedFiles` 指纹。本次任务不重写这些字段。
- `.workloom-ui-governance.json` 保留原 UI 治理脚本指纹和稳定升级策略。本次任务不重写这份原始记录。
- `.workloom-local-adaptations.json` 单独记录本仓的明确修补：消费者基线提交、两份原 state 的整文件 SHA256、任务与问题链接，以及每个文件的修改理由、修改前后 SHA256/模式、可复算 Git 补丁 SHA256。

适配清单中的 `baselineConsumerCommit` 是本仓消费者代码基线。原 state 的 `sourceCommit` 仍表示上游客户端壳来源；两者各自保留原义。客户端基座仍登记 `0.1.19`、`refs/tags/ui-v0.1.19`、来源提交 `2c5a02e8b4b3fb40b72549bc0a2c51539914c059`。当前清单明确登记 47 个文件及各自理由：保留前一任务的 37 项，并追加任务页、助手、反馈、咨询报告面板与相应行为回归等 9 个具体文件，再补充任务留言的持久恢复标识模块。任务留言只有取得真实事件回执才显示已生效，网络响应未知后的重传沿用原标识。前一任务的请求恢复、正式安装与三端消费者测试仍在清单内；本次不重写两份原始 state，也不扩大通用放行规则。门禁成功信息明确显示存在本地适配。发布报告应写“原始基座来源完整保留，存在已核验本地适配”，不能声称本仓修改与上游零漂移或已经上游批准。

## 哪些改动可以通过门禁

清单逐项列出具体文件路径与必要性说明，最多 100 个文件。每项必须满足以下条件：

1. 基线为本仓存在的完整 40 位提交，且属于当前 Git 历史。
2. 两份原 state 的基线原文、当前原文和文件模式一致。
3. 修改文件的 `before` 指纹与基线真实 blob 一致；新增文件在该基线中确实不存在。
4. `after` 指纹与当前非空普通文件一致，模式精确为 `0644` 或 `0755`。
5. `canonicalGitDiffSha256` 与执行器用固定 Git diff 参数重新计算的补丁一致。
6. 受管文件还必须匹配原 state 的那份 `before` 指纹，才能使用对应的 `after` 指纹验收。

路径越界、通配符、重复条目、符号链接、秘密配置文件、删除文件、修改原 state、未声明的客户端新增文件，以及封存后的内容或模式变化都会失败。任一适配条目失败时，适配清单不提供文件放行。

没有本地适配清单时，客户端基座消费门禁继续执行原受管指纹和新增文件白名单。清单仅解释已声明文件的本地差异；原有输入校验、UI AST 规则、授权、签名、资格门禁和测试仍须通过。

## 生成与复核

先完成源文件审查，再准备显式说明文件。它的结构为：

```json
{
  "baselineConsumerCommit": "本仓真实的完整基线提交",
  "task": {
    "id": "T-2026-1024-0001",
    "issue": "本次任务的明确 HTTPS issue 链接",
    "reason": "说明这组本地适配为何是当前正式安装和交付所必需"
  },
  "files": [
    {"path": "具体仓内文件路径", "reason": "说明这一文件的具体修改目的与边界"}
  ]
}
```

生成器只接受上面逐项列出的文件，不会自动将工作树所有改动加入放行范围。使用项目要求的 Node 版本，从仓库根运行：

```sh
node scripts/verify-local-adaptations.mjs seal --spec /absolute/path/to/reviewed-spec.json --repo .
node scripts/verify-local-adaptations.mjs --repo .
node scripts/verify-client-foundation-consumer.mjs --repo .
node scripts/verify-ui-consumer.mjs --repo . --require-governance-state
node --test scripts/verify-local-adaptations.test.mjs scripts/ui-offline-mirror.test.mjs
```

封存后若再修改声明文件，门禁会因内容、模式或补丁指纹变化而失败。维护者需要先复核新增差异，再有意重新封存。CI 需要完整 Git 历史才能读取消费者基线。未来稳定基座升级仍走原升级 PR 流程，并在新消费者基线上逐项重新核对保留的本地修补。

## 共享 UI 的同字节离线镜像

共享包仍是 `@workloom/ui@0.1.19`。`.workloom-ui.json#artifact` 继续保留原稳定版本、制品名、canonical URL 和 SHA512；`offlineMirror` 精确登记仓内 `vendor/workloom-ui-0.1.19.tgz` 作为原字节传输副本。`scripts/ui-offline-mirror.mjs` 同时校验：

- 镜像路径精确匹配原版本，所有目录与文件均不使用符号链接。
- 镜像声明的 canonical URL、SHA512 与原 `artifact` 一致。
- 镜像真实字节的 SHA512 与原制品记录一致。
- 不解包写盘，直接读取归档内 `package/package.json`，核对包名和版本。

根 `pnpm.overrides`、工作区覆盖和锁文件指向这一同字节 `file:` 副本，三端包的依赖版本仍为精确 `0.1.19`；UI 消费门禁继续检查其原版本和完整性。这不是重新构建或更换包版本。本地壳适配记录和共享 UI 制品来源分别复核，不能用更改旧指纹、删除检查或仅凭已有缓存来证明交付。

## 本次验收边界

本地适配与镜像回归证明的是声明范围、原始来源、文件完整性和门禁行为。本仓适配不向舰队基座或其他仓分发。业务能力与客户结果仍须分别查看真实模型回执、文件回读、真机操作和独立验收记录。封存清单本身不代表上游已合并这些本地修补，也不代表全部生产验收项通过。后续不得把重新生成哈希当作来源审查，也不得通过修改两份原始状态文件隐藏本仓修改。
