# @linkshell/cli

LinkShell CLI — 把本地 Claude Code / Codex 终端会话桥接到远程网关，让你在手机上远程控制。

## 安装

```bash
npm install -g @linkshell/cli
```

## 首次配置

```bash
linkshell setup    # 交互式配置：gateway 地址、默认 provider
linkshell doctor   # 检查环境是否就绪
```

配置保存在 `~/.linkshell/config.json`，后续启动时自动读取。

## 使用

```bash
# 桥接 Claude Code（如果已 setup，可省略 --gateway）
linkshell start --provider claude

# 指定 gateway
linkshell start --gateway wss://your-server.com:8787/ws --provider claude

# 指定二维码给手机读取的公网地址
linkshell start --gateway ws://127.0.0.1:8787/ws --pairing-gateway 203.0.113.10 --provider claude

# 桥接 OpenAI Codex
linkshell start --gateway wss://your-server.com:8787/ws --provider codex

# 桥接任意命令
linkshell start --gateway wss://your-server.com:8787/ws --provider custom --command bash
```

启动后 CLI 会自动创建配对，打印配对码和 QR 码：

```
  Pairing code: 847293
  Session: a1b2c3d4-...
  Expires: 2026-04-01T10:30:00Z

  Scan to connect:
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  ...
```

在手机 App 中输入配对码或扫描 QR 码即可连接。

如果 CLI 实际连接的是本机或内网地址，但你希望二维码里的地址改成手机可访问的公网 IP 或域名，可以加 `--pairing-gateway`。

- 传完整地址：`--pairing-gateway https://your-server.com:8787`
- 只传 IP 或域名：`--pairing-gateway 203.0.113.10`

当只传 IP 或域名时，CLI 会沿用 `--gateway` 对应的协议和端口，只替换主机名。

## 命令

| 命令 | 说明 |
|------|------|
| `linkshell start` | 启动桥接会话 |
| `linkshell setup` | 交互式配置向导 |
| `linkshell doctor` | 环境检查和连通性诊断 |

## start 选项

```
linkshell start [options]

  --gateway <url>       网关 WebSocket 地址（可通过 setup 配置默认值）
  --pairing-gateway     二维码/深链中给手机使用的 HTTP 地址或主机名
  --provider <name>     claude | codex | custom（默认 claude）
  --command <cmd>       自定义命令（custom provider 必填）
  --session-id <id>     手动指定 session ID（默认自动创建）
  --client-name <name>  显示名称（默认 local-cli）
  --cols <n>            终端列数（默认 120）
  --rows <n>            终端行数（默认 36）
```

## doctor 检查项

- Node.js 版本 >= 18
- node-pty 原生模块是否可用
- Claude CLI 是否安装及版本
- Codex CLI 是否安装
- 配置文件状态
- Gateway 连通性和延迟

## 工作原理

```
你的电脑 (CLI + PTY)  ──WebSocket──►  服务器 (Gateway)  ◄──WebSocket──  手机 (App)
```

1. CLI 通过 PTY 启动目标进程（Claude/Codex/bash），捕获完整终端输出
2. 通过 WebSocket 连接到远程 Gateway
3. Gateway 把终端输出转发给手机 App
4. App 的输入通过 Gateway 回传给 CLI，写入 PTY

支持断线自动重连（指数退避）、ACK 确认、scrollback 缓冲（1000 条）、心跳检测（15s）和协议版本协商。

## 代码入口

如果要继续改 CLI，优先从这几个文件进入：

1. src/index.ts
2. src/providers.ts
3. src/runtime/bridge-session.ts
4. src/runtime/scrollback.ts

## License

MIT
