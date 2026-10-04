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
  <a href="https://liutianjie.github.io/LinkShell/assets/promo/linkshell-2.0.mp4"><img src="docs/site/assets/promo/poster.jpg" alt="LinkShell 介绍片" width="820" /></a><br />
  <sub>▶ <a href="https://liutianjie.github.io/LinkShell/assets/promo/linkshell-2.0.mp4">看 40 秒介绍片</a></sub>
</p>

Claude Code、Codex 这些编程 Agent 继续在你的电脑上跑。你在手机上看它实时干活，随时发消息，一键审批它要的权限，回到电脑前再把会话交还给终端。代码和 Agent 进程都不离开你的电脑，连接全程端到端加密。

## 开始使用

电脑需要 macOS 或 Linux，以及 **Node.js 22.13 或更新版本**。

```bash
npm i -g linkshell-cli
linkshell setup
```

`linkshell setup` 一次把该做的都做完：在后台启动 host，把屏幕准备好（Mac 上会弹出一个 LinkShell 窗口，带你到两个权限开关前，开一个勾一个），再连上你的手机。随时可以再运行；每一步也有各自的命令。

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

在手机上看和控制电脑屏幕需要 macOS 的两项权限，`linkshell setup` 会带你设置好；只想做这一步，或者以后想检查：

```bash
linkshell screen      # macOS：弹出 LinkShell 窗口，带你到每个开关前，等你打开
```

在 Mac 上不需要再装别的：画面和控制都由 **LinkShell** 完成——一个随 CLI 一起安装的带签名的程序。它的两项权限（录屏、辅助功能）是两个名为 LinkShell 的开关，打开一次即可：不管用哪个终端启动 host、怎么升级，都不用再授权。需要 Apple 芯片的 Mac、macOS 13 及以上。Linux 上可以看屏幕（不能控制），需要装有 `ffmpeg`。

<details>
<summary>其他安装方式</summary>

```bash
brew install LiuTianjie/linkshell/linkshell
curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh
```

</details>

## 能做什么

<table>
  <tr>
    <td width="33%" valign="top">
      <img src="docs/site/assets/promo/card-follow.jpg" alt="手机上的会话：计划、工具调用和一条权限请求" width="100%" /><br />
      <strong>看着它干活，点一下批准</strong><br />
      回复逐字出现，计划、工具调用和 diff 实时更新。它需要权限或者要你做选择时，请求推到手机上，允许或拒绝点一下就行。
    </td>
    <td width="33%" valign="top">
      <img src="docs/site/assets/promo/card-queue.jpg" alt="输入框上方排队的消息" width="100%" /><br />
      <strong>它正忙，你照样能插话</strong><br />
      忙的时候发的消息先排队：调整顺序、取回重写，或者立即发送，直接插进当前这一轮。电脑上正在跑的那一轮，手机上也能停。会话在终端、桌面 App 里开的都行。
    </td>
    <td width="33%" valign="top">
      <img src="docs/site/assets/promo/card-screen.jpg" alt="手机横屏显示电脑屏幕，触控板模式" width="100%" /><br />
      <strong>直接看电脑屏幕</strong><br />
      能直连时是实时视频，比电脑自己的显示器只慢几十毫秒。全屏、横屏，切到触控板模式就能接手鼠标和键盘（macOS，Apple 芯片）。
    </td>
  </tr>
</table>

还有：

- **回答它的提问。** Agent 让你做选择或填内容时——Claude 的提问、Codex 的提问、MCP 服务的表单——问题会连同选项一起推到手机上：选一个、自己写，或者跳过。
- **直连你的电脑。** 屏幕画面和端口预览在能直连时点对点传输（同一网络，或者穿透 NAT），网关只负责帮两边找到对方。直连时 Mac 的屏幕是实时视频（WebRTC、硬件编码，指针在手机上本地绘制），延迟只有几十毫秒；连不上时才经网关中转，并自动降低画质，保证跟得上。
- **分叉和 worktree。** 想换个思路，就从那条回复分叉出一个新会话；可以留在当前目录，也可以放进新的 git worktree，不碰你手头的工作区。
- **子 Agent、Claude Workflow 和长会话。** 按阶段查看工作流进度，点进每个 Agent 的对话和工具结果；后台工作流保留在输入框上方，随时能回去看。正文保留紧凑摘要，工作流内的 Agent 在流程详情查看，不再重复显示为正文卡片；连续已结束的 Agent 步骤会折叠。标题旁的按钮列出工作流和子 Agent。长会话先显示最近几轮；项目里的文件可以直接浏览和查看。
- **斜杠命令。** 输入 `/` 列出 Agent 的命令和你的 skills，可以搜索。`/compact`、`/review` 对 Codex 同样可用。
- **真终端。** 电脑上的终端，带 Ctrl、Esc、Tab 和方向键工具栏；关掉 App 也不会中断。
- **在手机上打开 localhost。** dev server 的端口走同一条加密通道，热更新照常，可以全屏。不用暴露端口，也不用同一个 Wi-Fi。
- **设置跟着会话走。** 模型、思考强度、权限模式、快速模式——Agent 提供什么就能改什么；电脑上正在跑的会话，手机上显示的是它真实的设置。
- **会话管理。** 重命名、归档、删除；Codex 和 Claude 的会话会同步到它们自己的记录里。项目和会话上显示当前的 git 分支。不再使用的电脑，在「我的电脑」里长按即可移除。
- **屏幕与文件。** 随时看电脑屏幕，可以全屏、横屏；需要时直接接手鼠标和键盘：触控板或点哪点哪两种方式，右键、滚动、拖拽都有；一页一点即发的 Mac 快捷操作（复制、粘贴、切换应用、调度中心、截图、F 键，也可以添加自己的）；长一点的内容用“发送文字”写好再发，还能带上手机剪贴板（macOS、Apple 芯片；权限由 `linkshell setup` 带你设置）。把手机里的图片和文件传到项目里。

