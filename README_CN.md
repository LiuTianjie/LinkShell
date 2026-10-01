<p align="center">
  <img src="docs/assets/adaptive-icon.png" alt="LinkShell" width="96" />
</p>

<h1 align="center">LinkShell</h1>

<p align="center">
  <strong>离开电脑，Agent 接着干。</strong><br />
  在手机上看电脑里的编程 Agent 干活、随时插话、一键审批。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/linkshell-cli"><img src="https://img.shields.io/npm/v/linkshell-cli?style=flat-square&amp;color=4a6cf7" alt="npm 上的 CLI 版本" /></a>
  <a href="https://github.com/LiuTianjie/LinkShell/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/LiuTianjie/LinkShell/test.yml?style=flat-square&amp;label=tests" alt="测试状态" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-64748b?style=flat-square" alt="MIT 许可证" /></a>
</p>

<p align="center">
  <a href="https://liutianjie.github.io/LinkShell/">官网</a> ·
  <a href="https://liutianjie.github.io/LinkShell/docs/">文档</a> ·
  <a href="https://apps.apple.com/cn/app/linkshell/id6761547516">iPhone</a> ·
  <a href="https://github.com/LiuTianjie/LinkShell/releases/latest">Android APK</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/site/assets/shots/ios-session.webp" alt="在手机上继续的 Claude Code 会话：计划、改动与回复" width="230" />
  <img src="docs/site/assets/shots/ios-home.webp" alt="首页：各个项目的会话，最上面是正在运行的终端" width="230" />
  <img src="docs/site/assets/shots/ios-preview.webp" alt="在手机上打开电脑本地的开发服务器" width="230" />
</p>

Claude Code、Codex 这些编程 Agent 继续在你的电脑上跑。你在手机上看它实时干活，随时发消息，一键审批它要的权限，回到电脑前再把会话交还给终端。代码和 Agent 进程都不离开你的电脑，连接全程端到端加密。

## 开始使用

电脑需要 macOS 或 Linux，以及 **Node.js 22.13 或更新版本**。

```bash
npm i -g linkshell-cli
linkshell host --daemon
```

