# linkshell-cli

在手机上远程查看和控制本地 Claude Code / Codex 终端会话。

## 安装

```bash
npm install -g linkshell-cli
```

## 一条命令开始

```bash
linkshell start --daemon --provider claude
```

CLI 会在后台：
1. 启动内置 Gateway（端口 8787）
2. 检测局域网 IP
3. 创建配对并打印 QR 码
4. 手机扫码即连

App 断开不影响后台进程，重新扫码即可恢复。

## 命令一览

| 命令 | 说明 |
|------|------|
| `linkshell start` | 启动桥接会话（支持 `--daemon` 后台运行） |
| `linkshell stop` | 停止所有后台进程 |
| `linkshell status` | 查看运行状态 |
| `linkshell gateway` | 启动独立 Gateway（支持 `--daemon`） |
| `linkshell gateway stop` | 停止后台 Gateway |
| `linkshell gateway status` | 查看 Gateway 状态 |
| `linkshell setup` | 交互式配置向导 |
| `linkshell doctor` | 环境检查和连通性诊断 |

## 使用示例

```bash
# 后台启动（推荐）
linkshell start --daemon --provider claude

# 前台启动
linkshell start --provider claude

# 桥接 Codex
linkshell start --daemon --provider codex

# 桥接任意命令
linkshell start --daemon --provider custom --command bash

# 指定端口
linkshell start --daemon --provider claude --port 9000

# 连接远程 Gateway（不启动内置 Gateway）
linkshell start --daemon --gateway wss://your-server.com:8787/ws --provider claude

# 查看状态和日志
linkshell status
tail -f ~/.linkshell/bridge.log

# 停止
linkshell stop
```

## 服务器部署 Gateway

```bash
# 后台启动独立 Gateway
linkshell gateway --daemon --port 8787

# 查看状态
linkshell gateway status

# 查看日志
tail -f ~/.linkshell/gateway.log

# 停止
linkshell gateway stop
```

## start 选项

```
--gateway <url>           远程 Gateway 地址（省略则启动内置 Gateway）
--port <port>             内置 Gateway 端口（默认 8787）
--pairing-gateway <url>   QR 码中给手机使用的地址
--provider <name>         claude | codex | custom（默认 claude）
--command <cmd>           自定义命令（custom provider 必填）
--daemon                  后台运行
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

配置保存在 `~/.linkshell/config.json`。

## doctor 检查项

```bash
linkshell doctor
```

- Node.js 版本 >= 18
- node-pty 原生模块
- Claude / Codex CLI 是否安装
- 配置文件状态
- Gateway 连通性和延迟

## 文件位置

```
~/.linkshell/
├── config.json      # 配置文件
├── bridge.pid       # 桥接进程 PID
├── bridge.log       # 桥接进程日志
├── gateway.pid      # Gateway 进程 PID
└── gateway.log      # Gateway 进程日志
```

## 代码入口

1. src/index.ts — CLI 命令定义
2. src/providers.ts — Provider 适配
3. src/runtime/bridge-session.ts — 核心会话
4. src/utils/daemon.ts — 后台进程管理

## License

MIT
