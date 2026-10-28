# 桌面版改用 Electron（分支 feat/desktop-electron）

依据见 [Codex / Claude 逆向参考](codex-reference.md)。两家都是 Chromium 运行时（Electron / OWL）+ React 19 + Tailwind 4 + Radix + Motion。我们的工作台本来就是 React 19 + Tailwind 4 + Radix（`apps/web`），换的是运行时：Mac 的 WKWebView、Windows 的 WebView2 都换成 Electron 44（与 Claude 桌面版同版本）。

## 一个 App、一个身份

屏幕录制与辅助功能的授权绑在 `com.bd.linkshell.host` + Developer ID 上，所以 Electron 不另起 App，而是装进同一个 LinkShell.app：

```
LinkShell.app/Contents/
  Info.plist                  CFBundleExecutable = LinkShell，id com.bd.linkshell.host（不变）
  MacOS/LinkShell             Swift：--status、--connect、<screen>、--setup，照旧
  MacOS/LinkShell Desktop     Electron 主程序
  Frameworks/                 Electron Framework、LinkShell Helper (GPU/Plugin/Renderer).app、
                              LinkShellNative.node、WebRTC、Sparkle
  Resources/app/              apps/desktop 编译后的 main / preload
  Resources/Workspace/        apps/web 构建产物
```

- 已安装的 Host 直接运行 `Contents/MacOS/LinkShell`（`--status`、每块屏幕的输入、`open -a … --connect`），这条路径不能变，所以 Swift 程序仍是主可执行文件。
- 用户打开 App（Finder、Dock、`--dashboard`）时，Swift 程序 `execv` 成 `LinkShell Desktop`：同一个进程、同一个 bundle、同一个签名。实测 LaunchServices 认作 `com.bd.linkshell.host`，窗口进程里读到的权限是「录屏 ✓ / 辅助功能 ✓」，不需要重新授权。
- `apps/desktop/scripts/package.mjs` 把 Electron 放进 `apps/mac` 构建好的 App 里并整体签名。

## 远程桌面画面：用 Chromium 的 WebRTC

原计划把现有的原生接收（libwebrtc → VideoToolbox → Metal 覆盖层）编成 Electron 原生模块。实测不可行：Electron 自带的 Chromium 里有一份 libwebrtc，与 WebRTC.framework 有同名 Objective-C 类（`RTCVideoCodecInfo`、`RTCVideoFrame` 等 8 个）；运行时每个类名只留一个，进程里的 WebRTC.framework 拿到 Chromium 的类后在 `ScreenEncoderFactory.supportedCodecs()` 崩溃（"Expected RTCVideoCodecInfo but found RTCVideoCodecInfo"）。

所以窗口用 Chromium 自己的 WebRTC 接收，走 Windows 已在用的同一个查看器。Electron 44 的 Chromium 支持 H.265 接收，`mediaCapabilities` 报告 4K/120 的 H.265 与 H.264 都是 `powerEfficient`（VideoToolbox 硬解）。实测（同一台 M3 Max，本机回环）：

| 显示器 | 编码 | 分辨率 | 接收帧率 | 每帧解码 | 丢帧 / 卡顿 |
| --- | --- | --- | --- | --- | --- |
| 外接 60 Hz | H.265 | 1920×1080 | 60 | 1.5 ms | 0 / 0 |
| 外接 60 Hz | H.265 | 2560×1440 | 60 | 1.8 ms | 0 / 0 |
| 内建 ProMotion，画面持续运动 | H.265 | 2560×1662 | 60–85 | 2.0 ms | 0 / 0 |

没证实的：稳定 120 fps（测试画面本身由另一个窗口的 requestAnimationFrame 产生，到不了 120）、公网和弱网表现、Intel Mac。

原生模块 `LinkShellNative.node`（`apps/mac/Sources/LinkShellNative`）因此只管权限状态、登录项和 Sparkle，不链接 WebRTC。

## 已做

1. `apps/desktop`：主进程（窗口、菜单、菜单栏、单实例、设置、保存屏障、下载、权限、导航安全策略）、preload 桥（与 WKWebView / WebView2 同样的 `{action}` 消息）、现有 `desktop-workspace` 侧车不变。
2. 原生模块与打包签名；Swift 入口在打开 App 时交给 Electron。
3. 本机管理从 SwiftUI 移进网页（`apps/web/src/live/Management*.tsx`）。
4. 流式回复：照 Codex 的自适应缓冲放字（`smooth-text.ts`），Markdown 按块解析，只重解析最后一块，新块淡入。
5. 桌面配色换成 Codex 的令牌（`theme.ts` 的 `nativeDesktopColors`）。
6. 布局与组件质感（规则见 `apps/web/DESIGN.md` 的桌面版一节）：半透明侧栏、46px 工具栏、实心主面板、30px 侧栏行、浮动输入框、新建会话页、统一 diff（按文件分组的变更面板）、检查器标签页、侧栏收起与边缘唤出、Shiki 代码高亮（Codex 的 codex-light / codex-dark 配色）。

## 待做

- ~~Windows：同一个 Electron 壳替换 WebView2 工作台~~：0.10.75 起 `LinkShell.exe` 就是这个 Electron（`apps/windows/scripts/electron.mjs` 组装，图标和版本信息由固定校验的 electron/rcedit 写入），屏幕 helper 与安装器保留；WPF / WebView2 窗口已删除。打包 smoke 在 Windows CI 上启动它并经调试端口检查工作台和桥，另存三张桌面截图（artifact `LinkShell-Windows-window-shots`）。
- ~~发布：双架构 DMG、公证、Sparkle 源~~：`build-standalone.mjs` 每个架构都调用 `package.mjs` 装进 Electron（x64 的 Electron 由 `electron-dist.mjs` 下载校验），随后公证、生成 Sparkle 源，与原有流程相同。旧版（WKWebView）经 Sparkle 升级到 Electron 版：同一 bundle id 和签名，数据在 `~/.linkshell`，权限沿用。
