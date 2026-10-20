# LinkShell Windows 桌面版

Windows 桌面端复用现有 Host / Gateway / 手机协议，提供原生窗口、系统托盘、账号登录、服务管理、会话列表、设备配对和用量统计。内置 Node、CLI、Host 与屏幕组件；Agent 仍由用户自行安装并登录。

## 桌面体验

界面使用原生 WPF，按 Mac 桌面版的 `DesktopView` / `DesktopStyle` 对齐：210 点侧栏、深色默认外观、浅色与跟随系统、薄荷绿强调色，以及相同的账号 → 手机配对 → 连接状态 → 最近会话 → 活动顺序。主题保存在数据目录的 `desktop-preferences.json`，不修改 Windows 的系统外观。

- 侧栏包含总览、会话、设备、用量统计、日志、更新和设置。启动、停止、重启与刷新位于右上角“服务操作”；停止和重启前会说明影响。
- 总览与设备页可生成二维码、六位配对码和有效期。新设备出现后提示配对成功，过期后需要重新生成。
- 会话页显示 Agent 品牌图标、运行状态和待确认请求，点击进入详情。实际审批仍在手机或 Agent 终端进行。
- 用量统计提供全部 / Agent 筛选、今天 / 7 天 / 30 天、Token 等指标、每日趋势和模型明细。无数据不显示为“零消耗”。
- 日志页读取 Host 最近 64 KB，可选择复制。更新页检查 GitHub 上的 Windows 稳定版安装包，下载与安装由用户操作；未接入 Mac 的 Sparkle 自动更新。
- 点击系统托盘图标显示服务、网关、在线设备与会话概况，并提供常用页面入口。再次启动同一安装会唤回已有窗口。

## 系统与安装

- Windows 10 1809 或更新版本、Windows 11，x64；需要 .NET Framework 4.8。ARM64 尚未提供原生安装包。
- 在 Windows 上运行 `pnpm --filter @linkshell/windows build:standalone`，生成 `artifacts/LinkShell-Setup-<版本>-windows-x64.exe` 与 ZIP 便携包。此实现尚未发布到下载站。
- 安装器仅安装到当前用户的 `%LOCALAPPDATA%\Programs\LinkShell`，创建开始菜单入口，不需要管理员权限。当前 Windows 发布包不进行 Authenticode 签名，可能显示“未知发布者”或 SmartScreen 提示；请从官方 Release 下载并核对随包提供的 SHA-256。
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

新安装包一起更新桌面界面、Node、CLI、Host 与屏幕组件。更新前从托盘退出界面。安装器仅停止自身托管的 Host，保存并恢复原有机器身份与配对；失败尝试回滚，保留旧目录作为恢复副本。外部 npm 安装的服务不会被自动替换。Windows 首版提供手动下载更新，暂未接入自动更新。

卸载时先在桌面端停止服务，关闭开机启动，再从托盘退出。删除安装目录及开始菜单 LinkShell 快捷方式即可；用户数据目录默认保留。

