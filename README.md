# LinkShell

在手机上远程查看和控制本地 Claude Code / Codex 终端会话。

## 架构

```
你的电脑                    公网服务器                    你的手机
┌──────────┐  WebSocket   ┌──────────┐   WebSocket   ┌──────────┐
│ CLI      │ ────────────►│ Gateway  │◄──────────── │ App      │
│ (PTY)    │              │ (中转)    │              │ (xterm)  │
└──────────┘              └──────────┘              └──────────┘
  Claude/Codex              只转发消息                 远程查看+控制
  在这里运行                不接触终端内容
```

- **CLI** — 在你电脑上运行，通过 PTY 启动 Claude/Codex/bash，捕获完整终端输出并转发到网关
- **Gateway** — 部署在任何公网服务器，只做消息中转，不接触终端内容
- **App** — Expo 开发的手机端，WebView + xterm.js 完整终端渲染

## 快速开始

### 1. 部署 Gateway

```bash
git clone https://github.com/user/linkshell
cd linkshell
docker compose up -d
```

验证：`curl http://your-server.com:8787/healthz`

详细部署文档见 [docs/deploy.md](docs/deploy.md)（含 nginx 反代、HTTPS、防火墙配置）。

### 2. 安装 CLI

```bash
npm install -g @linkshell/cli
```

首次使用运行交互式配置：

```bash
linkshell setup    # 配置默认 gateway 地址和 provider
linkshell doctor   # 检查环境（Node.js、node-pty、claude/codex、网络连通性）
```

### 3. 桥接终端

```bash
# 桥接 Claude Code
linkshell start --gateway wss://your-server.com:8787/ws --provider claude

# 如果 CLI 连的是本机地址，但手机要扫公网 IP
linkshell start --gateway ws://127.0.0.1:8787/ws --pairing-gateway 203.0.113.10 --provider claude

# 桥接 Codex
linkshell start --gateway wss://your-server.com:8787/ws --provider codex

# 桥接任意命令
linkshell start --gateway wss://your-server.com:8787/ws --provider custom --command bash
```

CLI 会打印 6 位配对码和 QR 码：

```
  Pairing code: 847293
  Session: a1b2c3d4-...
  Expires: 2026-04-01T10:30:00Z

  Scan to connect:
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ █ ...
  ...
```

如果二维码需要写入一个不同于 CLI 实际连接地址的公网 IP 或域名，可以传 `--pairing-gateway`。这个参数支持两种形式：

- 完整地址：`--pairing-gateway https://your-server.com:8787`
- 裸 IP / 域名：`--pairing-gateway 203.0.113.10`

传裸 IP 或域名时，会沿用 `--gateway` 的协议和端口，只替换主机名。

如果已运行 `linkshell setup`，可以省略 `--gateway`：

```bash
linkshell start --provider claude
```

### 4. 手机连接

在 App 中：
- 添加 Gateway 服务器地址
- 输入 6 位配对码或扫描 QR 码
- 也可以从会话列表直接选择活跃会话

## 本地开发

```bash
pnpm install
pnpm dev:gateway    # 启动网关 (localhost:8787)
pnpm dev:web        # Web 调试端 (localhost:5173)
pnpm dev:app        # Expo App

# CLI 本地联调
pnpm --filter @linkshell/cli dev start --gateway ws://localhost:8787/ws --provider custom --command bash

# 让二维码指向手机可访问的局域网或公网地址
pnpm --filter @linkshell/cli dev start --gateway ws://localhost:8787/ws --pairing-gateway 192.168.1.50 --provider custom --command bash
```

## 交接文档

如果你准备把仓库交给下一个 AI 或开发者继续做，先看这两个文件：

1. [docs/ai-handoff.md](docs/ai-handoff.md) — 仓库级接手说明、关键入口、当前实现状态
2. [apps/mobile/README.md](apps/mobile/README.md) — 移动端当前信息架构、关键文件和最近 UI 约定

## 项目结构

```
├── packages/
│   ├── shared-protocol/       # 三端共享协议（Zod schema、16 种消息类型、版本协商）
│   ├── cli/                   # 本地桥接 CLI（PTY、重连、scrollback、doctor/setup）
│   └── gateway/               # 云端网关（配对、会话、路由、控制权、限流）
│       └── Dockerfile
├── apps/
│   ├── mobile/                # Expo App（WebView + xterm.js、多服务器管理、会话列表）
│   └── web-debug/             # Web 调试端（Vite + xterm.js + 调试面板）
├── docs/
│   ├── site/                  # 宣传 Landing Page
│   ├── ai-handoff.md          # 给下一个 AI/开发者的接手说明
│   └── deploy.md              # 部署文档
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
| `GET` | `/pairings/:code/status` | 查询配对状态（waiting/claimed） |
| `GET` | `/sessions` | 列出活跃会话（含 provider、hostname） |
| `GET` | `/sessions/:id` | 会话详情 |
| `WS` | `/ws?sessionId=&role=` | 实时连接 |

## 可靠性

- ACK 确认 + 双层缓冲（CLI 1000 条 + 网关 200 条）
- 指数退避自动重连（CLI 和 App 双端）
- 心跳检测（15s/20s）
- 会话保持（host 断开保留 60s，空闲 30min 清理）
- 单设备控制权管理（claim/grant/reject/release）
- 协议版本协商（PROTOCOL_VERSION）
- CORS + 限流 + 优雅关闭

## CLI 命令

| 命令 | 说明 |
|------|------|
| `linkshell start` | 启动桥接会话 |
| `linkshell setup` | 交互式配置向导 |
| `linkshell doctor` | 环境检查和连通性诊断 |

配置保存在 `~/.linkshell/config.json`。

## 部署

### Docker（推荐）

```bash
docker compose up -d
PORT=9000 docker compose up -d  # 自定义端口
```

### HTTPS（生产环境）

用 nginx 反代 Gateway，详见 [docs/deploy.md](docs/deploy.md)。

## License

MIT
