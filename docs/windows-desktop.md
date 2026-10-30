# LinkShell Windows 桌面版

Windows 桌面端复用现有 Host / Gateway / 手机协议，窗口与 macOS 是同一个 Electron 应用（`apps/desktop`）：工作台、本机管理和系统托盘。内置 Node、CLI、Host、工作台资源与屏幕组件；Agent 仍由用户自行安装并登录。

安装包沿用 macOS 的运行时精简规则：保留 Claude SDK 和 ACP 适配器，排除不会使用的内置 Claude 程序，继续调用用户已安装的 Claude。打包同时清理 ARM64 终端文件、调试符号、类型声明、source map 和 node-pty 构建源码，并覆盖复用暂存目录的情况；x64 终端运行库、可执行 JS、许可证与可替换的 FFmpeg DLL 保留。包内 smoke 验证外部 Agent 调用与真实 ConPTY 进程。

## 桌面体验

默认打开“工作台”。窗口是 Electron 44，重命名为 `LinkShell.exe`，加载随安装包附带的同一套 Web UI；本机管理是窗口里的页面，与 Mac 相同。Ctrl+1 / Ctrl+2 切换，控制远程屏幕时按键交给远程电脑。标题栏由页面绘制，右上角是系统的最小化、最大化和关闭按钮。支持深色、浅色与跟随系统，不修改 Windows 的系统外观。

- 工作台支持本机和其他电脑的对话、继续会话、审批、问题回答、项目、终端、文件、Worktree 和多标签端口预览。本机通过命名管道连接，无需账号、Pro 或网关；远程电脑沿用账号和配对流程。
- 管理页切换保留工作台实例和草稿。退出或重连前等待草稿与设置写入 `desktop-client.json`，保存失败时可返回重试，或明确选择丢弃。退出只结束界面所属的工作台进程，保留后台 Host。
- Windows 工作台通过 Chromium WebRTC 视频接收和 GPU 合成显示远程屏幕，输入沿用独立 DataChannel；兼容画面仍可通过中继接收。离开屏幕、进入管理、隐藏或最小化会销毁屏幕连接并释放输入，返回重新连接。此接收路径没有实现 macOS 的 VideoToolbox / Metal 原生接收器，也不保证硬件解码、120 fps 或弱网性能。
- 工作台仅向可信主页面开放原生管理、外观和外部链接接口；屏幕 iframe 保持不透明隔离，端口预览保持独立 origin，不向它们开放原生桥、账号或客户端存储。下载经 Windows 保存对话框确认。

- 本机管理包含总览、设备、访问密码、用量统计、日志、更新和设置，与 Mac 相同。设置页可开关登录时启动和远程屏幕，并可复制内置 `linkshell.cmd` 的路径。
- 总览与设备页可生成二维码、六位配对码和有效期。新设备出现后提示配对成功，过期后需要重新生成。
- 会话与审批统一在工作台完成；管理总览和托盘保留会话概况和工作台入口。账号页支持会员刷新与 Pro 激活码兑换，激活码仅经 stdin 传给 CLI。
- 用量统计提供全部 / Agent 筛选、今天 / 7 天 / 30 天、Token 等指标、每日趋势和模型明细。无数据不显示为“零消耗”。
- 日志页读取 Host 最近 64 KB，可选择复制。更新页自动检查 GitHub 上的 Windows 安装包（测试版通道包含预发布），按版本号选择最新版本；点击“下载并更新 App”后在应用内显示下载进度并验证随 Release 发布的 SHA-256。下载完成后确认重启，自动完成安装并重新打开。下载失败可重试，选择稍后安装会保留本次已校验的安装包。
- 关闭窗口后 LinkShell 留在任务栏通知区域：单击图标打开窗口，右键菜单可打开本机管理或退出界面。再次启动同一安装会唤回已有窗口。

## 系统与安装

