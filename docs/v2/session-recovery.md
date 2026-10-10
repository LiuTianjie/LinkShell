# 会话恢复与 ACP 兼容

基础恢复策略始于 Host 0.4.19 / CLI 0.10.19。本文同时说明当前开发分支的 ACP 扩展；完整能力与验证边界见 [ACP 支持说明](acp-support.md)。

## 状态与历史是两件事

Host 的 SQLite 保存会话摘要与已经导入的消息。摘要出现在列表里，不代表当前仍有 Agent 在执行，也不代表原始消息已经加载。

- Host 启动时，先把上次留下的 `running` / `waiting` 和审批标记置为待重新连接的 `offline`，清除过期的异步问题缓存；各驱动再根据当前证据恢复状态。历史、标题、归档和活动时间保留。
- 普通发现列表有分页与数量限制。没有出现在这一页里不能证明会话已删除，不据此删除或归档记录。
- 读取失败通过已有的 `ls_error` 返回给手机，摘要退出“运行中”，同时提供本地已缓存的消息；再次打开会重试。刚创建、尚未发消息的会话另行处理。
- 基础恢复修复使用原有会话状态和事件协议。新增 ACP 内容、授权和编辑交互需要配套客户端；Mac 屏幕组件不在这次 ACP 改动范围内。

## 各驱动的依据

| 驱动 | 活动状态 | 历史与归档 |
|---|---|---|
| Codex | 已订阅会话以实时事件为准；外部会话读取 rollout 的当前回合。`task_complete` 和 `turn_aborted` 都结束运行状态。 | 原生归档同步到 LinkShell；归档历史通过 `thread/read` 读取，不解除归档，不启动 Agent。 |
| Claude | Host 驱动的回合使用本连接状态；桌面会话结合转录内容、持有会话的进程与终端注册判断。进程消失时清除未闭合的运行状态。 | 原始 transcript 缺失时明确报错，保留缓存，并允许记录恢复后再次导入。归档仅作用于 LinkShell；重命名和删除使用 Claude 原生记录。 |
| 通用 ACP | ACP 1 的 `session/list` 没有标准运行状态字段，不能沿用 SQLite 的旧运行标记。以本 Host 当前回合、审批和提问为准；ACP 2 使用 `state_update`，prompt 的确认响应不结束回合。 | 初始化完成后才读取能力；ACP 1 支持 `loadSession` 时加载历史，仅支持 `resume` 时提示只能显示缓存及之后的新消息；ACP 2 从头回放并按消息 ID 合并。归档仅作用于 LinkShell。 |

Codex 归档发现读取当前 `CODEX_HOME/archived_sessions` 下的 rollout 文件名，只更新 Host 已知的会话，不把整个原生归档导入列表。这是 Codex 本地存储兼容逻辑，不是 ACP API。原文件内容仍通过 app-server 读取。

Claude 对没有进程持有记录的旧版本保留有时间窗口的兼容判断。静止的 JSONL 文件不能证明 Agent 永远在线；独立运行的第三方 ACP CLI 也不因此变成可被本 Host 实时控制的会话。

## ACP 版本

LinkShell 的 v2 架构、Codex app-server 的 v2 API、网关的 `/v2/connect` 与 **ACP 2** 没有版本绑定关系。

当前稳定接入使用 `initialize.protocolVersion = 1`，并校验 Agent 返回的版本。缺失或不支持的版本会关闭连接、明确报告不兼容；不会把另一版本的消息按 ACP 1 解析，也不会因确定的版本不兼容反复自动重启进程。

[ACP 1 会话协议](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)明确区分：

- `session/load`：协商了 `loadSession` 后调用，在响应前通过 `session/update` 回放历史。
- `session/resume`：协商了 `sessionCapabilities.resume` 后调用，恢复上下文但不回放历史。LinkShell 提供说明，不把空历史冒充为成功加载的完整对话。

[ACP 2 迁移指南](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx)目前仍将整体协议标为 draft。当前分支提供默认关闭的 ACP 2 开关，允许协商回 ACP 1；后续按实际版本处理消息。ACP 2 的 `session/prompt` 响应只确认消息已插入，结束状态由 `state_update` 推送；历史恢复使用 `session/resume` 加 `replayFrom: { type: "start" }`。完整消息替换、字段显式清空、终端输出、权限结构和配置同步分别适配，重放中尚未完成的工具和计划也保留。

2026-10-10 对本机真实进程执行了只读初始化握手，没有发送任务：

| Agent | 握手报告的版本 | ACP | 历史能力 |
|---|---|---|---|
| Claude 适配器 | 0.84.0 | 1 | `loadSession`、`resume`、`list` |
| Copilot | 1.0.95 | 1 | `loadSession`、`list` |
| Gemini | 0.62.0 | 1 | `loadSession`，未声明 `list` |
| Grok | 未报告 Agent 版本 | 1 | `loadSession`、`resume`、`list` |

这是该次安装环境的证据，不代表这些产品未来所有版本。Gemini 支持历史恢复，但按需启动；必须先初始化再检查其能力。OpenCode、Cursor 未在本次环境安装，不能把协议夹具测试当作它们的真实运行验证。

## 验证与交付

- `session-recovery.e2e.test.ts` 覆盖跨重启的旧状态、发现窗口之外的会话、按需启动、仅恢复不回放、Claude 原记录缺失后恢复、持有进程消失以及不兼容协议。
- `codex-attention.test.ts`、`codex-archives.test.ts` 和 `hub.test.ts` 覆盖中断、原生归档、只读历史、缓存保留与失败重试。
- 真实初始化握手只证明版本与声明的能力；真实问答、接力、审批用 `live:codex` / `live:claude` 验证，手机交互需要单独验证。
- 2026-10-10 的基础恢复版本真实 Codex 检查 8/8 通过（问答流、审批、多客户端与终端入口）；Claude Code 2.1.168 接力检查 13/13 通过（历史导入、手机继续、交还终端、上下文连续与消息去重）。这不是新增 ACP 扩展的真机证明。当前分支证据见 [ACP 支持说明](acp-support.md)。
- 配套更新应按 [完整发版 SOP](../release-sop.md) 处理 wire、Host、CLI、App 和网关内置网页。版本号和发布由负责更新的会话统一安排。