## 支持的 Agent

LinkShell 用的是你电脑上已经安装、已经登录的 Agent，不经手它们的账号和 API key。

| Agent | 方式 | 体验 |
| --- | --- | --- |
| **Codex** | 多端同步 | `linkshell codex` 打开的终端和手机同时在线，任何一端都能发消息、打断、审批 |
| **Claude Code** | 接力 | 电脑上用 Claude 自己的界面；手机发消息即接管，电脑按任意键收回 |
| **Gemini CLI、GitHub Copilot、OpenCode、Cursor、Grok** | 远程会话 | 通过 [Agent Client Protocol](https://agentclientprotocol.com) 在手机上新建、继续会话：实时输出、审批、模式和模型 |
| **任何命令行工具** | 终端 | 在电脑上开终端，手机上看和输入 |

在 Claude 桌面 App 里打开的会话，手机上同样可以实时查看、接着做。但桌面 App 没法接收交回的会话：手机上做的内容要重启 App 后它才知道。想来回接力，用 `linkshell claude` 启动会话。

各 Agent 在手机上的支持情况：

| | Codex | Claude Code | Gemini、Copilot 等 |
| --- | --- | --- | --- |
| 运行中发消息 | 插进当前这一轮 | 插进当前这一轮 | 先停下当前这一轮再执行 |
| 分叉会话（整段或从某条回复） | 原生 | 原生 | 由 LinkShell 代做：把之前的对话以文字交给它 |
| 在 git worktree 里开会话 | 支持 | 支持 | 支持 |
| 斜杠命令 | `/compact`、`/review`、`/init` 和你的 skills | Claude 自己的命令和你的 skills | Agent 提供什么就有什么 |
| 向你提问（选项、自由输入） | 支持，计划模式内外都可以 | 支持 | Agent 通过 ACP 表单提问时支持 |
| 计划模式 | 手机上的一个开关 | 权限模式里的一项 | Agent 提供什么模式就有什么 |

## 自建网关

网关只转发加密数据并负责配对，占用资源很少。自建网关和官方网关是同一个程序，只是没有账号：不用登录，每台手机配对一次即可，扫码或输入 6 位配对码。任选一种：

```bash
# 在服务器上用 CLI
linkshell gateway --port 8787 --daemon

# 或者 Docker
docker run -d --name linkshell-gateway -p 8787:8787 \
  -v linkshell-gateway:/data nickname4th/linkshell-gateway
```

它保存的全部数据就是一个 SQLite 文件（公钥，以及哪台手机和哪台电脑配对）：用 CLI 时是 `~/.linkshell/relay.db`，容器里是 `/data/relay.db`，上面挂载的卷就是为它准备的。这个文件还在，手机就不用重新配对。

公网上请在前面加一层 HTTPS 反向代理（Caddy、Nginx），然后用 `wss://你的域名`。只在家里用的话，网关可以直接跑在这台电脑上：`linkshell host --gateway ws://局域网IP:8787`。更多见[部署指南](docs/deploy.md)。

## 安全

- **端到端加密。** 手机和电脑之间的数据全部加密，官方网关和自建网关都只能看到密文。手机和电脑之间的直连也是在这条加密通道上建立的，本身同样加密。
- **配对即授权。** 配对的手机能做你在这台电脑终端里能做的事。只配对你信任的设备，配对码不要外传。
- **Agent 用的是你的账号。** Agent 以你的用户身份运行，使用你登录 shell 的环境变量和它们自己的登录。Pro 订阅只包含网关服务。
- **数据在本地。** 会话和历史保存在电脑上的 `~/.linkshell`，重启后配对依然有效。

## 命令

| 做什么 | 命令 |
| --- | --- |
| 首次设置：host、屏幕权限、连接手机，一次做完 | `linkshell setup` |
| 后台启动 LinkShell | `linkshell host --daemon` |
| 查看 Agent、会话和网关 | `linkshell host status` |
| 停止 | `linkshell host stop` |
| 配对手机（自建网关） | `linkshell pair` |
| 查看、移除已配对的手机 | `linkshell devices` / `linkshell devices remove <名称>` |
| 使用官方网关（Pro） | `linkshell login` / `linkshell logout` |
| 可交给手机的 Claude Code / Codex | `linkshell claude` / `linkshell codex`（参数原样传递） |
| 运行网关 | `linkshell gateway [--port 8787] [--daemon]` |
| 设置看屏幕和控制屏幕 | `linkshell screen` |
| 检查环境 | `linkshell doctor` |
| 升级 | `linkshell upgrade` |

> **从 1.x 升级？** 2.0 的 App 和电脑端都换了，需要两边一起升级，再重新配对一次。`linkshell start` 和 1.x 的 App 已不再支持（CLI 0.10、网关 0.6 起移除）。

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
| `packages/gateway` | 网关（官方与自建）：转发加密帧、负责配对的中继 |
| `packages/cli` | `linkshell`：host、配对、Agent 启动器、网关、登录 |
| `packages/client-core` | App 共用的客户端状态与时间线 |
| `apps/client` | 手机 App：Expo / React Native，iOS 与 Android |
| `apps/mac` | LinkShell.app（`@linkshell/mac`）：Mac 这一侧的屏幕——采集、WebRTC 视频、输入、系统权限 |
| `docs/site` | 官网与安装脚本（修改后运行 `python3 scripts/build-site-pages.py`；`scripts/site-promo-assets.sh` 负责剪出其中的影片和片段） |

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