- Windows 10 1809 或更新版本、Windows 11，x64；屏幕组件和安装器需要 .NET Framework 4.8。窗口自带 Chromium，不需要 WebView2 Runtime。ARM64 尚未提供原生安装包。
- 在 Windows 上运行 `pnpm --filter @linkshell/windows build:standalone`，生成 `artifacts/LinkShell-Setup-<版本>-windows-x64.exe` 与 ZIP 便携包。
- 手动安装默认安装到当前用户的 `%LOCALAPPDATA%\Programs\LinkShell`；应用内更新沿用当前安装目录，也支持 ZIP 解压的自定义目录。创建开始菜单入口，不需要管理员权限。当前 Windows 发布包不进行 Authenticode 签名，可能显示“未知发布者”或 SmartScreen 提示；请从官方 Release 下载并核对随包提供的 SHA-256。
- 安装器提供独立窗口，显示安装位置、解压百分比、已处理容量 / 文件数、服务恢复与开始菜单阶段。解压按实际读取的字节推进；替换文件与恢复服务期间禁止关闭，完成后可直接启动应用。解压时取消会清理暂存文件，失败会显示原因并允许重试。应用与安装器统一使用圆角矩形图标。
- ZIP 解压后运行 `LinkShell.exe`。`linkshell.cmd` 为同一运行环境的 CLI 入口；不会修改系统 PATH。
- 数据保存在 `%USERPROFILE%\.linkshell`，或 `LINKSHELL_HOME` 指定的位置。安装、更新和关闭界面不删除账号、配对与会话历史。

首次打开自动启动已停止的 Host，已有服务不会被自动接管。关闭窗口后保留托盘；“退出界面”保留 Host。“停止服务 / 重启服务”需要在界面确认，可能中断任务、终端与屏幕连接。登录使用系统浏览器和现有本机回调流程；“取消登录”只结束本次等待。

官方网关需要 Pro 账号，手机登录同一账号即可发现电脑。设备页可生成六位配对码和配对链接，过期后重新生成。自建网关使用内置 CLI：`linkshell.cmd host --gateway wss://your-gateway.example --daemon`。

开机启动默认为关闭；设置开启的是当前用户登录项，不是登录前运行的 Windows 服务。

## 屏幕与控制

Windows 屏幕组件在已登录、已解锁的交互桌面中运行，按远程请求启动，支持多显示器与 DPI 缩放。手机和 Web 工作区继续使用现有屏幕查看页、配对权限及端到端加密通道。

优先走 DXGI Desktop Duplication → GPU 缩放 → 硬件 H.264 → WebRTC 视频直连，复用 Mac 的 SDP/ICE 协商与 iOS 原生、WebView、Web 接收端。安装包自带校验固定版本的 FFmpeg LGPL 共享运行库，按显示适配器选择 AMD AMF、NVIDIA NVENC 或 Intel QSV，之后尝试硬件 Media Foundation。驱动拒绝 GPU 转换时，可使用 CPU 缩放与颜色转换，仍由硬件编码。初始能力上限为 1920×1080、60 fps；实际帧率取决于显卡、显示器、接收端与网络。尚未提供 Mac 的 120 fps、HEVC、FlexFEC 和原生光标形状同步。接收端丢包反馈触发重传和关键帧恢复，带宽不足时降档；当前切换视频档位会重启编码器。

视频旁的四条 DataChannel 与 Mac 使用相同协议：按键和鼠标按下/松开可靠有序，移动走独立的无序低延迟通道，并丢弃过期位置；光标位置也可直接回传。网关继续传输加密协商消息，不转发视频。没有 TURN，无法穿透的网络自动回退到兼容画面。`LINKSHELL_SCREEN_VIDEO=off` 可强制兼容；`LINKSHELL_WINDOWS_ENCODER` 可指定 `h264_amf`、`h264_nvenc`、`h264_qsv`、`h264_mf` 用于诊断。

编码器不可用、旋转屏幕或不支持的显示适配器使用 JPEG 兼容路径：DXGI GPU 缩放后读回像素，必要时改用 GDI。动态采集目标最高 30 fps，宽度最高 3840，按网络降档。iOS 可回退到 WebView 和强制中继。视频和 JPEG 路径都保留桌面解锁与本地禁用检查，隐藏查看器会暂停采集；原生组件通过 Windows Job Object 保证编码子进程随自身结束。

