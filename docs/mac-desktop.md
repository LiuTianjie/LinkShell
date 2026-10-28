# LinkShell 独立 Mac App

独立桌面版同时提供工作台与本机管理：工作台用于控制本机或其他电脑、继续对话、处理审批、使用终端和远程桌面；本机管理负责 Host、权限、日志、用量及更新。它与手机 App 共用已有 Host / Gateway 协议。

## 桌面工作台

窗口是装在同一个 `LinkShell.app` 里的 Electron 44：打开 App 时 Swift 入口 `execv` 成 `LinkShell Desktop`，bundle id、签名和已授予的录屏 / 辅助功能权限都不变；Host 调用的 `Contents/MacOS/LinkShell`（屏幕、输入、权限检查）照旧。布局与视觉照 Codex 桌面版：半透明侧栏、46px 工具栏、实心主面板、浮动输入框，配色用 Codex 的令牌。设计规则见 `apps/web/DESIGN.md` 的桌面版一节，方案见[桌面版改用 Electron](design/desktop-electron-plan.md)。

- **侧栏：** 按项目分组的会话；子会话（Claude 桌面 App 启动的会话、分叉）缩进在父会话下，可折叠，已归档的不显示。会话和项目行有右键菜单（重命名、分叉、复制、在 Finder 中显示、归档、删除；在此项目中新建、复制路径、全部归档）。
- **这台 Mac / 其他电脑：** 连接本机运行中的 Host 不需要账号、Pro 或网关；其他电脑通过账号或配对码添加。
- **新建会话：** 选 Agent、模型、项目和分支。模型是 Agent 报给这台电脑的真实列表；ACP Agent（Gemini、Grok、Copilot、Antigravity 等）在这台电脑上用过一次后才有列表，之前显示「默认模型」。
- **对话：** 各 Agent 统一按 Claude 桌面 App 的方式呈现：只给模型看的标签（`<system-reminder>`、IDE 状态等）不显示；其他会话发来的消息显示为「收到的消息来自「会话」」并可打开；子代理的回传、`!` 命令、CI 与定时任务事件各有自己的样式；Codex Desktop 附带的文件、粘贴内容和浏览器状态显示为气泡上方的标签。计划卡在本轮末尾逐步更新。
- **检查器：** 变更、文件（可收起、可拖宽的文件列表）、终端、任务、端口预览；Codex 会话还有插件（MCP Apps），调用插件时自动打开。
- **远程桌面：** 由 Chromium 自带的 WebRTC 接收，优先 H.265 再 H.264，VideoToolbox 硬件解码；鼠标键盘经 DataChannel 发送。Electron 内置的 libwebrtc 与 `WebRTC.framework` 有同名类，不能在窗口进程里再加载原生接收，取舍和实测数据见上面的方案文档。
- **本机管理：** 总览、设备、访问密码、用量统计、日志、更新、设置。「网关」一行的「更改…」可在官方网关、自建网关（填 `wss://` 地址）和关闭之间切换。

界面资源随 App 一起构建和签名。`desktop-client.json` 保存独立的客户端身份、配对、草稿与偏好，使用 `0600` 权限；不会把 Host 的机器身份用于客户端。退出 App 结束本次工作台服务，不停止本机 Host。

## 下载与首次使用

