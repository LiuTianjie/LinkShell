# LinkShell 独立 Mac App

独立桌面版用于登录账号、管理本机 Host、查看会话和配对设备、打开屏幕权限设置，以及更新整个运行环境。它与手机 App 共用已有 Host / Gateway 协议。

## 下载与首次使用

- [Apple Silicon（M 系列）](https://github.com/LiuTianjie/LinkShell/releases/download/desktop-v0.10.43/LinkShell-0.10.43-arm64.dmg)
- [Intel](https://github.com/LiuTianjie/LinkShell/releases/download/desktop-v0.10.43/LinkShell-0.10.43-x64.dmg)

需要 macOS 13 及以上。把 DMG 中的 `LinkShell.app` 拖入 Applications，再从 Applications 打开；不要长期从只读 DMG 内运行。已内置 Node、CLI、Host，无需预装 npm 或 Homebrew。

1. 在总览或设置点击“登录 / 注册”，在系统浏览器完成 iTool 登录。完成后 App 自动更新账号状态。
2. 使用官方网关需要 Pro。手机登录同一账号后即可发现这台电脑。账号登录状态与网关连接状态分别显示；登录成功不代表网关一定在线。网关关闭或连接失败时可点击“连接官方网关…”并查看错误原因。
3. 在设置打开权限引导，授权“屏幕录制”和“辅助功能”，供手机查看、控制 Mac。不要更改 App 的 bundle id 或签名身份。
4. Codex、Claude 等 Agent 仍需要你在电脑上自行安装并登录；LinkShell 不打包这些 Agent 的账户凭据。随后可从手机创建会话。

“取消登录”会结束本轮登录等待。“退出登录”退出本机的 LinkShell 账号并刷新网关连接，本机会话和配对记录保留。自建网关仍通过已有 CLI 配置与配对流程使用，详见[部署说明](deploy.md)。

## App 与 CLI 的关系

App 内的 CLI、Host 和 Node 是配套版本。设置里的“安装到 ~/.local/bin”是可选项：它创建指向 App 的命令入口，供终端使用 `linkshell`。需要把 `~/.local/bin` 加入 shell 的 PATH；已有同名入口不会被静默覆盖。

以前通过 npm / Homebrew 安装的 CLI 是另一套安装。App 不覆盖它；如果当前 Host 由另一套安装启动，总览会说明来源，只有你确认切换后才停止原 Host、使用 App 内置版本重启。切换可能中断正在执行的任务与终端。

关闭窗口后 App 留在菜单栏。退出界面不会停止 Host；要停止后台服务，请使用服务菜单。自建网关服务器不随桌面 App 更新或重启。

## 更新

“更新”页检查独立 App 的版本，提供稳定版 / 测试版通道。自动检查只查版本，不会静默安装。测试版通道可接收标记为 beta 的发布，也会接收稳定版；切换通道不会强制降级。

点击安装并确认后，App 保存恢复信息、暂停由自身托管的 Host，交由 Sparkle 验证签名并替换 App。新版打开后恢复 Host，并核对版本、机器身份及配对设备。取消或失败会尝试恢复；失败时保留恢复记录和错误，可在设置重试。更新期间正在执行的 Agent 轮次、终端或远程连接可能中断，请先完成重要操作。

**只改 CLI 或 Host 也会发布新版独立 App。** 用户一次更新即可，不需要分别运行 npm。由 App 安装的 `linkshell upgrade` 会打开 App 更新器；外部 npm/Homebrew 安装继续走自己的升级流程。

## 数据和权限

数据默认位于 `~/.linkshell`，不在 App bundle 内，包括账号、机器身份、配对、会话数据库及日志；`LINKSHELL_HOME` 可指定隔离目录。更新或替换 App 不删除这些数据。屏幕权限仍属于 `com.bd.linkshell.host` 与原 Developer ID 签名身份。

要做全新安装测试，先停止 Host、退出界面，并备份后移走旧数据目录；仅删除 App 不会清空账号与历史。不要同时删除 Agent 自己的 `~/.codex`、`~/.claude` 数据。

## 验证边界

已覆盖双架构签名包、精简运行时的 SQLite / PTY / 图片处理检查、隔离旧版经 Sparkle 更新并恢复 Host、真实浏览器登录回调和官方网关在线。Intel 二进制可在 Rosetta 运行，不等于 Intel 真机屏幕采集或性能验收。屏幕媒体行为与已知限制见[屏幕架构说明](v2/screen-realtime.md)。

开发打包与公证命令见 [Mac 开发说明](../apps/mac/README.md#standalone-desktop-distribution)，发布顺序见[发版 SOP](release-sop.md#独立-macos-app桌面界面--内置-cli--host)。品牌资源规范见[图标交付规格](design/brand/图标交付规格.md)。
