# LinkShell

在手机上远程查看和控制本地 Claude Code / Codex 终端会话。

## 一条命令开始

```bash
npm install -g linkshell-cli
linkshell start --daemon --provider claude
```

CLI 会在后台启动内置 Gateway + 终端桥接，打印配对码和 QR 码。手机扫码即连。App 断开不影响后台进程。

## 命令一览

```bash
linkshell start --daemon --provider claude   # 后台启动（内置 Gateway + 桥接）
linkshell start --provider claude             # 前台启动
linkshell status                              # 查看运行状态
linkshell stop                                # 停止所有后台进程
tail -f ~/.linkshell/bridge.log               # 查看日志

linkshell gateway --daemon                    # 单独后台启动 Gateway（服务器部署用）
linkshell gateway status                      # 查看 Gateway 状态
linkshell gateway stop                        # 停止 Gateway

linkshell setup                               # 交互式配置
linkshell doctor                              # 环境检查
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

### 最简模式（内置 Gateway，局域网）

```bash
linkshell start --daemon --provider claude
```

手机和电脑在同一 WiFi，CLI 自动检测局域网 IP 生成 QR 码。

### 远程桌面查看

```bash
linkshell start --daemon --provider claude --screen
```

加 `--screen` 后，App 端可以切换到 Desktop 标签查看电脑桌面。支持 WebRTC（30fps）和截图流（fallback）两种模式，自动选择最优方案。

> **前置依赖：** 需要安装 [ffmpeg](https://ffmpeg.org/)。
>
> ```bash
> # macOS
> brew install ffmpeg
>
> # Ubuntu / Debian
> sudo apt install ffmpeg
>
> # Windows (Chocolatey)
> choco install ffmpeg
> ```
>
> 安装后 CLI 会自动检测屏幕设备并启动 H.264 编码流。如果同时安装了 [werift](https://github.com/nicktomlin/werift)（`npm i -g werift`），会优先使用 WebRTC 低延迟传输；否则回退到截图流模式。

### 远程模式（独立 Gateway，跨网络）

在服务器上：

```bash
npm install -g linkshell-cli
linkshell gateway --daemon --port 8787
```

在你的电脑上：

```bash
linkshell start --daemon --gateway wss://your-server.com:8787/ws --provider claude
```

也可以用 Docker 部署 Gateway：

```bash
git clone https://github.com/LiuTianjie/LinkShell
cd LinkShell
docker compose up -d
```

详细部署文档见 [docs/deploy.md](docs/deploy.md)。

### 管理后台进程

```bash
linkshell status    # 查看 Bridge 和 Gateway 运行状态
linkshell stop      # 停止所有后台进程
```

### 手机连接

在 App 中：
- 扫描 CLI 打印的 QR 码（推荐）
- 或手动输入 Gateway 地址 + 6 位配对码
- 或从会话列表直接选择

App 断开后重新连接不影响后台进程，扫码或输入配对码即可恢复。

## 本地开发

```bash
pnpm install
pnpm dev:gateway    # 单独启动网关 (localhost:8787)
pnpm dev:web        # Web 调试端 (localhost:5173)
pnpm dev:app        # Expo App

# CLI 本地联调
pnpm --filter linkshell-cli dev start --provider custom --command bash
```

## 交接文档

1. [docs/ai-handoff.md](docs/ai-handoff.md) — 仓库级接手说明
2. [apps/mobile/README.md](apps/mobile/README.md) — 移动端信息架构

## 项目结构

```
├── packages/
│   ├── shared-protocol/       # 三端共享协议（Zod schema、16 种消息类型、版本协商）
│   ├── cli/                   # CLI（PTY、内置 Gateway、daemon、doctor/setup）
│   └── gateway/               # 云端网关（配对、会话、路由、控制权、限流）
│       └── Dockerfile
├── apps/
│   ├── mobile/                # Expo App（WebView + xterm.js、多服务器管理、会话列表）
│   └── web-debug/             # Web 调试端（Vite + xterm.js + 调试面板）
├── docs/
│   ├── site/                  # 宣传 Landing Page
│   ├── ai-handoff.md          # 接手说明
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
- Daemon 模式（CLI 和 Gateway 均支持后台运行）

## License

MIT
