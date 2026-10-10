# Agent 提问与手机回答

核对日期：2026-10-10。本文记录源码支持范围；不代表所有已安装客户端、host 或上游 Agent 版本均已更新。

## 共用交互

结构化问题统一显示为「需要用户输入」，在会话中用 `QuestionCard` 作答。审批、问题和普通聊天消息分别走各自的协议回应；问题的回答不会排进普通消息队列。

阻塞式提问使用 `ls_permission.questions` → `sessions.answer` → 原请求的 JSON-RPC response。响应格式由 host 的 Agent 适配器转换，手机不依赖 Agent 私有字段。取消、跳过和接受保留各协议的区别。Agent 通过 `$/cancel_request` 撤回待答问题时，host 返回该协议的取消响应，并清除手机卡片。

Codex Desktop 异步问题走其专用回复消息与 Desktop IPC；待回答状态与运行状态分开，回答失败不算已回答。

## 支持范围

| 接入 | 结构化问题通道 | 当前处理 |
| --- | --- | --- |
| Codex app-server | `item/tool/requestUserInput`、MCP 表单 | 单选、文字、跳过及原请求响应 |
| Codex Desktop | `request_user_input_async` | 列表提示、固定回答卡片、自由文本、跳过、立即回传 |
| Claude，经 LinkShell ACP 接管 | `elicitation/create` | `AskUserQuestion` 的单选、多选、自定义答案和表单 |
| Cursor ACP | `cursor/ask_question` / `_cursor/ask_question` | 单选、多选、跳过、取消；返回选项 ID，不把显示标签当 ID；官方接口未提供自由文本字段，因此不伪造自由文本答案 |
| Grok ACP | `_x.ai/ask_user_question`，兼容无下划线名称 | 单选、多选、自由文本、可见预览、跳过与取消；按问题文本返回原生答案数组及 `annotations` |
| Grok MCP 表单 | `_x.ai/mcp/elicit`，兼容无下划线名称 | 复用表单，按 Grok 返回 `outcome`；标准 ACP 返回 `action` |
| 其他 ACP Agent | `elicitation/create`，`mode: form` | 只要 Agent 发出标准表单，就复用相同的卡片、回答和取消流程 |

Grok 新建、载入、恢复和分叉会话携带 `_meta.askUserQuestion: true`，使已实现的提问能力可用。普通“跳过”返回 `cancelled`；不会被转换成 Grok 计划模式的 `skip_interview`，后者代表另一种用户选择。

Cursor 文档中的请求没有 `sessionId`。host 优先使用显式 `sessionId`，否则按当前工具调用定位会话；只有一个活跃会话时可使用该会话。多个会话同时运行且无法确定归属时返回错误，不猜测“最后打开的会话”。

URL elicitation 未声明支持。它涉及外部页面的专门交互，不能用普通问题卡片代替。当前表单支持平面字符串、数字、整数、布尔值、单选和多选字段。计划审批扩展（例如 `cursor/create_plan`）不属于本次问题适配。

## 上游边界

- **Gemini**：已核对本机 0.62.0 及官方源码；ACP 模式将 `ASK_USER_TOOL_NAME` 加入排除列表。终端支持 `ask_user` 不等于 ACP 会发送可回答的问题。不能靠在 LinkShell 显示一个按钮恢复上游没有提供的回调。
- **OpenCode**：查阅的 `dev` 源码中，原生 question 工具的默认客户端名单不包含 ACP，ACP 事件处理也未接出 question 请求。官方的通用 ACP 支持说明不足以证明这一能力可用，未把它标为已支持。
- **Copilot**：官方 SDK 有 `user_input.requested` 和 elicitation，但当前 LinkShell 接入的是 ACP，不是 Copilot SDK。已核对本机 CLI 1.0.95；尚未验证它在 ACP 上发出原生提问，因此不声明完整支持。若它发标准 `elicitation/create` 表单，通用适配会处理。
- 电脑上独立运行的原生终端会话，不等同于 host 持有的 ACP 会话；不能把可读历史当作可回答的实时请求。

## 证据

- [ACP v1 Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)：能力声明、会话作用域、form / URL 及 accept / decline / cancel。
- [ACP 请求取消](https://agentclientprotocol.com/protocol/v1/cancellation)：`$/cancel_request`。
- [Cursor ACP 扩展](https://cursor.com/docs/cli/acp)：`cursor/ask_question` 的请求与返回结构。
- [Grok 问题协议类型](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build/ask_user_question/types.rs)：数组答案、注释及取消结果。
- [Grok 会话能力](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/upload/turn.rs)：`askUserQuestion` 开关。
- [Grok MCP 表单协议](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/mcp_elicitation/types.rs)。
- [Gemini 配置源码](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)。
- [OpenCode 工具注册](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts)及 [ACP 事件处理](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/event.ts)。
- [Copilot ACP 文档](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)及 [SDK 事件](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)。

## 验证层级

`acp-questions.test.ts` 核验响应格式；`acp-driver.e2e.test.ts` 通过真实 host RPC、子进程 ACP 和模拟手机客户端验证多会话路由、答案过滤、跳过、取消、Agent 主动撤回，以及 Grok 的能力声明。原有 Claude / 标准 ACP 表单回归也必须通过。

这些是协议和端到端测试夹具，不冒充真实模型调用或真机验收。本次环境未安装 Cursor；Grok 已安装，但尚未完成真实账号的提问往返验证。