JPEG 兼容路径的正常发送窗口最多保留两帧待确认，查看器绘制后立即确认，避免拖动时排队播放旧画面；确认丢失时仅发送稀疏探测帧。画质、分辨率和帧率直接在采集进程内调整。完全相同的像素不重复编码，静止后补发更清晰的一帧，并复用缓存画面发送低频心跳。连接详情显示当前实际模式、接收帧率和带宽。

控制使用 `SendInput`，支持左右键、拖动、滚轮、常用快捷键、功能键和 Unicode 文本；工具栏显示 Windows 的 Ctrl / Alt / Win 组合。断开连接后释放已按下的按钮与修饰键。组件只通过 Host 持有的标准输入/输出工作，不另开监听端口；Host 退出或管道关闭会结束采集。

设置可关闭远程屏幕，拒绝后续采集与输入。锁屏、UAC 安全桌面及高权限窗口不可控制；不会提升权限或绕过 Windows 的输入隔离。显示器布局变化时需要重新连接。

## 更新与卸载

新安装包一起更新桌面界面、Node、CLI、Host 与屏幕组件。应用内更新先完成下载和校验，再确认重启并保存草稿。安装器取得互斥锁并显示窗口后才通知桌面退出，等待桌面及其渲染进程释放安装目录，不强制结束窗口。下载和等待确认期间 Host 保持运行；安装器仅在替换文件前停止自身托管的 Host，保存并恢复原有机器身份与配对。失败尝试回滚，保留旧目录作为恢复副本；失败或取消可在安装窗口重试或重新打开应用。自定义 `LINKSHELL_HOME` 传给更新服务、重新打开的应用与开始菜单入口；数据目录位于应用目录内时拒绝覆盖更新。

新版服务恢复成功后，删除这次和以前留下的 `LinkShell.previous-*` / `LinkShell.failed-*` 副本；被占用而删不掉的文件留到下次安装再删。数据目录保护通过 Windows 目录句柄解析实际位置，覆盖 junction / 符号链接及其祖先；交接和替换文件前复验，无法确认路径时停止更新。应用重开后清理下载缓存，仍运行的下载或安装器保留。外部 npm 安装的服务不会被自动替换。手动下载并运行安装器仍然可用，手动更新前需从托盘退出界面。Windows 更新不依赖 Mac 的 Sparkle，也不会在后台未经确认重启服务。

卸载时先在桌面端停止服务，关闭开机启动，再从托盘退出。删除安装目录及开始菜单 LinkShell 快捷方式即可；用户数据目录默认保留。

## 开发与验证

打包时的 smoke（`scripts/smoke.mjs`，`build:standalone` 自动运行）在隔离数据目录启动真实 Host 和打包目录中的 `LinkShell.exe`，经调试端口确认工作台以 Windows 布局加载、页面与主进程的桥能往返，并检查 exe 的名称与版本信息。它不涵盖生产登录、真实激活码或公网性能。

