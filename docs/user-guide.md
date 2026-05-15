# LinkShell 用户指南

## 什么是 LinkShell

LinkShell 让你在手机上远程查看和控制电脑上的通用 shell 终端，也可以用 Agent Workspace 直接操作 Claude Code 与 Codex 的结构化对话。

只需要一条命令：

```bash
npm install -g linkshell-cli
linkshell start --daemon
```

## 两种使用模式

### 模式 A：局域网模式（最简单）

电脑和手机在同一 WiFi 下，一条命令搞定：

```bash
linkshell start --daemon
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
linkshell start --daemon --gateway wss://your-server.com:8787/ws
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
2. 默认 shell 命令（留空使用系统 shell）
3. 显示名称

配置保存在 `~/.linkshell/config.json`。

检查环境是否就绪：

```bash
linkshell doctor
```

## 启动桥接

```bash
# 后台启动（推荐）
linkshell start --daemon

# macOS：允许闲置睡眠（默认会阻止睡眠，避免锁屏后断连）
linkshell start --daemon --no-keep-awake

# 启用远程桌面查看（需要 ffmpeg）
linkshell start --daemon --screen

# 前台启动
linkshell start

# Agent Workspace（自动检测 Claude Code / Codex）
linkshell start --daemon --agent-ui

# 覆盖默认 shell 命令
linkshell start --daemon --command bash

# 连接远程 Gateway
linkshell start --daemon --gateway wss://your-server.com:8787/ws

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

## Agent Workspace

Agent Workspace 是 Terminal 之外的结构化对话界面。开启后，App 底部会出现 Agent 标签，可以选择主机、provider 和工作目录，发送 prompt，查看 assistant 消息、tool call、命令执行、文件变更、计划、权限请求、结构化补充输入和子 Agent 活动，并在需要时取消当前 turn。

推荐直接让 CLI 自动检测：

```bash
linkshell start --daemon --agent-ui
```

当前支持：

- Codex：默认使用 `codex app-server --listen stdio://`
- Claude Code：优先使用 `@anthropic-ai/claude-agent-sdk`，未安装时回退到 `claude --print --output-format stream-json --input-format stream-json`
- Custom：使用自定义 ACP/Agent 命令

如果需要手动覆盖 provider 或命令：

```bash
linkshell start --daemon --agent-ui --agent-command "codex app-server --listen stdio://"
linkshell start --daemon --agent-ui --agent-provider claude
linkshell start --daemon --agent-ui --agent-provider custom --agent-command "<your-acp-adapter>"
```

CLI 会把可用 provider、模型列表、默认模型、reasoning effort、permission mode 等 capabilities 同步给 App，所以手机端模型选择会随本机 CLI 能力动态变化。

Agent Workspace 不替代 Terminal。若本机 Agent provider 不可用，App 会显示不可用说明，终端、远程桌面和浏览器预览仍会照常工作。

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

常用 `start` 选项：

| 选项 | 说明 |
|------|------|
| `--command <cmd>` | 覆盖默认 shell 命令 |
| `--agent-ui` / `--no-agent-ui` | 启用或关闭 Agent Workspace channel |
| `--agent-provider <name>` | Agent provider：`codex` / `claude` / `custom` |
| `--agent-command <cmd>` | 自定义 ACP/Agent 命令 |
| `--screen` | 启用远程桌面 |
| `--no-keep-awake` | macOS 上允许闲置睡眠 |

## 常见问题

### Mac 锁屏后会断开吗？

默认不会因为闲置睡眠而断开。`linkshell start` 在 macOS 上会自动开启保活，等价于在 bridge 进程运行期间执行 `caffeinate -i -w <bridge-pid>`：系统不会进入 idle sleep，但屏幕仍然可以熄灭，电脑也仍然可以锁屏。

如果你想省电、允许系统睡眠，可以用：

```bash
linkshell start --daemon --no-keep-awake
# 或
LINKSHELL_KEEP_AWAKE=0 linkshell start --daemon
```

如果是手动合盖、断网或系统强制休眠，连接仍可能中断；电脑唤醒后 CLI 会继续按现有重连策略恢复。

### 直接 `linkshell start` 就行吗？不需要部署 Gateway？

对。如果你的电脑和手机在同一局域网，直接 `linkshell start` 就行，CLI 会自动启动内置 Gateway。

只有跨网络（比如在外面用手机连家里电脑）才需要在公网服务器上部署独立 Gateway。

### node-pty 报错

node-pty 需要编译原生模块。如果全局安装时报错，试试：

```bash
npm install -g linkshell-cli --build-from-source
```

### 想在终端里用 Claude / Codex / Gemini / Copilot？

终端只是远程 shell。连接后直接在 shell 里运行对应 CLI 即可；Agent Workspace 会在独立界面读取主机端可用的 Claude / Codex 能力。

daemon 模式下环境变量可能比交互式 shell 更少，必要时用 `--command /absolute/path/to/cli` 指定完整路径。

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
- Agent Workspace timeline 会缓存在手机本地 AsyncStorage，便于恢复历史对话
- 配对码 10 分钟过期
- 会话空闲 30 分钟自动清理
- 建议远程模式使用 HTTPS（wss://）
- 当前不支持端到端加密
