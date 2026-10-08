# 手机端命令与持续目标

## 入口与命令来源

输入框输入 `/`（包括前导空白、中文输入法的 `／`）显示候选；输入参数后收起。候选在其他输入框卡片之前展示，空结果有明确提示。输入框旁的命令按钮和会话「更多 → 命令」均可打开可搜索面板。

命令面板合并当前 Agent 报告的命令与 LinkShell 已实现的本地操作。模型、推理强度、权限、计划模式等使用实际 `SessionConfigOption`；没有该设置就不伪造。选择 Goal 或设置直接打开对应页面；选择远端命令写入按电脑和会话隔离的草稿，确认发送后执行。

Claude ACP 已根据 CLI 的 `terminal_slash_commands` 和适配器支持范围过滤命令，客户端不再用过时的静态名单隐藏 `mcp`、`config`、`output-style`、`reload-skills` 等。当前 CLI 未报告的命令不等于最新版官方文档没有该功能。

Codex 的 TUI 命令不会被 app-server 自动执行。LinkShell 显式映射：

| 命令 | 执行方式 |
| --- | --- |
| `/compact`、`/review` | Codex app-server 原生操作 |
| `/init` | 项目说明提示词 |
| `/goal`、`/goal edit <目标>`、`/goal pause`、`/goal resume`、`/goal clear` | 原生 Goal API；无参数或单独 `edit` 在手机打开目标页 |
| `/status`、`/mcp`、`/apps`、`/ps` | 查询会话、MCP、连接器、后台终端；列表读取完整分页 |
| `/stop` | 停止该会话的所有后台终端，不是停止当前回复 |
| `/reload-skills` | 强制重新扫描 Skills |
| `/<skill>` | Codex 原生 skill input |
| `/model`、`/effort`、`/permissions`、`/approvals`、`/plan` | 当前会话设置；支持实际选项值，`/plan <描述>` 切换后发送任务 |
| `/help`、`/skills`、`/settings`、`/config` | 打开命令／设置面板 |
| `/diff`、`/new`、`/clear`、`/fork`、`/rename`、`/context` | LinkShell 页面或已有会话操作 |

不把未知 Codex 斜杠命令降级成普通提示词。终端显示、登录、全局实验开关等 TUI 专属操作没有伪造等价实现。`/etc/hosts ...` 这样的文件路径仍作为普通消息。

Codex 内置命令先发布，Skills 扫描完成后补充；`skills/changed` 刷新缓存，显式刷新强制重新扫描。过期扫描结果不会覆盖新列表。

## Goal

`ls_goal` 传输 Agent 的原生状态，作为 standing state 持久化并在历史分页／重连时恢复；不从普通回复、计划卡或单轮结束推断目标完成。

- **Codex**：`sessions.goal` → `thread/goal/get|set|clear`；订阅 `thread/goal/updated|cleared`。只有成功读取 Goal API 后才在命令列表报告 Goal。支持目标文本、状态、Token 预算与用量、耗时。更新通知优先于在途旧快照。暂停／恢复通过原生 `status`，不由 LinkShell 自建续跑循环。
- **Claude Code**：保留原生 `/goal [condition|clear]` 命令执行，支持设置、查询、清除。ACP 0.84 的 Goal 元数据位于 `_meta.jetbrains.air.goal`；LinkShell 声明该扩展的解析能力，但保留自己的 `clientInfo`。电脑端从 Claude 原生 transcript 的 `goal_status` attachment 恢复状态，区分成功完成与提前清除，忽略子 Agent 的目标。Claude 没有在此接入中提供暂停、恢复、Token 预算，所以 UI 不显示这些操作。
- 手机只能观察被桌面独占的 Codex 会话时，仍提供命令列表与 Goal 读取；目标页面显示只读，修改请求明确拒绝。Goal 状态独立于 rollout 文件轮询，避免暂停／恢复不写 transcript 时漏更新。
- Goal 控制命令不进入 LinkShell 的普通消息等待队列；Agent 自己的忙碌与接管规则仍然生效。
- 独立目标页与会话顶部目标卡使用同一份原生状态；Goal Token 用量与上下文占用分开显示。

## 参考依据

- [OpenAI：Codex 命令](https://developers.openai.com/codex/cli/slash-commands)
- [OpenAI：App Server Goal API](https://developers.openai.com/codex/app-server)
- [Claude Code：命令参考](https://code.claude.com/docs/en/commands)
- [Happy：手机输入候选列表](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/components/AgentInputAutocomplete.tsx)
- [Happy：Claude Goal transcript 适配](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/claudeGoalStatus.ts)
- 当前安装的 `codex-cli 0.159.3` 生成的 app-server TypeScript 协议，以及 `@agentclientprotocol/claude-agent-acp@0.84.0`、`@anthropic-ai/claude-agent-sdk@0.3.284` 的类型与适配器源码。
