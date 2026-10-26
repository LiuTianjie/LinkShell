# 会话恢复与 ACP 兼容

驱动行为的统一定义与新增 Agent 的接入约束见 [Agent 适配行为契约](agent-behavior.md)。

基础恢复策略始于 Host 0.4.19 / CLI 0.10.19。本文同时说明 Host 0.4.20 / CLI 0.10.20 与 App 2.3.17 的 ACP 扩展；完整能力与验证边界见 [ACP 支持说明](acp-support.md)。

## 状态与历史是两件事

Host 的 SQLite 保存会话摘要与已经导入的消息。摘要出现在列表里，不代表当前仍有 Agent 在执行，也不代表原始消息已经加载。

- Host 启动时，先把上次留下的 `running` / `waiting` 和审批标记置为待重新连接的 `offline`，清除过期的异步问题缓存；各驱动再根据当前证据恢复状态。历史、标题、归档和活动时间保留。
- 普通发现列表有分页与数量限制。没有出现在这一页里不能证明会话已删除，不据此删除或归档记录。
- 读取历史失败通过可关闭的临时提示返回给当前客户端，继续提供本地缓存；不记作执行失败、不追加错误历史，也不进入 Live Activity。再次打开会重试。Host 0.4.68 / CLI 0.10.73 起会修正旧版本由读取失败产生的错误状态，并在回放时跳过这些合成错误；真实执行失败保留。
- Claude 原始记录确认缺失时，会话从列表和项目统计中隐藏，并清除对应的 Live Activity 待发通知。缓存和归档选择保留，原记录恢复后重新发现即可恢复显示；这与用户主动删除的永久移除不同。权限或 IO 错误不能作为删除依据，新建未写入记录或仍被进程持有的会话继续保留。
- 基础恢复修复使用原有会话状态和事件协议。新增 ACP 内容、授权和编辑交互需要配套客户端；Mac 屏幕组件不在这次 ACP 改动范围内。

## 各驱动的依据

| 驱动 | 活动状态 | 历史与归档 |
|---|---|---|
| Codex | 已订阅会话以实时事件为准；外部会话读取 rollout 的当前回合。`task_complete` 和 `turn_aborted` 都结束运行状态。 | 原生归档同步到 LinkShell；归档历史通过 `thread/read` 读取，不解除归档，不启动 Agent。 |
| Claude | Host 驱动的回合使用本连接状态；桌面会话结合转录内容、持有会话的进程与终端注册判断。进程消失时清除未闭合的运行状态。 | 确认原始 transcript 缺失时隐藏会话并保留缓存；记录恢复后重新显示并导入。暂时无法读取时仅提示。归档仅作用于 LinkShell；重命名和主动删除使用 Claude 原生记录。 |
| 通用 ACP | ACP 1 的 `session/list` 没有标准运行状态字段，不能沿用 SQLite 的旧运行标记。以本 Host 当前回合、审批和提问为准；ACP 2 使用 `state_update`，prompt 的确认响应不结束回合。 | 初始化完成后才读取能力；ACP 1 支持 `loadSession` 时加载历史，仅支持 `resume` 时提示只能显示缓存及之后的新消息；ACP 2 从头回放并按消息 ID 合并。归档仅作用于 LinkShell。 |

Codex 归档发现读取当前 `CODEX_HOME/archived_sessions` 下的 rollout 文件名，只更新 Host 已知的会话，不把整个原生归档导入列表。这是 Codex 本地存储兼容逻辑，不是 ACP API。原文件内容仍通过 app-server 读取。

Codex 的 MCP 服务也会用没有字段的对象表单请求授权（例如 Computer Use 访问某个应用）。这类请求显示为允许一次、拒绝或拒绝并停止的确认卡片，不能因没有填写字段而忽略。停止会话时，Host 先取消该会话待处理的 MCP 确认，再发送 `turn/interrupt`，避免 Codex 在中断工具时继续等待确认。2026-10-16 在 Codex 0.162.1 上发现：已进入这一卡死状态后，补发取消仍可能无法完成中断；恢复时应核实执行进程所持有的会话范围，不能自动重启共享进程来停止单条会话。

