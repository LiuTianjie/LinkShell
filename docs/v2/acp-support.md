# ACP 支持与验证边界

本说明对应 2026-10-11 的 ACP 实现改动。功能代码完成不等于已经发布或已更新电脑和手机；版本、安装及部署由更新任务处理。

## 协议基线

- [官方协议仓库](https://github.com/agentclientprotocol/agent-client-protocol/tree/2063558cffdbe868478ac6185936d23a53d787fd)：本次核对固定到提交 `2063558cffdbe868478ac6185936d23a53d787fd`，ACP 1 schema 1.25.0，同时核对该提交的 v1/v2 unstable schema。
- 默认使用 ACP 1。用户在 Agent「连接与工具」中开启 ACP 2 后才请求版本 2，接受 Agent 协商回 1。版本 2 及实验扩展均不作为稳定协议保证。
- stdio 的流编解码和实验 HTTP/WebSocket 传输使用官方 `@agentclientprotocol/sdk@1.8.0`；UTF-8 字符跨缓冲区、JSON-RPC 批量请求与双向调用都有测试。
- 网关继续转发端到端加密消息；本次没有改变 `/v2/connect`、鉴权挑战串、配对数据库和屏幕媒体通道。

## 已接通的能力

| 范围 | Host 行为 | App / Web 入口与呈现 |
|---|---|---|
| 会话生命周期 | 创建、加载、恢复、列表、关闭、删除、分叉依 Agent 能力调用。ACP 2 等待 `state_update` 结束回合；确认先后顺序、排队和历史重放分别处理。 | 原有会话列表、消息流、归档与会话操作。 |
| 配置 | select / boolean、分组、说明、model_config、旧 modes/models；完整响应替换配置，空列表清空，配置通知在重放时保留。 | 会话设置显示选择器和开关；菜单保留分组与说明。 |
| 消息与工具 | 文本、图像、音频、内嵌文本/二进制资源、资源链接；工具 name/kind/rawInput/rawOutput/locations、diff、patch、终端引用；ACP 2 upsert 和 null 清空。 | 音频播放、资源卡片、工具详情、变更预览；大图像/音频/二进制内容按需读取。 |
| 压缩、计划、用量 | 压缩进度与概要、普通计划及命名 Markdown/文件计划、计划移除、context/cost/token 用量、独立的 `max_turn_requests` 结束原因。 | 时间线卡片、计划和用量详情。 |
| 临时通知 | `notice` 实时转发，不写入会话历史；重放不重新弹出。 | 可关闭的临时通知；断线清理。 |
| 审批与提问 | 完整工具上下文、取消撤回、表单默认值与整数/范围/长度/格式约束；请求级、会话级、URL elicitation；取消父请求时撤销关联交互。 | 审批内容预览、表单校验；授权 URL 只在用户点击后打开。 |
| 登录 | `authenticate`、ACP 2 `auth/login`、能力允许的 logout；终端登录独立 PTY 启动并按退出码刷新状态。 | 电脑 → Agent 设置；登录期间可以回答没有会话 ID 的提问。交互式登录不会被 1 秒超时截断。 |
| 文件与终端客户端服务 | ACP 1 的文件读写、按行读取、终端创建/输出/等待/停止/释放；附加目录范围检查、符号链接校验、取消请求、UTF-8 输出限额和进程组清理。 | 文件变更和终端工具输出沿时间线呈现。 |
| MCP 与工作范围 | stdio / HTTP / SSE 配置按版本和 Agent 能力传递；附加目录随 new/load/resume/fork 传递；MCP-over-ACP 转发活动请求及进度、保留内层错误和逻辑请求 ID。 | Agent 全局设置或会话工具设置。MCP-over-ACP 是实验传输，面向当前请求级 MCP 语义。 |
| 子代理与会话间消息 | 标准实验 `subagent_update`、定向消息、嵌套状态；父回合结束后仍保留子代理审批；仅对允许取消的子代理提供单独停止。 | 子代理时间线、审批和停止按钮。Claude 原生 teammate roster 的退出状态另有本地证据适配。 |
| 自定义 Agent 与供应商 | 本地命令、HTTP、WebSocket；连接请求头由电脑环境变量引用；供应商 list/set/disable，禁止停用必需供应商。 | 电脑 → 自定义 ACP 连接、Agent → 模型供应商。 |
| 编辑建议（NES） | start/suggest/accept/reject/close，声明过的 document 事件，UTF-8/16/32 位置转换；文本编辑、跳转、搜索替换；先预览，文件发生外部修改时拒绝覆盖。 | 文件 → AI 编辑建议，选择支持 NES 的 Agent，预览后应用。 |

NES 没有语言服务，**不声明 semantic rename 支持**；收到这种建议会明确拒绝。上下文来自该编辑页面实际打开的文件，不能冒充桌面 IDE 的全工作区诊断或语义索引。协议中没有实现的私有扩展仍返回 method-not-found。不同 Agent 必须声明相应能力，界面开关不能替它增加能力。

## 配置与边界

全局配置位于 `LINKSHELL_HOME/acp.json`，以 0600 原子写入；会话覆盖值存入该会话的 Host 状态，不进入消息记录。附加目录使用绝对路径，修改运行中或待审批的 Agent 配置会被拒绝。移除自定义连接保留历史。

自定义远程连接示例：

```json
{
  "id": "remote-agent",
  "label": "远程 Agent",
  "transport": "http",
  "url": "https://agent.example.com/acp",
  "headerEnv": { "Authorization": "ACP_AUTHORIZATION" }
}
```

`headerEnv` 的值是电脑环境变量名；Host 不把解析后的连接凭证回传界面。MCP 的 env/headers 是用户明确填写的配置值，保存在本机配置内。供应商请求头只转交 Agent，不出现在列表返回值或会话记录中。

客户端文件服务只限制它代办的文件请求；本机 Agent 本身仍以电脑用户身份运行，这不是操作系统沙箱。文本文件上限 16 MB，NES 文件上限 256 KB，终端输出默认 256 KB、最大 4 MB，MCP/ACP 单消息限额 32 MB。

## 验证

- 全仓 `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test` 均通过；663 项 JavaScript/TypeScript 测试、47 项 Swift 测试。在独立检出执行，包含 CLI 编译的 Host/Gateway 源码和 macOS Swift 构建/测试。
- `acp-extensions.e2e.test.ts` 使用真正的 stdio 子进程、Host RPC 与客户端时间线，覆盖生命周期、配置、文件/终端、授权、通知、用量和子代理。
- `acp-remote.test.ts` 使用官方 SDK 的本地 HTTP/WebSocket 服务端，分别协商 ACP 1/2 并验证双向请求；不是外部厂商服务的兼容认证。
- `acp-client-services.test.ts`、`acp-mcp.test.ts`、`acp-editor.test.ts`、`acp-updates.test.ts` 覆盖目录边界、子进程清理、取消、MCP 错误/进度、位置编码、文件冲突、null 清空与资源保留；client-core 回归覆盖长时间登录请求、消息替换和历史分页。
- 浏览器通过隔离的本机网关实际配对：整数默认值显示、小数被禁用提交、有效回答完成、布尔配置及空配置同步、压缩卡片、费用/用量、无会话登录表单均完成操作验证。没有控制或重启已安装的 Host。
- 更新后的传输层已对本机 Claude ACP 适配器 0.84.0、Copilot 1.0.95、Gemini 0.62.0、Grok 完成真实初始化握手，均协商 ACP 1。此项没有发送模型任务，只证明当前安装版本的初始化兼容；Grok 未返回 Agent 版本。
- iOS/Android 的音频播放、系统授权页、键盘/光标和真机布局尚未完成设备验证。`expo-audio` 是新增原生依赖，必须由新 App 二进制承载，不能用旧二进制的 OTA 声称已支持。

## 更新任务的接入范围

本次改动涉及 wire、Host、client-core、App 和网页。网关业务路由无需修改，但其发布包内嵌网页需重新构建。发布时应整批消费对应源码和锁文件，统一安排包版本、App 原生构建以及本地/网关更新。这个实现任务不 bump 发布版本、不发布 npm、不安装 App/CLI、不部署网关。
