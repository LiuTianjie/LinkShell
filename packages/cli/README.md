# linkshell-cli

在手机上远程查看和控制本地 Claude Code / Codex 终端会话。

## 安装

```bash
npm install -g linkshell-cli
```

## 一条命令开始

```bash
linkshell start --provider claude
```

CLI 会自动：
1. 启动内置 Gateway（端口 8787）
2. 检测局域网 IP
3. 创建配对并打印 QR 码
4. 手机扫码即连

```
  Built-in gateway started on port 8787
  LAN address: http://192.168.1.12:8787

  Pairing code: 847293
  Session: a1b2c3d4-...

  Scan to connect:
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  ...
```

## 更多用法

```bash
# 桥接 Claude Code
linkshell start --provider claude

# 桥接 Codex
linkshell start --provider codex

# 桥接任意命令
linkshell start --provider custom --command bash

# 指定端口
linkshell start --provider claude --port 9000

# 连接远程 Gateway（不启动内置 Gateway）
linkshell start --gateway wss://your-server.com:8787/ws --provider claude

# 指定 QR 码中的公网地址
linkshell start --gateway ws://127.0.0.1:8787/ws --pairing-gateway 203.0.113.10 --provider claude
```

## 命令

| 命令 | 说明 |
|------|------|
| `linkshell start` | 启动桥接会话（内置或远程 Gateway） |
| `linkshell setup` | 交互式配置向导 |
| `linkshell doctor` | 环境检查和连通性诊断 |

## start 选项

```
--gateway <url>           远程 Gateway 地址（省略则启动内置 Gateway）
--port <port>             内置 Gateway 端口（默认 8787）
--pairing-gateway <url>   QR 码中给手机使用的地址
--provider <name>         claude | codex | custom（默认 claude）
--command <cmd>           自定义命令（custom provider 必填）
--session-id <id>         手动指定 session ID
--client-name <name>      显示名称（默认 local-cli）
--cols <n>                终端列数（默认 120）
--rows <n>                终端行数（默认 36）
--verbose                 详细日志
```

## 配置持久化

```bash
linkshell setup
```

配置保存在 `~/.linkshell/config.json`，后续启动自动读取。

## doctor 检查项

```bash
linkshell doctor
```

- Node.js 版本 >= 18
- node-pty 原生模块
- Claude / Codex CLI 是否安装
- 配置文件状态
- Gateway 连通性和延迟

## 工作原理

```
你的电脑 (CLI + 内置 Gateway)  ◄──WebSocket──►  手机 (App)
```

1. CLI 启动内置 Gateway（或连接远程 Gateway）
2. 通过 PTY 启动目标进程（Claude/Codex/bash）
3. 终端输出通过 WebSocket 转发给手机 App
4. App 的输入回传给 CLI，写入 PTY

支持断线自动重连、ACK 确认、scrollback 缓冲（1000 条）、心跳检测（15s）和协议版本协商。

## License

MIT