首页上尚未打开的 Codex 会话如果有待回答的异步问题，Host 每秒检查该 rollout 是否变化，并在电脑端回答落盘后推送问题状态；不必等默认 30 秒的整批会话发现。问题清空后停止这一路检查。已打开或订阅的会话继续使用原有实时事件和历史读取，读取失败或超出范围不视为已经回答。

Claude 对没有进程持有记录的旧版本保留有时间窗口的兼容判断。静止的 JSONL 文件不能证明 Agent 永远在线；独立运行的第三方 ACP CLI 也不因此变成可被本 Host 实时控制的会话。

## ACP 版本

LinkShell 的 v2 架构、Codex app-server 的 v2 API、网关的 `/v2/connect` 与 **ACP 2** 没有版本绑定关系。

当前稳定接入使用 `initialize.protocolVersion = 1`，并校验 Agent 返回的版本。缺失或不支持的版本会关闭连接、明确报告不兼容；不会把另一版本的消息按 ACP 1 解析，也不会因确定的版本不兼容反复自动重启进程。

[ACP 1 会话协议](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)明确区分：

- `session/load`：协商了 `loadSession` 后调用，在响应前通过 `session/update` 回放历史。
- `session/resume`：协商了 `sessionCapabilities.resume` 后调用，恢复上下文但不回放历史。LinkShell 提供说明，不把空历史冒充为成功加载的完整对话。

[ACP 2 迁移指南](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx)目前仍将整体协议标为 draft。此版本提供默认关闭的 ACP 2 开关，允许协商回 ACP 1；后续按实际版本处理消息。ACP 2 的 `session/prompt` 响应只确认消息已插入，结束状态由 `state_update` 推送；历史恢复使用 `session/resume` 加 `replayFrom: { type: "start" }`。完整消息替换、字段显式清空、终端输出、权限结构和配置同步分别适配，重放中尚未完成的工具和计划也保留。

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
- 2026-10-10 的基础恢复版本真实 Codex 检查 8/8 通过（问答流、审批、多客户端与终端入口）；Claude Code 2.1.168 接力检查 13/13 通过（历史导入、手机继续、交还终端、上下文连续与消息去重）。这不是新增 ACP 扩展的真机证明。配套版本证据见 [ACP 支持说明](acp-support.md)。
- 配套更新应按 [完整发版 SOP](../release-sop.md) 处理 wire、Host、CLI、App 和网关内置网页。配套版本见 [ACP 支持说明](acp-support.md#配套版本)。


## Agent 用量统计

`usage.summary` 的 Agent 列表来自 Host 注册表，包含 Codex、Claude、Gemini、Antigravity、Copilot、Grok、OpenCode、Cursor 和自定义 ACP Agent。桌面端与手机端共用此列表、时间筛选和按 Agent / 模型的汇总。

- Codex / Claude 读取原生日志（含归档、子代理）；继续按累计计数差值或消息 ID 去重。
- 其他 Agent 统计 Host 持久化的、带 accounting 标记的用量事件。ACP 1 从 prompt 结果收集，ACP 2 从完成工作的 idle 状态收集；不把上下文占用 `usedTokens` 当成消耗。
- Copilot 的会话累计计数按差值统计。首条以及计数重置后的首条仅建立基线，避免把接入前的历史消耗记到今天。其他 ACP Agent 按完成工作的回合用量解释；准确性依赖 Agent 遵循该语义。
- Antigravity 按原生 transcript step ID 去重，并使用 step 的 `created_at`；缺少可靠时间戳的旧记录不计入日期统计。
- 通用 ACP 数据只覆盖 LinkShell 已收到的上报，不会回填所有 Agent 的独立本机历史。旧版 Host 保存但未标明统计口径的事件、没有上报 Token 的会话均不相加。
- 没有数据的 Agent 仍显示在筛选中，指标显示 `—`，并明确提示“暂无可用数据”；这不代表零消耗。全部页的合计只代表已记录的用量。Token 与记录条数均显示单位，记录数不是网络请求数，缓存读取占比不是缓存命中率。

本轮验证包括模拟 ACP 的 RPC 集成测试、统计去重和累计基线测试，以及原生 macOS 预览截图；截图内数据明确标为示例。尚未逐个真实 Agent 验证其上报行为，也没有手机真机视觉验收。