然后用下面任一方式连接手机（[iPhone](https://apps.apple.com/cn/app/linkshell/id6761547516) · [Android](https://github.com/LiuTianjie/LinkShell/releases/latest)）：

- **Pro：官方网关。** 运行 `linkshell login`，然后在 App 里登录同一个账号，电脑会自动出现，不用扫码。
- **免费：自建网关。** 先运行一个网关（见[下文](#自建网关)），让 host 连上它，配对一次：

  ```bash
  linkshell host --gateway wss://gw.example.com --daemon
  linkshell pair    # 在 App 的「电脑 → 添加电脑」里扫码
  ```

可以直接在手机上新建会话；也可以在电脑终端里这样启动 Agent，随时交给手机：

```bash
linkshell claude    # Claude Code：手机上发消息即接管，终端里按任意键收回
linkshell codex     # Codex：终端和手机同时在线
```

<details>
<summary>其他安装方式</summary>

```bash
brew install LiuTianjie/linkshell/linkshell
curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh
```

</details>

## 能做什么

- **电脑与手机接力。** 同一个会话 ID，上下文不丢。在手机上选好的模型和思考强度，接管时自动生效。
- **实时跟进。** 回复逐字出现；计划、工具调用和文件改动实时更新，每个文件都能看 diff。
- **干活时也能说话。** 运行中发的消息在输入框上方排队：可以调整顺序、取回重新编辑，或者立即发送——Codex 和 Claude 直接插进当前这一轮，其他 Agent 先停下当前这一轮。电脑上正在跑的那一轮，手机上也能停。
- **子 Agent 随手可查。** 会话标题旁的按钮列出这个会话启动过的所有子 Agent 和各自的对话，不用翻回很早以前。
- **分叉和 worktree。** 从任意一条回复分叉出新会话，换个方向试试——留在当前目录，或者放进新的 git worktree；新会话也可以直接开在 worktree 里，不碰你手头的工作区。Claude 和 Codex 原生分叉；其他 Agent 由 LinkShell 把之前的对话以文字交给它。
- **斜杠命令。** 输入 `/` 列出 Agent 提供的命令和你的 skills。Codex 的 `/compact`、`/review` 在手机上同样可用。
- **随时审批。** 权限请求推到手机上，一键允许或拒绝。
- **调整设置。** 模型、思考强度、权限模式、快速模式，取决于 Agent 提供了哪些。
- **整理会话。** 重命名、归档、删除；Codex 和 Claude 会同步到它们自己的记录里。
- **真终端。** 电脑上的终端，带 Ctrl、Esc、Tab、方向键工具栏；关掉 App 也不会中断。
- **在手机上打开 localhost。** 电脑上开发服务器的端口，走同一条加密通道，热更新照常，可以全屏。不需要开放端口，也不需要同一个 Wi-Fi。
- **长会话也轻快。** 打开会话先显示最近几轮，下拉再加载更早的；里面的截图看到时才加载。
- **屏幕和文件。** 看一眼电脑屏幕（需要 `ffmpeg`），浏览和查看项目里的文件，把手机里的图片和文件传到项目里。

## 支持的 Agent

LinkShell 用的是你电脑上已经安装、已经登录的 Agent，不经手它们的账号和 API key。

| Agent | 方式 | 体验 |
| --- | --- | --- |
| **Codex** | 多端同步 | `linkshell codex` 打开的终端和手机同时在线，任何一端都能发消息、打断、审批 |
| **Claude Code** | 接力 | 电脑上用 Claude 自己的界面；手机发消息即接管，电脑按任意键收回 |
| **Gemini CLI、GitHub Copilot、OpenCode、Cursor、Grok** | 远程会话 | 通过 [Agent Client Protocol](https://agentclientprotocol.com) 在手机上新建、继续会话：实时输出、审批、模式和模型 |
| **任何命令行工具** | 终端 | 在电脑上开终端，手机上看和输入 |

在 Claude 桌面 App 里打开的会话，手机上同样可以实时查看、接着做。但桌面 App 没法接收交回的会话：手机上做的内容要重启 App 后它才知道。想来回接力，用 `linkshell claude` 启动会话。

## 自建网关

网关只转发加密数据并负责配对，占用资源很少。任选一种：

```bash
# 在服务器上用 CLI
linkshell gateway --port 8787 --daemon

# 或者 Docker
docker run -d --name linkshell-gateway -p 8787:8787 \
  -v linkshell-gateway:/data nickname4th/linkshell-gateway
```

公网上请在前面加一层 HTTPS 反向代理（Caddy、Nginx），然后用 `wss://你的域名`。只在家里用的话，网关可以直接跑在这台电脑上：`linkshell host --gateway ws://局域网IP:8787`。更多见[部署指南](docs/deploy.md)。

## 安全

- **端到端加密。** 手机和电脑之间的数据全部加密，官方网关和自建网关都只能看到密文。
- **配对即授权。** 配对的手机能做你在这台电脑终端里能做的事。只配对你信任的设备，配对码不要外传。
- **Agent 用的是你的账号。** Agent 以你的用户身份运行，使用你登录 shell 的环境变量和它们自己的登录。Pro 订阅只包含网关服务。
- **数据在本地。** 会话和历史保存在电脑上的 `~/.linkshell`，重启后配对依然有效。

## 命令

| 做什么 | 命令 |
| --- | --- |
| 后台启动 LinkShell | `linkshell host --daemon` |
| 查看 Agent、会话和网关 | `linkshell host status` |
| 停止 | `linkshell host stop` |
| 配对手机（自建网关） | `linkshell pair` |
| 查看、移除已配对的手机 | `linkshell devices` / `linkshell devices remove <名称>` |
| 使用官方网关（Pro） | `linkshell login` / `linkshell logout` |
| 可交给手机的 Claude Code / Codex | `linkshell claude` / `linkshell codex`（参数原样传递） |
| 运行网关 | `linkshell gateway [--port 8787] [--daemon]` |
| 检查环境 | `linkshell doctor` |
| 升级 | `linkshell upgrade` |

> **从 1.x 升级？** 2.0 的 App 和电脑端都换了，需要两边一起升级，再重新配对一次。1.x 的 App 仍然可以配合 `linkshell start` 使用。

## 开发

pnpm workspace，Node.js 22（CI 使用 22）。

```bash
git clone https://github.com/LiuTianjie/LinkShell.git
cd LinkShell
pnpm install
pnpm build
pnpm test
```

| 目录 | 内容 |
| --- | --- |
| `packages/wire` | 会话模型、JSON-RPC 方法、端到端加密、中继客户端 |
| `packages/host` | 电脑端守护进程：Agent 驱动（Codex app-server、Claude 接力、ACP）、终端、端口、屏幕 |
| `packages/gateway-v2` | 中继：转发加密帧，负责配对 |
| `packages/gateway` | 可部署的网关（官方与自建），包含 1.x 支持 |
| `packages/cli` | `linkshell`：host、配对、Agent 启动器、网关、登录 |
| `packages/client-core` | App 共用的客户端状态与时间线 |
| `apps/client` | 2.0 App：Expo / React Native，iOS 与 Android |
| `apps/mobile`、`apps/web-dashboard`、`packages/shared-protocol` | 1.x 的 App、网页控制台和协议 |
| `docs/site` | 官网与安装脚本（修改后运行 `python3 scripts/build-site-pages.py`） |

开发 App 时，在 Metro 旁边跑一个带本地 API 的 host：

```bash
cd packages/cli && npx tsx src/index.ts host --dev-port 7878
pnpm --filter @linkshell/client start
```

欢迎提交聚焦的问题反馈和 PR。请附上 CLI 版本、系统、Agent 和最小复现步骤，并去掉配对码和 token。发版流程见 [release SOP](docs/release-sop.md)。

## 支持项目

由 [AI18N](https://ai18n.chat/) 赞助：提供兼容 OpenAI 与 Anthropic 接口的 AI API 网关。

<details>
<summary>请作者喝杯咖啡</summary>

<p>
  <img src="docs/assets/pay_wechat.jpg" alt="微信支付收款码" width="160" />
  <img src="docs/assets/pay_ali.jpg" alt="支付宝收款码" width="160" />
</p>

</details>

[Product Hunt](https://www.producthunt.com/products/linkshell)

## 许可证

[MIT](LICENSE)。
