# LinkShell

在手机上远程查看和控制本地 Claude Code / Codex 终端会话。

## 一条命令开始

```bash
npm install -g linkshell-cli
linkshell start --provider claude
```

CLI 会自动启动内置 Gateway，创建配对，打印 QR 码。手机扫码即连。

```
  Built-in gateway started on port 8787
  LAN address: http://192.168.1.12:8787

  Pairing code: 847293
  Session: a1b2c3d4-...

  Scan to connect:
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ █ ...
```

## 架构

```
你的电脑                                         你的手机
┌──────────────────────┐   WebSocket   ┌──────────┐
│ CLI + 内置 Gateway    │ ◄───────────► │ App      │
│ (PTY + 消息中转)      │              │ (xterm)  │
└──────────────────────┘              └──────────┘
```

默认模式下 CLI 内置 Gateway，一条命令搞定。也可以把 Gateway 独立部署到公网服务器：

```
你的电脑                    公网服务器                    你的手机
┌──────────┐  WebSocket   ┌──────────┐   WebSocket   ┌──────────┐
│ CLI      │ ────────────►│ Gateway  │◄──────────── │ App      │
│ (PTY)    │              │ (中转)    │              │ (xterm)  │
└──────────┘              └──────────┘              └──────────┘
```

## 使用方式

### 最简模式（内置 Gateway）

```bash
# 桥接 Claude Code
linkshell start --provider claude

# 桥接 Codex
linkshell start --provider codex

# 桥接任意命令
linkshell start --provider custom --command bash

# 指定端口
linkshell start --provider claude --port 9000
```

手机和电脑需要在同一局域网。CLI 会自动检测局域网 IP 并生成 QR 码。

### 远程模式（独立 Gateway）

先在服务器上部署 Gateway（二选一）：

```bash
# 方式 A：用 CLI 直接跑（推荐，不需要 Docker）
npm install -g linkshell-cli
linkshell gateway --port 8787

# 方式 B：用 Docker
docker compose up -d
```

然后 CLI 连接远程 Gateway：

```bash
linkshell start --gateway wss://your-server.com:8787/ws --provider claude
```

详细部署文档见 [docs/deploy.md](docs/deploy.md)。

### 首次配置（可选）

```bash
linkshell setup    # 交互式配置默认 gateway 和 provider
linkshell doctor   # 检查环境
```

## 手机连接

在 App 中：
- 扫描 CLI 打印的 QR 码（推荐）
- 或手动输入 Gateway 地址 + 6 位配对码
- 或从会话列表直接选择

## 本地开发

```bash
pnpm install
pnpm dev:gateway    # 单独启动网关 (localhost:8787)
pnpm dev:web        # Web 调试端 (localhost:5173)
pnpm dev:app        # Expo App

# CLI 本地联调（内置 Gateway）
pnpm --filter linkshell-cli dev start --provider custom --command bash

# CLI 连接独立 Gateway
pnpm --filter linkshell-cli dev start --gateway ws://localhost:8787/ws --provider custom --command bash
```

## 交接文档

如果你准备把仓库交给下一个 AI 或开发者继续做，先看这两个文件：

1. [docs/ai-handoff.md](docs/ai-handoff.md) — 仓库级接手说明、关键入口、当前实现状态
2. [apps/mobile/README.md](apps/mobile/README.md) — 移动端当前信息架构、关键文件和最近 UI 约定

## 项目结构

```
├── packages/
│   ├── shared-protocol/       # 三端共享协议（Zod schema、16 种消息类型、版本协商）
│   ├── cli/                   # CLI（PTY、内置 Gateway、重连、scrollback、doctor/setup）
│   └── gateway/               # 云端网关（配对、会话、路由、控制权、限流）
│       └── Dockerfile
├── apps/
│   ├── mobile/                # Expo App（WebView + xterm.js、多服务器管理、会话列表）
│   └── web-debug/             # Web 调试端（Vite + xterm.js + 调试面板）
├── docs/
│   ├── site/                  # 宣传 Landing Page
│   ├── ai-handoff.md          # 给下一个 AI/开发者的接手说明
│   ├── deploy.md              # Gateway 部署文档
│   └── user-guide.md          # 终端用户文档
├── docker-compose.yml
├── .env.example
└── PRD.md
```

## 网关 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/healthz` | 健康检查 |
| `POST` | `/pairings` | 创建配对（6 位 code，10 分钟有效） |
| `POST` | `/pairings/claim` | 用 code 换取 sessionId |
| `GET` | `/pairings/:code/status` | 查询配对状态 |
| `GET` | `/sessions` | 列出活跃会话 |
| `GET` | `/sessions/:id` | 会话详情 |
| `WS` | `/ws?sessionId=&role=` | 实时连接 |

## 可靠性

- ACK 确认 + 双层缓冲（CLI 1000 条 + 网关 200 条）
- 指数退避自动重连（CLI 和 App 双端）
- 心跳检测（15s/20s）
- 会话保持（host 断开保留 60s，空闲 30min 清理）
- 单设备控制权管理
- 协议版本协商
- CORS + 限流 + 优雅关闭

## License

MIT