2026-10-30 Windows 自动更新验证：[CI run 41077122254](https://github.com/LiuTianjie/LinkShell/actions/runs/41077122254)（`28ed7146c070a57d21adbef740fade7d8a5a4809`）的更新 E2E 步骤通过，5 个场景与测试清理均成功。在包含中文和空格的独立安装、数据与界面目录中，更新器拒绝损坏下载且未启动安装器；真实安装器完成故意恢复失败后的回滚与原生按钮重开，以及重试后自动打开新 App。Host PID 从基线 `8204` 经回滚后的 `1412` 变为新版 `6992`；新版 App PID 为 `5596`。App / Host 均报告隔离测试版本 `65530.0.2`，两轮准备阶段确实写入恢复标记并停止旧 Host，恢复后清除标记。生成的机器身份与配对 fixture、模拟会话和消息、SQLite 完整性均保持，旧版与失败副本已删除。原生确认框、回滚重开窗口和新版 App 截图已复核。这里记录自动更新步骤的结果，同轮模型选择与原生菜单步骤另行验收。

本轮报告为 `status = passed`、`cleanup.temporaryFilesRemoved = true`、`cleanup.errors = []`。测试清理通过 Unicode Shell Link 接口回读快捷方式，仍须核验同属物理路径，并在删除前再次读取且精确匹配；这套受归属检查约束的清理已无错误完成。上一轮 [run 41074267437](https://github.com/LiuTianjie/LinkShell/actions/runs/41074267437) 已通过 5 个更新场景和真实快捷方式创建、覆盖、Unicode 回读预检，但旧 WScript 清理回读把中文路径变成问号而触发 `ENOENT`；此后更新路径仅修正该测试清理，没有再改生产更新器。完整过程及验证边界见 [Windows update E2E](../apps/windows/test/WINDOWS_UPDATE_E2E.md)。

官方发布下载链另外在 macOS 上验证过：生产更新模块成功检测 `desktop-v0.10.80`，下载 278,922,752 字节的 Windows 安装包，并核对 Release SHA-256 后再次验证本地文件；约 23 秒，临时安装包与缓存已清理。这项下载验证与上述 Windows 安装和恢复证据分别记录。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm --filter @linkshell/host exec vitest run test/windows.test.ts test/windows-viewer.test.ts test/dev-port.e2e.test.ts test/screen-viewer.test.ts test/screen-pacer.test.ts test/screen-fallback.test.ts
corepack pnpm --filter @linkshell/windows test
corepack pnpm --filter @linkshell/desktop test
corepack pnpm --filter @linkshell/windows build:standalone
```

使用仓库锁定的 pnpm 10。中文目录下运行 Windows cmd 包装脚本时，必要时先执行 `chcp 65001`。屏幕组件和安装器使用 Windows 自带 .NET Framework C# 编译器构建；窗口的图标和版本信息用固定校验的 electron/rcedit 2.0.0 写入。`node apps/windows/scripts/build.mjs --qa` 另生成 `LinkShell.InputQA.exe`，用于通过真实屏幕查看器验证点击、文本、快捷键和滚轮，不包含在安装包中。

已有便携 ZIP 时，`node apps/windows/scripts/installer-qa.mjs` 生成 `LinkShell.SetupQA.exe`，自动将真实安装文件解压到 `build/install-qa-*`，用于检查安装进度和完成界面；它不修改已安装应用、开始菜单或用户 Host。安装事务测试覆盖字节进度、取消、覆盖更新、旧版副本清理、失败回滚、临时文件占用、目录保护、无效 ZIP 路径与快捷方式失败。更新行为回归覆盖发布版本及通道选择、下载校验、损坏/中断清理、活动下载保留，以及 Windows 安装器参数、进程交接、junction 与取消不终止进程。

Windows CI 在安装依赖前运行真实 `shortcut-home` 预检：后台线程通过 Unicode Shell Link 接口，为中文目录中的真实 EXE 在 Programs 专属临时目录创建并覆盖同一快捷方式，再独立回读目标、工作目录与保留原拼写的 Home 参数。`test:update-e2e` 则在打包后验证应用内下载→原生确认→退出→替换→Host 恢复→重开、失败回滚重试，以及便携安装和自定义数据目录。复制包、生成身份与模拟历史的 CI 结果不等同于生产账号、真实 Agent 长任务或公网验收。

命名管道替代 Host 的 Unix socket；不同 `LINKSHELL_HOME` 相互隔离。Codex 的 Windows 进程使用官方 app-server JSONL 标准输入/输出传输；npm 的 `.cmd` Agent 入口通过参数转义启动。终端使用 PowerShell 和随 node-pty 分发的 ConPTY。Mac 原有 socket 与媒体路径保留。

Codex 优先使用 PATH 中的命令行程序；没有全局命令时，自动发现 `%LOCALAPPDATA%\OpenAI\Codex\bin` 下桌面版自带的 `codex.exe`。只安装 Codex 桌面版也能发现和读取原有对话，不必再安装全局 CLI。显式配置的命令优先，`CODEX_HOME` 仍用于选择原有会话目录。2026-10-19 在不含 Codex 的 PATH 下验证了真实桌面版发现、24 条会话列表与 3 条会话的历史读取。

本地桌面管理与 Host 集成测试不等同于真实 Agent 和手机的完整验收。Windows 尚未提供 Codex 桌面 App 的 IPC 共享；原有 `linkshell codex` TUI 同步接管路径依赖 Unix socket，Windows 使用手机或 Web 创建的 Host 会话。

自动测试包括命名管道 RPC、SQLite、重复主机拒绝、关闭请求 PID 校验、PowerShell/ConPTY、Codex JSONL 的通知与请求、JPEG 分帧边界、输入干跑与本地屏幕禁用。真实屏幕采集测试在锁定或不可访问的输入桌面上会明确跳过；这不代表屏幕验证通过。

2026-10-19 本机验收：在 3456×2168、200% 缩放的已解锁桌面，通过真实 Host 和浏览器屏幕查看器核对了 JPEG 画面、左键、右键菜单、拖选、中文 / 英文输入、Ctrl+A 替换和向下滚动。实测修复了 Windows 滚轮方向与桌面控件 DPI 缩放。原生测试 4 项通过，无跳过；Host 相关测试 110 项通过；CLI 测试 28 项通过，2 项 POSIX 专用测试跳过。完整构建和类型检查通过，仓库外解压的便携包通过命名管道、SQLite、ConPTY 和运行时依赖 smoke。已安装的 Codex / Claude 及 Claude ACP 完成隔离初始化，未创建真实任务。

验收仍应覆盖：150% 缩放、多显示器负坐标、拔插显示器、手机经网关配对与重连、生产账号登录，以及真实 Agent 的长任务和权限批准。隔离 Windows 更新场景不替代真实用户环境、手机真机或性能发布验收。Unix socket / POSIX 信号专用的旧测试不能视为 Windows 验收。

2026-10-19 屏幕优化验收：在同一台主机、1280 像素输出的全屏滚动文字测试中，连续 10 秒的输出从旧版约 2.3 fps 提升到约 7.3 fps，帧间隔中位数从 412 ms 降到 137 ms；这是真实本机采集结果，不是稳定 30 fps 或手机端到端延迟的承诺。静态画面在 8 秒内只发送 5 帧（包含初始、清晰度补帧及心跳）。原生测试覆盖有效图像、不中断进程切换大小/质量、暂停恢复、强制补帧、禁用屏幕与输入释放，DXGI 与强制 GDI 两条路径均通过。`LINKSHELL_SCREEN_DIAGNOSTICS=1` 可输出各阶段平均耗时；`LINKSHELL_SCREEN_CAPTURE=gdi` 用于兼容路径排查。

2026-10-19 视频直连接入验收：本机 Vega 8 的 AMF 硬件 H.264 输出可被 FFmpeg 和真实 Edge 查看器解码，驱动拒绝 GPU 转换时使用 CPU 转换。实际 WebRTC 接收检查得到 167 个完整帧、975 个 RTP 包和 6 个关键帧，短时接收采样约 33.3 fps；四条 DataChannel、输入干跑、隐藏/恢复及主动失败后的 JPEG 回退均通过。Edge 的 25 秒检查确认持续接收和显示 H.264，记录实际帧率、解码时间与缓冲；存在启动/关键帧抖动，不能据此宣称稳定 60 fps 或手机端到端低延迟。Host 屏幕相关测试 138 项通过，1 项依赖 Mac 实机的测试跳过；Windows 原生屏幕测试 8 项通过、无跳过，其中覆盖关闭共享及强制结束组件后不会遗留编码进程。全量构建和类型检查通过。手机真机、其他显卡和公网弱网仍待验收。

```powershell
node apps/windows/scripts/media-runtime.mjs
node apps/windows/scripts/video-check.mjs
node apps/windows/scripts/video-browser-check.mjs
```
