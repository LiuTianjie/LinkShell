# @linkshell/protocol

LinkShell 三端共享协议层 — CLI、Gateway、App 共用的消息类型定义和序列化工具。

## 安装

```bash
npm install @linkshell/protocol
```

## 使用

```typescript
import {
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  parseTypedPayload,
  PROTOCOL_VERSION,
} from "@linkshell/protocol";

// 创建消息
const msg = createEnvelope({
  type: "terminal.output",
  sessionId: "abc-123",
  seq: 0,
  payload: {
    stream: "stdout",
    data: "hello world",
    encoding: "utf8",
    isReplay: false,
    isFinal: false,
  },
});

// 序列化 / 反序列化
const json = serializeEnvelope(msg);
const parsed = parseEnvelope(json);

// 类型安全的 payload 解析
const output = parseTypedPayload("terminal.output", parsed.payload);
// output.data === "hello world"
```

## 消息类型

| 类型 | 说明 |
|------|------|
| `session.connect` | 连接握手（含 protocolVersion、hostname） |
| `session.ack` | ACK 确认 |
| `session.resume` | 重连恢复请求 |
| `session.heartbeat` | 心跳 |
| `session.error` | 错误通知 |
| `terminal.output` | 终端输出 |
| `terminal.input` | 用户输入 |
| `terminal.resize` | 窗口尺寸变化 |
| `terminal.exit` | 进程退出 |
| `terminal.spawn` / `terminal.spawned` / `terminal.kill` / `terminal.list` | 多终端管理 |
| `terminal.browse` / `terminal.browse.result` / `terminal.mkdir` | 远端目录浏览和创建 |
| `terminal.status` | Claude/Codex hook 状态与权限摘要 |
| `terminal.history.request` / `terminal.history.response` | shell 历史读取 |
| `pairing.created` | 配对已创建 |
| `pairing.claim` | 配对认领 |
| `pairing.claimed` | 配对成功 |
| `control.claim` | 请求控制权 |
| `control.grant` | 授予控制权 |
| `control.reject` | 拒绝控制权 |
| `control.release` | 释放控制权 |
| `screen.start` / `screen.stop` / `screen.frame` / `screen.status` | 截图流远程桌面 |
| `screen.offer` / `screen.answer` / `screen.ice` | WebRTC 远程桌面协商 |
| `file.upload` | 文件上传 |
| `tunnel.request` / `tunnel.response` | HTTP 端口转发 |
| `tunnel.ws.data` / `tunnel.ws.close` | WebSocket 端口转发 |
| `agent.capabilities` / `agent.snapshot` / `agent.update` | Agent Workspace v1 兼容消息 |
| `agent.v2.capabilities` / `agent.v2.conversation.*` / `agent.v2.prompt` / `agent.v2.event` | Agent Workspace v2 |
| `agent.v2.permission.*` / `agent.v2.structured_input.respond` | Agent 权限与结构化输入 |

协议包为所有 payload 提供 Zod schema。Gateway 会对非 Agent Workspace v2 的已知协议消息做 schema 校验；Agent Workspace v2 envelope 由 Gateway 复用共享路由策略区分 host 推送、client 读请求和需要控制权的 client 写请求，但 payload 保持透明转发，由 CLI/App 端按业务版本解析。

Agent Workspace v2 的 timeline 支持 `chat`、`thinking`、`tool_activity`、`command_execution`、`file_change`、`subagent_action`、`plan`、`user_input_prompt`、`review` 和 `context_compaction`。Provider capability 会携带可用模型、默认模型、reasoning effort、permission mode 和 provider feature flags，供移动端动态渲染控制项。

## 代码入口

协议定义当前集中在：

1. src/index.ts

如果 CLI、Gateway、Mobile 出现消息结构不一致，先从这里排查。

## License

MIT
