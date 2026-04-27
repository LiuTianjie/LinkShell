# LinkShell 用户指南

## 什么是 LinkShell

LinkShell 让你在手机上远程查看和控制电脑上的 Claude Code / Codex 终端会话。

只需要一条命令：

```bash
npm install -g linkshell-cli
linkshell start --daemon --provider claude
```

## 两种使用模式

### 模式 A：局域网模式（最简单）

电脑和手机在同一 WiFi 下，一条命令搞定：

```bash
linkshell start --daemon --provider claude
```

CLI 会自动启动内置 Gateway，检测局域网 IP，打印 QR 码。手机扫码即连。App 断开不影响后台进程。

### 模式 B：远程模式（跨网络）

需要一台有公网 IP 的服务器做中转。

在服务器上：

```bash
# 方式 1：用 CLI 直接跑（推荐）
npm install -g linkshell-cli
linkshell gateway --daemon --port 8787

# 方式 2：用 Docker
git clone https://github.com/LiuTianjie/LinkShell
cd LinkShell
docker compose up -d
```

在你的电脑上：

```bash
linkshell start --daemon --gateway wss://your-server.com:8787/ws --provider claude
```

## 安装

```bash
# npm（推荐）
npm install -g linkshell-cli

# Homebrew (macOS)
brew install LiuTianjie/linkshell/linkshell

# 一键安装
curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh
```

## 升级

```bash
linkshell upgrade
```

自动检测安装方式（npm 或 brew），拉取最新版本。

## 首次配置（可选）

```bash
linkshell setup
```

它会问你：
1. Gateway 地址（留空则使用内置 Gateway，推荐局域网用户留空）
2. 默认 Provider（选 claude、codex 或 custom）
3. 显示名称

配置保存在 `~/.linkshell/config.json`。

检查环境是否就绪：

```bash
linkshell doctor
```

## 启动桥接

```bash
# 后台启动（推荐）
linkshell start --daemon --provider claude

# macOS：允许闲置睡眠（默认会阻止睡眠，避免锁屏后断连）
linkshell start --daemon --provider claude --no-keep-awake

# 启用远程桌面查看（需要 ffmpeg）
linkshell start --daemon --provider claude --screen

# 前台启动
linkshell start --provider claude

# 桥接 Codex
linkshell start --daemon --provider codex

# 桥接任意命令
linkshell start --daemon --provider custom --command bash

# 指定端口
linkshell start --daemon --provider claude --port 9000

# 连接远程 Gateway
linkshell start --daemon --gateway wss://your-server.com:8787/ws --provider claude

# 查看状态和日志
linkshell status
tail -f ~/.linkshell/bridge.log

# 停止
linkshell stop
```

启动后你会看到：

```
  Built-in gateway started on port 8787
  LAN address: http://192.168.1.12:8787

  Pairing code: 847293
  Session: a1b2c3d4-...
  Expires: 2026-04-01T10:30:00Z

  Scan to connect:
  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  ...
```

## 手机连接

打开 LinkShell App：

1. 扫描 CLI 显示的 QR 码（推荐）
2. 或手动输入 Gateway 地址 + 6 位配对码
3. 或从会话列表直接选择

连接后你可以：
- 查看终端输出（完整颜色和格式）
- 输入命令
- 使用特殊键（Esc、Tab、Ctrl+C 等）
- 断开后自动重连

## 所有命令

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
| `linkshell upgrade` | 升级到最新版本 |
| `linkshell login` | 登录账户（启用高级网关） |
| `linkshell logout` | 退出登录 |

## 常见问题

### Mac 锁屏后会断开吗？

默认不会因为闲置睡眠而断开。`linkshell start` 在 macOS 上会自动开启保活，等价于在 bridge 进程运行期间执行 `caffeinate -i -w <bridge-pid>`：系统不会进入 idle sleep，但屏幕仍然可以熄灭，电脑也仍然可以锁屏。

如果你想省电、允许系统睡眠，可以用：

```bash
linkshell start --daemon --provider claude --no-keep-awake
# 或
LINKSHELL_KEEP_AWAKE=0 linkshell start --daemon --provider claude
```

如果是手动合盖、断网或系统强制休眠，连接仍可能中断；电脑唤醒后 CLI 会继续按现有重连策略恢复。

### 直接 `linkshell start` 就行吗？不需要部署 Gateway？

对。如果你的电脑和手机在同一局域网，直接 `linkshell start --provider claude` 就行，CLI 会自动启动内置 Gateway。

只有跨网络（比如在外面用手机连家里电脑）才需要在公网服务器上部署独立 Gateway。

### node-pty 报错

node-pty 需要编译原生模块。如果全局安装时报错，试试：

```bash
npm install -g linkshell-cli --build-from-source
```

### CLI 报 "Claude CLI not found"

需要先安装 Claude Code CLI：

```bash
npm install -g @anthropic-ai/claude-code
```

### App 连不上

1. 确认手机和电脑在同一 WiFi
2. 确认 CLI 打印的 LAN 地址手机能访问
3. 如果用远程 Gateway，确认防火墙开放了端口
4. 在 App 的服务器管理里点 "Test" 测试连通性

### 网络断开后怎么办

LinkShell 会自动重连：
- 短暂断网（几秒）：自动恢复，不丢失输出
- 较长断网（几十秒）：重连后从上次确认点重放输出
- 超过重连上限：自动进入慢速探测模式（每 30 秒检测一次），Gateway 恢复后自动重连，无需手动操作
- 超过 60 秒：host 会话可能被清理，需要重新启动 CLI

### 多个设备可以同时连接吗

目前只支持单设备控制。第一个连接的设备自动获得控制权。

## 安全说明

- Gateway 只做消息转发，不存储终端内容
- 配对码 10 分钟过期
- 会话空闲 30 分钟自动清理
- 建议远程模式使用 HTTPS（wss://）
- 当前不支持端到端加密
