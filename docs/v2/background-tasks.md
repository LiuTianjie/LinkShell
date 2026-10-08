# 后台任务

LinkShell 跟踪对话一轮结束后仍运行的命令。它们与子 Agent、工作流、持续目标分别记账：一轮结束不代表后台命令结束，停止一个后台任务也不会停止这一轮。

## 支持范围

| Agent | 查看状态及输出 | 手机停止单个任务 |
| --- | --- | --- |
| Codex | app-server 后台终端；轮次结束后继续接收输出和结束事件 | 支持，以 processId 调用 terminate |
| Claude Code | Bash、Monitor；同时支持电脑旁观和远程接管 | 暂不支持；适配器尚未提供兼容普通 ACP 客户端的接口 |
| 其他 ACP Agent | 未提供可用的统一任务接口 | 不支持 |

手机通过 `/tasks`、右上角任务按钮、输入框上方的运行提示进入。任务列表先显示运行中项目，其他项目默认折叠。详情包含命令、状态、耗时、退出码和按字节向前翻页的输出；查看运行中任务时每两秒刷新。翻到早期输出后暂停自动替换，点击“查看最新”恢复。

## 协议与持久化

- `ls_task` 是完整的 `BackgroundTask` 快照，主键是原生任务 ID，不按命令文本匹配。
- 状态为 `running / completed / failed / stopped / unknown`。缺少可靠的结束结果只能记 `unknown`。
- Host 持久化事件，`sessions.tasks` 返回每个 ID 的最后一条及 `lastSeq`。
- Client Core 独立维护任务集合，连接恢复时重新读取列表，按 `lastSeq` 拒绝过期快照，不依赖当前聊天分页。
- `sessions.taskOutput {sessionId, taskId, before?, limit?}` 返回 `{text, start, size}`；`limit` 最大 256 KiB，字节游标对齐 UTF-8。
- `sessions.stopTask` 只允许 `running && canStop` 的任务。接口失败不会扩大为取消对话或清理全部终端。

## Claude 数据来源

`ClaudeActivity` 的独立 JSONL 游标在远程模式下也继续运行，向 `ClaudeTasks` 提供原始记录：

- 关联 Bash / Monitor 的 `tool_use` 和 `toolUseResult.backgroundTaskId / taskId`。
- 读取 `task-notification`（queue-operation、queued_command attachment 或 user text），三种重复形式合并为同一状态。
- 提前到达的完成通知暂存，启动结果到达后一次合并。
- Monitor 无 status 的事件只更新摘要；Agent / Workflow 不会成为 shell 任务。
- TaskStop 记 stopped，孤儿汇总记 unknown。没有会话持有进程、也没有本 Host 加载的远程会话时，尚在运行的记录改为 unknown。
- 输出只读取任务记录所指的 `claude-<uid>/<project>/<session>/tasks/<task>.output`，校验原路径和 realpath，拒绝越界的符号链接；临时文件消失时回退到工具事件。

不要声明 `jetbrains.air`，包括 capabilities 为空的声明。适配器 0.84.0 会因此改变 `parentToolUseId`、`toolName` 和子 Agent 流。Goal 通过会话 `_meta.claudeCode.emitRawSDKMessages: [{type: "active_goal"}]` 订阅，正常子 Agent 数据格式保持不变。已额外检查 Registry 0.87.0，单任务停止仍依赖 AIR。Claude 的单任务停止需要上游提供非 AIR 能力入口，不能使用本地 pnpm patch 冒充可分发的支持。

## Codex 数据来源

加入线程及顶层 turn 结束后调用 `thread/backgroundTerminals/list`；有人查看且还有运行任务时约五秒对账。完整分页读取列表，记录 `itemId → processId`。完成通知更新退出码和状态；列表消失且没有完成通知、或 app-server 断开时记 unknown。

停止使用 `thread/backgroundTerminals/terminate`，严格指定线程及 processId。`terminated: false` 显示失败。自己的 app-server 与共享 app-server 使用对应 RPC 连接。

`outputDelta` 在轮次结束后仍保留；最终 `aggregatedOutput` 校正流式输出，以补齐 Codex 未单独推送的初始片段。Agent 用 `nohup … &` 自行脱离执行器的进程不属于此接口，无法列出。

## 验证

自动测试覆盖：同名任务、乱序和重复结束通知、Monitor、排除子 Agent、TaskStop、孤儿状态、进程退出、输出路径及 UTF-8 游标、Host 重启、结束后的输出、单任务停止隔离、Client Core 过期快照，以及不启用 AIR 的 Goal 通知。

真实 Codex 0.159.3 已验证：主对话先结束，后台循环继续输出，最终退出码 3，输出首尾完整。iOS 模拟器已验证：任务入口、`/tasks`、任务列表、详情、停止确认、停止后另一任务保持运行、已结束分组折叠。

Claude 的真实模型运行仍受本机 OAuth 授权失效限制；远程任务、持久化和重启恢复使用真实 Host + 模拟 ACP + JSONL 验证，不作为真实 Claude 模型运行证明。Android 尚需设备交互验收。

## 上游依据

- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude 后台命令](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)
- [Codex slash commands](https://developers.openai.com/codex/cli/slash-commands)
- Codex 本机 `app-server generate-ts --experimental` 生成的 list / terminate 协议。
- `@agentclientprotocol/claude-agent-acp@0.84.0` 的 `async-tasks.js`、`goal-extension.js` 和 `acp-agent.js`。