- [Apple Silicon（M 系列）](https://github.com/LiuTianjie/LinkShell/releases/download/desktop-v0.10.69/LinkShell-0.10.69-arm64.dmg)
- [Intel](https://github.com/LiuTianjie/LinkShell/releases/download/desktop-v0.10.69/LinkShell-0.10.69-x64.dmg)

需要 macOS 13 及以上。把 DMG 中的 `LinkShell.app` 拖入 Applications，再从 Applications 打开；不要长期从只读 DMG 内运行。已内置 Node、CLI、Host，无需预装 npm 或 Homebrew。

1. 在总览或设置点击“登录 / 注册”，在系统浏览器完成 iTool 登录。完成后 App 自动更新账号状态。
2. 使用官方网关需要 Pro。手机登录同一账号后即可发现这台电脑。账号登录状态与网关连接状态分别显示；登录成功不代表网关一定在线。网关关闭或连接失败时可在「网关」一行点「更改…」，选官方网关并查看错误原因。
3. 在设置打开权限引导，授权“屏幕录制”和“辅助功能”，供手机查看、控制 Mac。不要更改 App 的 bundle id 或签名身份。
4. Codex、Claude 等 Agent 仍需要你在电脑上自行安装并登录；LinkShell 不打包这些 Agent 的账户凭据。随后可从手机创建会话。

“取消登录”会结束本轮登录等待。“退出登录”退出本机的 LinkShell 账号并刷新网关连接，本机会话和配对记录保留。自建网关在「网关」的「更改…」里填地址即可，手机扫码或输入配对码连接，不需要账号；部署见[部署说明](deploy.md)。

已登录的普通账户可在总览或设置中输入激活码兑换 Pro，下方提供链动小铺链接。已有 Pro 显示有效期；会员读取失败时可手动刷新。兑换成功后会重新连接网关，网关暂未连接不会被显示成兑换失败。会员查询与兑换复用内置 CLI 的账户令牌，激活码通过标准输入传递，不保存在命令行参数或会员缓存中。此入口需要配套的新版内置 CLI 和 iTool 兑换接口，详见[Pro 兑换](v2/pro-redemption.md)。

## App 与 CLI 的关系

App 内的 CLI、Host 和 Node 是配套版本。设置里的“安装到 ~/.local/bin”是可选项：它创建指向 App 的命令入口，供终端使用 `linkshell`。需要把 `~/.local/bin` 加入 shell 的 PATH；已有同名入口不会被静默覆盖。

以前通过 npm / Homebrew 安装的 CLI 是另一套安装。App 不覆盖它；如果当前 Host 由另一套安装启动，总览会说明来源，只有你确认切换后才停止原 Host、使用 App 内置版本重启。切换可能中断正在执行的任务与终端。

关闭窗口后 App 留在菜单栏。退出界面不会停止 Host；要停止后台服务，请使用服务菜单。自建网关服务器不随桌面 App 更新或重启。

设置中的“登录 Mac 时自动启动”控制系统登录项，首次安装不会自动开启。开启后，在登录 macOS 时打开桌面版（不是登录前的系统服务）；若系统要求批准，设置中会提供登录项设置入口。

独立桌面版每次启动时先恢复未完成的更新，再自动启动已停止的 Host，并按已有配置连接网关。已有运行中或暂时无法连接的 Host 不会被自动替换；启动失败会显示错误。手动停止服务后，状态轮询不会再次启动它，下次重新启动桌面版才会自动启动。屏幕采集仍按远程查看请求启动，权限仍需事先授予。

## 外观与用量统计

设置中的“外观”提供跟随系统、浅色和深色，默认保持原有深色。选择立即作用于窗口、设置和菜单栏弹出面板，并在下次打开时保留。

桌面侧栏和手机“电脑”页均提供“用量统计”。支持今天、近 7 天、近 30 天及全部已注册 Agent 筛选（含自定义 ACP Agent），使用现有品牌 Logo，展示 Token、用量记录、会话数、缓存读取占比、每日趋势和模型明细。两端从当前连接的 Host 读取同一份统计，按电脑时区划分日期。

Host 按需读取 `CODEX_HOME` 下的 `sessions` / `archived_sessions` 和 `CLAUDE_CONFIG_DIR` 下的 `projects`，未设置时使用 `~/.codex`、`~/.claude`。包括本地终端及子代理产生的用量，不限于 LinkShell 创建的会话；最多每分钟重新扫描一次，未变化的文件复用内存缓存。Codex 累计计数转为增量，Claude 重复回复按消息去重；原始对话和日志路径不会传到统计页面。缺失日志无法补算，超出 256 MB 的单文件或读取失败会提示统计不完整。

统计来自工具日志，不等同于订阅剩余额度或实际账单，暂不计算费用，也不涵盖其他 ACP 代理。旧 Host 不支持该接口时客户端会提示更新。实现参考 [CC Switch 的本地日志统计思路](https://github.com/farion1231/cc-switch/tree/main/src-tauri/src/services)，未引入其代理接管或凭据管理。

## 更新

“更新”页检查独立 App 的版本，提供稳定版 / 测试版通道。自动检查只查版本，不会静默安装。测试版通道可接收标记为 beta 的发布，也会接收稳定版；切换通道不会强制降级。

点击安装并确认后，App 保存恢复信息、暂停由自身托管的 Host，交由 Sparkle 验证签名并替换 App。新版打开后恢复 Host，并核对版本、机器身份及配对设备。取消或失败会尝试恢复；失败时保留恢复记录和错误，可在设置重试。更新期间正在执行的 Agent 轮次、终端或远程连接可能中断，请先完成重要操作。

**只改 CLI 或 Host 也会发布新版独立 App。** 用户一次更新即可，不需要分别运行 npm。由 App 安装的 `linkshell upgrade` 会打开 App 更新器；外部 npm/Homebrew 安装继续走自己的升级流程。

## 数据和权限

数据默认位于 `~/.linkshell`，不在 App bundle 内，包括账号、机器身份、配对、会话数据库及日志；`LINKSHELL_HOME` 可指定隔离目录。更新或替换 App 不删除这些数据。屏幕权限仍属于 `com.bd.linkshell.host` 与原 Developer ID 签名身份。

要做全新安装测试，先停止 Host、退出界面，并备份后移走旧数据目录；仅删除 App 不会清空账号与历史。不要同时删除 Agent 自己的 `~/.codex`、`~/.claude` 数据。

## 验证边界

本轮工作台验证（2026-10-20）：Web 100 项与 Swift 150 项测试通过；包括实际 H.264 / HEVC 硬件解码属性检查、IOSurface 到 Metal 纹理绑定和原生 WebRTC 回环。实际 App 已显示本机桌面，状态确认为 H.264 硬件解码 / Metal，验证了窗口内铺满与控制授权状态。双架构开发包通过签名和解包校验。首次 Host 延迟发现与退出中止账号请求有隔离进程回归覆盖。测试不代表生产 OAuth、真实 Agent、Intel 真机、公网远程桌面或长时间性能已经验收。

既有独立桌面版的验证还覆盖双架构签名包、精简运行时的 SQLite / PTY / 图片处理检查、隔离旧版经 Sparkle 更新并恢复 Host、真实浏览器登录回调和官方网关在线。Intel 二进制可在 Rosetta 运行，不等于 Intel 真机屏幕采集或性能验收。屏幕媒体行为与已知限制见[屏幕架构说明](v2/screen-realtime.md)。

开发打包与公证命令见 [Mac 开发说明](../apps/mac/README.md#standalone-desktop-distribution)，发布顺序见[发版 SOP](release-sop.md#独立-macos-app桌面界面--内置-cli--host)。品牌资源规范见[图标交付规格](design/brand/图标交付规格.md)。


桌面总览和“设备”页均可生成配对二维码与六位配对码，显示有效期，并在新设备配对后提示成功。账号登录与配对入口相互独立；官方网关要求 Pro 账号，自建网关支持免账号配对。生成配对码前必须已有运行中的 Host 和在线网关。

其他 Agent 通过 LinkShell 接收到的 ACP 用量事件参与统计；Copilot 使用会话累计差值，Antigravity transcript 使用原始 step 时间。没有可靠数据的 Agent 保留在筛选中并显示“暂无可用数据”，不表示零消耗。接入前的独立 Agent 历史不会统一补算。详见[用量统计口径](v2/session-recovery.md#agent-用量统计)。
