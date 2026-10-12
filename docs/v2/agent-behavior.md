# Agent 适配行为契约

`packages/host/src/drivers/behavior.ts` 的 `DriverBehavior` 是 Host 内部的行为约定。每个 `AgentDriver` 必须显式提供它；手机与网页仍接收现有的 `tier`、`capabilities`，没有新增协议字段。`steer`、`fork` 从契约生成，避免界面能力和运行逻辑各维护一份。

## 行为与执行边界

| 字段 | 要回答的问题 | 当前实现 |
|---|---|---|
| `desktop` | 电脑和手机如何协作 | Codex `multi_client`；Claude `handoff`；普通 ACP `remote`。原生驱动继续负责进程所有权。 |
| `history` | 打开旧会话能得到什么 | 原生快照、`load` 回放、`resume` 回放、只恢复上下文、不可恢复。Host 缓存始终独立保留。 |
| `turnCompletion` | 由什么证据结束 Host 发起的回合 | Codex 原生事件；ACP 1 prompt 结果；ACP 2 `state_update`。确认收到消息不能冒充执行结束。 |
| `busyInput` | 忙时输入如何提交 | 原生 steer、额外的并发 prompt、等待当前回合结束。实际交付仍由当前回合和原生所有权决定，不承诺 exactly-once。 |
| `fork` | 原生分叉支持什么范围 | 原生任意回合、仅整个会话、Host 复制对话上下文、尚未协商。尚未协商时先初始化，不能直接降级为复制文本；仅支持整个会话的适配器不会收到部分分叉请求。 |
| `detach` | 释放本方附件时做什么 | 原生 unsubscribe、协议 close 请求、本地清理。都不代表删除会话或取消其他客户端的工作。 |

`acp/behavior.ts` 只读取完成后的握手结果，不能从客户端请求的协议版本推断能力。连接结束后旧握手不再授权新操作；重新初始化会重算。ACP 2 的 `resume` 显式请求从头回放；ACP 1 只有 `resume` 时继续显示缓存，并提示以往消息未由 Agent 提供。

Claude 的历史与按回合分叉由 transcript / SDK 提供，不能受 ACP 的 `loadSession` / `fork` 声明开关控制。Claude 内部接管仍通过 ACP 恢复，因此驱动内部保留协议契约与对外原生契约两层。Codex 保持直接使用 app-server，多端订阅、桌面 IPC 和外部会话观察不经过通用 ACP。

契约描述已实现的行为，不增加底层 Agent 的能力。图片、音频、配置选项、提问、MCP、认证等继续使用各自已有的握手与映射；这一轮没有建立第二套配置或供应商系统。

## 手机端

排队消息按现有 `steer` 能力显示「插话」或「中断发送」，空闲时显示「发送」。菜单与无障碍说明解释动作后果；未知 Agent 不猜测能否插话。Claude 由桌面持有时仍保留接管入口。队列显示待发送数量及等待状态，并继续支持编辑、排序和撤回。

## 验证与持续集成

- `driver-behavior.e2e.test.ts` 用同一组 Host RPC 操作检查 Codex、Claude、ACP 回放与仅恢复模式的审批、回合结束、释放后恢复以及缓存保留；Claude 在 ACP 未声明 fork 时仍通过真实 SDK 分叉本地夹具历史。
- `session-recovery.e2e.test.ts` 覆盖重启、懒启动与仅恢复不回放；`acp-extensions.e2e.test.ts` 覆盖 ACP 2 确认和完成的不同顺序；`worktrees.test.ts` 覆盖完整与部分分叉选择。
- `host-codex.e2e.test.ts`、`host-codex-elsewhere.e2e.test.ts`、`claude-handoff.e2e.test.ts` 保留原生多端与桌面接力的行为回归。
- 新驱动必须逐项声明契约，再加入公共行为测试与其原生所有权测试。模拟 Agent 的协议回归不等于真实厂商兼容认证；`live:codex` / `live:claude` 保留真实账号与模型服务验收；固定版本 CI 使用真实 CLI、SDK、ACP 和本地模型 HTTP 夹具，详见 [真实适配器回归](../../packages/host/test/real-agents/README.md)。
- 手机端 `queued-send-action.test.ts` 检查动作说明与桌面持有关系。布局预览和静态检查不等于 iOS / Android 真机验收。

### 本轮验证（2026-10-12）

- 在 HEAD 加本轮改动的独立目录执行 `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test`：724 项 JavaScript/TypeScript 测试、85 项 Swift 测试通过。未混入工作区里并行进行的屏幕编码改动。
- 真实 Codex 检查 8/8、Claude Code 2.1.168 接力检查 13/13 通过，包含多客户端、审批、上下文连续、交还桌面与消息去重。测试创建的原生会话及临时工作目录已清理。
- 实际 `QueuePanel` 组件通过 React Native Web 在 320 / 390 点宽度预览，核对浅色/深色、长消息、发送中的禁用状态、取回编辑与离线状态。玻璃材质、图标、系统菜单和 Host 操作使用预览替身；未作为 iOS / Android 真机证明。

### 固定版本原生回归

- `.github/workflows/real-agents.yml` 在每个 PR、main push、每周定时和手动触发时分别运行 Linux / macOS 检查。CLI 使用单独 npm lockfile，适配器与 SDK 使用宿主的冻结依赖；运行前核对版本，缺少任一命名用例、跳过、提前异常或超时都失败。
- Codex 检查真实 app-server 多端共享、跨端审批、断线后的新回合和重启恢复；Claude 检查原生桌面 CLI → ACP → 原生桌面 CLI 上下文、运行中单写者交接、真实 Bash 审批允许与拒绝，以及立即接回时延迟日志去重。
- 这些检查不使用账号凭据；模型回答来自本地 HTTP 夹具，不能代替真实模型服务、桌面 GUI/TUI 或手机真机验收。Dependabot 升级 PR 会运行同一套检查，不自动合并或发版；合并阻断还需仓库分支规则要求对应检查。