## 开发与验证

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm --filter @linkshell/host exec vitest run test/windows.test.ts test/windows-viewer.test.ts test/dev-port.e2e.test.ts test/screen-viewer.test.ts test/screen-pacer.test.ts test/screen-fallback.test.ts
corepack pnpm --filter @linkshell/windows test
corepack pnpm --filter @linkshell/windows build:standalone
```

使用仓库锁定的 pnpm 10。中文目录下运行 Windows cmd 包装脚本时，必要时先执行 `chcp 65001`。原生部分使用 Windows 自带 .NET Framework C# 编译器构建。`node apps/windows/scripts/build.mjs --qa` 生成只用于开发的 `LinkShell.QA.exe`，将数据与 Agent 日志目录隔离到 `apps/windows/build/qa-*`；另生成 `LinkShell.InputQA.exe`，用于通过真实屏幕查看器验证点击、文本、快捷键和滚轮，不包含在安装包中。

同一命令还生成 `LinkShell.Preview.exe`，使用明确标注的示例数据检查深浅色、二维码、会话详情、用量图表和托盘面板。它不启动 Host，示例二维码不可用于配对；预览程序与示例数据不会进入生产 EXE 或安装包。Agent 图标从手机端同一份品牌资源生成，使用与 Mac 一致的深浅色处理。

已有便携 ZIP 时，`node apps/windows/scripts/installer-qa.mjs` 生成 `LinkShell.SetupQA.exe`，自动将真实安装文件解压到 `build/install-qa-*`，用于检查安装进度和完成界面；它不修改已安装应用、开始菜单或用户 Host。安装事务测试覆盖字节进度、取消、覆盖更新、失败回滚、临时文件占用、目录保护、无效 ZIP 路径与快捷方式失败。

命名管道替代 Host 的 Unix socket；不同 `LINKSHELL_HOME` 相互隔离。Codex 的 Windows 进程使用官方 app-server JSONL 标准输入/输出传输；npm 的 `.cmd` Agent 入口通过参数转义启动。终端使用 PowerShell 和随 node-pty 分发的 ConPTY。Mac 原有 socket 与媒体路径保留。

Codex 优先使用 PATH 中的命令行程序；没有全局命令时，自动发现 `%LOCALAPPDATA%\OpenAI\Codex\bin` 下桌面版自带的 `codex.exe`。只安装 Codex 桌面版也能发现和读取原有对话，不必再安装全局 CLI。显式配置的命令优先，`CODEX_HOME` 仍用于选择原有会话目录。2026-10-19 在不含 Codex 的 PATH 下验证了真实桌面版发现、24 条会话列表与 3 条会话的历史读取。

本地桌面管理与 Host 集成测试不等同于真实 Agent 和手机的完整验收。Windows 尚未提供 Codex 桌面 App 的 IPC 共享；原有 `linkshell codex` TUI 同步接管路径依赖 Unix socket，Windows 使用手机或 Web 创建的 Host 会话。

自动测试包括命名管道 RPC、SQLite、重复主机拒绝、关闭请求 PID 校验、PowerShell/ConPTY、Codex JSONL 的通知与请求、JPEG 分帧边界、输入干跑与本地屏幕禁用。真实屏幕采集测试在锁定或不可访问的输入桌面上会明确跳过；这不代表屏幕验证通过。

2026-10-19 本机验收：在 3456×2168、200% 缩放的已解锁桌面，通过真实 Host 和浏览器屏幕查看器核对了 JPEG 画面、左键、右键菜单、拖选、中文 / 英文输入、Ctrl+A 替换和向下滚动。实测修复了 Windows 滚轮方向与桌面控件 DPI 缩放。原生测试 4 项通过，无跳过；Host 相关测试 110 项通过；CLI 测试 28 项通过，2 项 POSIX 专用测试跳过。完整构建和类型检查通过，仓库外解压的便携包通过命名管道、SQLite、ConPTY 和运行时依赖 smoke。已安装的 Codex / Claude 及 Claude ACP 完成隔离初始化，未创建真实任务。

验收仍应覆盖：150% 缩放、多显示器负坐标、拔插显示器、手机经网关配对与重连、生产账号登录、安装器覆盖更新恢复，以及真实 Agent 的长任务和权限批准。当前结果不代表手机真机、安装器升级流程或性能发布验收已完成。Unix socket / POSIX 信号专用的旧测试不能视为 Windows 验收。

2026-10-19 屏幕优化验收：在同一台主机、1280 像素输出的全屏滚动文字测试中，连续 10 秒的输出从旧版约 2.3 fps 提升到约 7.3 fps，帧间隔中位数从 412 ms 降到 137 ms；这是真实本机采集结果，不是稳定 30 fps 或手机端到端延迟的承诺。静态画面在 8 秒内只发送 5 帧（包含初始、清晰度补帧及心跳）。原生测试覆盖有效图像、不中断进程切换大小/质量、暂停恢复、强制补帧、禁用屏幕与输入释放，DXGI 与强制 GDI 两条路径均通过。`LINKSHELL_SCREEN_DIAGNOSTICS=1` 可输出各阶段平均耗时；`LINKSHELL_SCREEN_CAPTURE=gdi` 用于兼容路径排查。

2026-10-19 视频直连接入验收：本机 Vega 8 的 AMF 硬件 H.264 输出可被 FFmpeg 和真实 Edge 查看器解码，驱动拒绝 GPU 转换时使用 CPU 转换。实际 WebRTC 接收检查得到 167 个完整帧、975 个 RTP 包和 6 个关键帧，短时接收采样约 33.3 fps；四条 DataChannel、输入干跑、隐藏/恢复及主动失败后的 JPEG 回退均通过。Edge 的 25 秒检查确认持续接收和显示 H.264，记录实际帧率、解码时间与缓冲；存在启动/关键帧抖动，不能据此宣称稳定 60 fps 或手机端到端低延迟。Host 屏幕相关测试 138 项通过，1 项依赖 Mac 实机的测试跳过；Windows 原生屏幕测试 8 项通过、无跳过，其中覆盖关闭共享及强制结束组件后不会遗留编码进程。全量构建和类型检查通过。手机真机、其他显卡和公网弱网仍待验收。

```powershell
node apps/windows/scripts/media-runtime.mjs
node apps/windows/scripts/video-check.mjs
node apps/windows/scripts/video-browser-check.mjs
```
