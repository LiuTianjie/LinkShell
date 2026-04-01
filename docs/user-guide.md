# LinkShell 用户指南

## 什么是 LinkShell

LinkShell 让你在手机上远程查看和控制电脑上的 Claude Code / Codex 终端会话。

它由三部分组成：
- **CLI** — 安装在你的电脑上，桥接本地终端
- **Gateway** — 部署在服务器上，中转消息
- **App** — 安装在手机上，远程查看和控制

## 第一步：部署 Gateway

Gateway 是消息中转服务，需要部署在一台有公网 IP 的服务器上。

```bash
# 在服务器上
git clone https://github.com/user/linkshell
cd linkshell
docker compose up -d
```

验证是否成功：

```bash
curl http://your-server-ip:8787/healthz
# 应该返回 {"ok":true}
```

如果需要 HTTPS，参考 [部署文档](deploy.md) 配置 nginx 反代。

## 第二步：安装 CLI

在你的电脑上（macOS / Linux / Windows）：

```bash
npm install -g @linkshell/cli
```

首次使用，运行配置向导：

```bash
linkshell setup
```

它会问你：
1. Gateway 地址（填你服务器的地址，如 `wss://your-server.com:8787/ws`）
2. 默认 Provider（选 claude、codex 或 custom）
3. 显示名称

配置完成后，检查环境是否就绪：

```bash
linkshell doctor
```

它会检查：
- Node.js 版本
- node-pty 原生模块
- Claude / Codex CLI 是否安装
- Gateway 是否可达

## 第三步：启动桥接

```bash
# 桥接 Claude Code（最常用）
linkshell start --provider claude

# 桥接 Codex
linkshell start --provider codex

# 桥接任意命令
linkshell start --provider custom --command bash
```

如果已经运行过 `linkshell setup`，不需要每次都写 `--gateway`。

启动后你会看到：

```
  Pairing code: 847293
  Session: a1b2c3d4-...
  Expires: 2026-04-01T10:30:00Z

  Scan to connect:
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  ...
```

## 第四步：手机连接

打开 LinkShell App：

1. 添加服务器 — 输入你的 Gateway 地址（如 `http://your-server.com:8787`）
2. 输入配对码 — 输入 CLI 显示的 6 位数字，或扫描 QR 码
3. 连接成功 — 你会看到完整的终端界面

连接后你可以：
- 查看终端输出（完整颜色和格式）
- 输入命令
- 使用特殊键（Esc、Tab、Ctrl+C 等）
- 断开后自动重连

## 常见问题

### CLI 报 "posix_spawnp failed"

node-pty 的原生模块没有正确构建。运行：

```bash
pnpm approve-builds   # 选中 node-pty
pnpm install --force
```

### CLI 报 "Claude CLI not found"

需要先安装 Claude Code CLI：

```bash
npm install -g @anthropic-ai/claude-code
```

### App 连不上 Gateway

1. 确认 Gateway 正在运行：`curl http://your-server:8787/healthz`
2. 确认防火墙开放了 8787 端口
3. 如果用的是 HTTPS，确认 App 里填的是 `https://` 开头的地址
4. 在 App 的服务器管理里点 "Test" 测试连通性

### 网络断开后怎么办

LinkShell 会自动重连。CLI 和 App 都有指数退避重连机制：
- 短暂断网（几秒）：自动恢复，不丢失输出
- 较长断网（几十秒）：重连后从上次确认点重放输出
- 超过 60 秒：host 会话可能被清理，需要重新启动 CLI

### 多个设备可以同时连接吗

目前只支持单设备控制。第一个连接的设备自动获得控制权，其他设备的输入会被拒绝。

### Gateway 重启后会话还在吗

不在。当前 Gateway 使用内存存储，重启后所有会话丢失。需要重新启动 CLI 并重新配对。

### 支持 vim / tmux 吗

基本支持。LinkShell 使用 PTY 真终端桥接，大部分终端程序都能工作。但复杂的全屏程序（如 vim 的某些插件）可能有渲染问题。

## 安全说明

- Gateway 只做消息转发，不存储终端内容
- 配对码 10 分钟过期
- 会话空闲 30 分钟自动清理
- 建议生产环境使用 HTTPS（wss://）
- 当前不支持端到端加密，终端内容在 Gateway 上是明文中转的
