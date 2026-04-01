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
| `pairing.created` | 配对已创建 |
| `pairing.claim` | 配对认领 |
| `pairing.claimed` | 配对成功 |
| `control.claim` | 请求控制权 |
| `control.grant` | 授予控制权 |
| `control.reject` | 拒绝控制权 |
| `control.release` | 释放控制权 |

所有 payload 使用 Zod schema 做运行时校验。

## 代码入口

协议定义当前集中在：

1. src/index.ts

如果 CLI、Gateway、Mobile 出现消息结构不一致，先从这里排查。

## License

MIT
