# 屏幕实时化设计：用 WebRTC 媒体通道重做远程桌面

> 状态：已实现；回环、模拟器和 iPhone 15 Pro 真机（Wi-Fi）验证通过（2026-10-02）· 前置：cli 0.8.2 / host 0.3.2 / app 2.2.0 已发布的屏幕控制
> 结论：采集和编码搬进 LinkShell.app，用 libwebrtc 的视频轨道传画面，手机端用系统自带的 WebRTC 接收；只做直连，打不通时回退到现有管线。不部署 TURN（2026-10-01 定：不用自己的服务器中转画面）。

## 0. 为什么要重做

0.8.2 的屏幕是“可用”的，但它的上限由结构决定，不是调参能突破的：

| 环节 | 现状 | 上限在哪 |
|---|---|---|
| 采集 | ffmpeg 命令行（AVFoundation） | 用户要自己装 ffmpeg；最高 20 帧；指针烧在画面里，跟着视频一起延迟 |
| 编码控制 | 码率、分辨率写死在命令行参数里 | 换档要重启采集，画面停约 1 秒；关键帧只能定时（1 秒一个），不能按需 |
| 传输 | H.264 字节流走“可靠、有序”的通道（网关中继或 WebRTC 数据通道） | 一个包丢了，后面的全等它重传：延迟随丢包放大。0.8.2 的回执丢帧只是不让队列变长，治不了这个 |
| 拥塞控制 | 自己写的回执 + 五档阶梯 | 反应以秒计；专业实现以毫秒计，并且不需要停顿 |
| 解码显示 | WebView 里 WebCodecs → canvas | 没有抖动缓冲和丢包恢复，这些本该由传输层配合完成 |

要做到“跟手”，需要的是一整套实时媒体传输：基于 UDP、带带宽估计、丢包重传/前向纠错、按需关键帧、抖动缓冲。这套东西不该自己写。

## 1. 目标与非目标

**目标（都要实测，不靠估计；目前没有任何实测数字）**

1. 端到端延迟（电脑上画面变化 → 手机上看到）：同一局域网 ≤ 70 ms；4G/5G 直连 ≤ 150 ms。
2. 默认 30 帧，网络允许时 60 帧；文字清晰优先于帧率。
3. 丢包 2% 时不卡顿；带宽变化时无停顿地调码率和分辨率。
4. 指针单独传输，本地即时绘制，不跟视频延迟。
5. 不再依赖 ffmpeg；安装仍然是 `npm i -g linkshell-cli` 一条命令，设置仍然是 `linkshell screen`。
6. 保持端到端加密：网关只见密文。

**非目标（本期不做）**

- 多台设备同时观看（沿用“后来的接手”）。
- 声音、剪贴板同步、文件拖放（列为后续）。
- Linux / Windows 主机的新管线（继续用现有管线）。

## 2. 现成方案比较

| 方案 | 画面传输 | 许可证 | 能否拿来用 |
|---|---|---|---|
| Sunshine + Moonlight | 游戏串流协议，画质和延迟目前开源里最好 | GPL-3.0 | 不能集成：许可证与我们的 App 不兼容；外网访问要端口转发或 VPN，没有打洞和中继，手机在 5G 下基本连不上 |
| RustDesk | 自有协议，打洞 + 中继，硬件 H.264/H.265 | AGPL | 不能集成：它是完整产品，不是可嵌入的组件 |
| Parsec / Jump Desktop / Splashtop | 自研 | 商业闭源 | 不提供可嵌入的 SDK |
| macOS 自带屏幕共享 | 高性能模式仅限 Mac 对 Mac；对外是 VNC | 系统自带 | VNC 是最慢的一类，不考虑 |
| **WebRTC（libwebrtc）** | UDP + 拥塞控制 + 重传/纠错 + 按需关键帧 + 硬件编解码 | BSD | **选它**。Chrome 远程桌面和浏览器端云游戏都建在它上面；我们两端已经各有一份（手机 WebView / 浏览器自带，App 里还有 react-native-webrtc） |

选 WebRTC 不是因为它“参数最高”（Moonlight 在局域网里更强），而是它是唯一同时满足四条的：许可证允许集成、自带穿透和中继机制、手机端零新增依赖、拥塞控制和丢包恢复是工业级的。

## 3. 总体架构

```
Mac                                                              手机
┌ LinkShell.app（签名，持有录屏/辅助功能权限）┐
│ ScreenCaptureKit 采集（不带指针，30–60 帧） │
│        ↓                                    │
│ libwebrtc：硬件编码 H.264/HEVC，带宽估计    │═══ 视频轨道（SRTP/UDP）═══▶ <video>（硬件解码、抖动缓冲）
│ 数据通道 pointer（不可靠、无序）            │◀══ 指针移动 / 滚动 ═════════ 手势（现有页面）
│ 数据通道 keys（可靠、有序）                 │◀══ 点击 / 按键 / 文字 ══════
│ 数据通道 cursor                             │═══ 指针位置和形状 ══════════▶ 本地绘制指针
└──────────────┬──────────────────────────────┘
               │ 本机 socket：只传信令（SDP、ICE 候选）
            host ───── 现有端到端加密通道（网关中继）───── 页面的 WebSocket
```

- **媒体路径**：ICE 只试直连（局域网、STUN 打洞）；不通就回退到 0.8.2 的现有管线（它自己也是先试数据通道直连，再经网关中继，中继时码率封顶在 900 kbps 以内）。
- **信令路径**：不新增通道。页面已有的 WebSocket 经端到端加密通道到 host，host 再转给 LinkShell.app。DTLS 指纹随信令走，所以媒体仍是端到端加密。
- **网关的角色**不变：配对、在线状态、转发信令和消息。网关不需要任何改动；直连成功时画面不经过网关。

## 4. 各部分的改动

### 4.1 LinkShell.app（最大的一块）

从单文件 Swift 程序变成一个 Swift Package 工程：

- **采集**：ScreenCaptureKit（macOS 12.3+）。`showsCursor = false`；分辨率和帧率用 `updateConfiguration` 实时改，不重启。
- **编码与传输**：libwebrtc 的预编译框架（BSD；候选 LiveKitWebRTC，2026-08 仍在更新到 M144；备选 stasel/WebRTC）。视频源标记为屏幕内容，降级策略设为“保分辨率”。码率由 libwebrtc 的带宽估计实时驱动 VideoToolbox；关键帧由对端请求（PLI）触发。
- **低延迟**：发送端带 playout-delay 扩展头，要求接收端把播放缓冲压到最小（Chrome 远程桌面的实测是减少约 150 ms）。
- **输入**：现有的注入代码原样保留，入口从 host 的 socket 改为数据通道，少一跳。
- **指针**：采样系统指针的位置和图形，经数据通道发给页面。
- **体积与分发**：框架约 30–40 MB，不再适合塞进 host 包。改为一个只在 macOS 安装的可选依赖包（npm 的 `os` 字段，做法同 esbuild 的平台包），`npm i -g linkshell-cli` 仍然一步装完。需要做公证。

### 4.2 观看页（host 下发的页面）

- canvas + WebCodecs 换成 `<video>` + `RTCPeerConnection`（只收不发，WKWebView 和 Android WebView 都支持，不需要相机权限）。
- 手势、工具条、键盘条全部保留；事件改走数据通道，指针移动用不可靠通道（旧位置丢了无所谓）。
- 本地绘制指针。
- 连不上时自动回退到现有的 WebSocket 管线，并在顶栏标出当前走的是哪条路。

### 4.3 host

- 信令透传：页面 ↔ LinkShell.app。
- 把 STUN 配置交给两端（沿用现有直连通道的那一份）。
- 现有采集管线（ffmpeg + 回执丢帧）保留为回退路径，以及 Linux 主机的唯一路径。

### 4.4 网关与中继

不部署 TURN，网关不改。理由：中继画面的流量和成本都落在自己的服务器上，而打不通的情况已经有现有管线兜底。
如果以后实测直连成功率太低，再回头评估（需要一台有公网 IP、能开 UDP 端口的机器；Luma 目前没有 UDP 暴露方式）。

### 4.5 手机 App

第一阶段**不需要改 App**：页面里的 WebRTC 用的是系统 WebView 自带的实现。App 2.2.0 即可。

## 5. 待验证的假设（先做验证，再全面开工）

这份设计里有四处是我没有实测过的，任何一处不成立都会改变方案，所以第一步只做验证：

| # | 假设 | 不成立时的备选 |
|---|---|---|
| V1 | App 里的 WKWebView（页面来自 `http://127.0.0.1`）能接收原生 libwebrtc 发来的视频轨道，延迟达标。已知 Safari 不支持 `jitterBufferTarget`，要靠发送端的 playout-delay 扩展头 | 改用原生播放器：App 里已有 react-native-webrtc，用它的原生视图渲染；手势改为原生实现。代价是要发新版 App |
| V2 | 预编译的 libwebrtc 框架能在无窗口的后台 App 里跑通 ScreenCaptureKit → 硬件编码 → 发送，签名和公证正常 | 换另一个预编译发行版；最差自己编 libwebrtc |
| V3 | 手机在 4G/5G 下与家用宽带的直连成功率可接受 | 打不通的走现有管线；比例太高时再评估 TURN |
| V4 | 30–40 MB 的平台可选依赖在 npm、Homebrew、curl 三种安装方式下都能正确装上并保持签名 | 首次运行 `linkshell screen` 时下载并校验签名 |

验证用的画面带毫秒时间戳，用它量出真实的端到端延迟，作为后续每一步的回归基准。

## 6. 里程碑（每一步都要可实测）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 验证 | V1、V2 的最小原型 + 延迟测量工具 | 拿到局域网下的实测延迟数字；决定页面方案还是原生播放器 |
| M1 直连 | 4.1–4.3 完成，仅 STUN | 局域网和可打洞网络达到 §1 的目标；失败时回退到现有管线，不比现在差 |
| M2 打磨 | HEVC、60 帧选项、指针图形、断线重连、弱网表现调优 | 丢包 2%、带宽骤降场景的实测达标 |
| M3 可选 | 菜单栏桌面端（状态、权限引导、开机自启、DMG）；声音；剪贴板 | 按需求再定 |

## 7. 多 agent 分工

设计文档（本文件）是共享的上下文。M0 结论出来后：

- **A：媒体引擎**（LinkShell.app：采集、libwebrtc、数据通道、指针）
- **B：页面与信令**（观看页改造、host 透传、回退切换）
- **C：测量与验收**（延迟测量工具、弱网模拟、测试矩阵；独立于 A/B，负责说“达没达标”）

A、B 之间的接口只有两样：信令消息格式、数据通道上的事件格式，先由我定稿再并行。各自在独立的工作树里做，由我集成、真机验证和发版。

## 8. 风险

- **WKWebView 的延迟不可控**（V1）。这是最大的不确定项，所以放在最前面验证。
- **运营商网络直连率**未知（V3）。打不通的用户只能得到现有管线的体验。
- **包体积**从 0.4 MB 到几十 MB，安装时间和失败率会上升（V4）。
- **公证**需要你的 Apple 账号凭证（App 专用密码或 API Key），我拿不到，需要你配置一次。
- **回退路径长期存在**意味着两套管线都要维护，直到新管线覆盖率足够高。

## 9. 实施结果（2026-10-01）

### 做成了什么

| 部分 | 位置 | 说明 |
|---|---|---|
| LinkShell.app | `apps/mac`（Swift 包，发布为 `@linkshell/mac`） | ScreenCaptureKit 采集；libwebrtc（stasel/WebRTC M154 预编译框架，未改动的上游）发送视频轨道；四条数据通道（`input`、`pointer`、`cursor`、`shape`）；鼠标键盘注入和权限；显示器列表；给 socket 管线用的自有 VideoToolbox 编码（低延迟码控）。协议见 `apps/mac/README.md` |
| host | `packages/host/src/screen.ts`、`input.ts` | 页面的 WebSocket 上转发信令；直连不成时在同一条 socket 上改发 H.264 帧；从 `@linkshell/mac` 的压缩包解出 App |
| 观看页 | `packages/host/src/screen-viewer.ts` | `<video>` + 只收的 `RTCPeerConnection`；手势不变；指针本地绘制；放弃直连的条件：ICE 失败、8 秒没连上、连上后 4 秒没有画面、断开超过 4 秒 |
| 手机 App | `apps/client/src/screens/screen-screen.tsx` | WebView 允许内联播放，并告诉页面（`video: true`）；旧版 App 自动走 socket 管线 |

### 与设计稿不同的地方

- **Mac 上彻底不用 ffmpeg 了。** 回退管线也由 App 编码：换档不重启（`stream.set`），关键帧按需生成（`stream.key`）而不是每秒一个，静止画面几乎不发数据。ffmpeg 只剩 Linux 主机在用。
- **降级策略是“保帧率”**（`maintainFramerate`）：带宽不够时先缩分辨率，不卡顿。设计稿写的是保分辨率，与“流畅优先”的要求相反，已改。
- **零缓冲靠 field trial**（`WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/`）让发送端带 playout-delay 扩展头。Safari 没有接收端的旋钮，但认这个头：缓冲从约 68 ms 降到 0。
- **上游的一个坑**：libwebrtc 在 macOS 上把 H.264 级别钉在 3.1，1080p 会被 VideoToolbox 拒绝，然后悄悄退到软件 VP8（CPU 约 110%）。`Encoders.swift` 包了一层把级别提上去。
- **WebRTC 路径仍用 libwebrtc 自带的编码器。** 自写的低延迟编码器每帧快 3 ms、码率跟得更准，但 1080p30 下 95 分位延迟更差（除非同时改 pacer 的 field trial，而那只在回环上测过），所以留作开关（`--encoder own`），不是默认。
- **没做 HEVC**：这个框架没有 ObjC 的 H.265 编码类。
- **App 解到固定位置** `~/.linkshell/LinkShell.app`，升级时原地替换（见 V4）。
- **默认 60 帧，带不动自动降到 30**（`FrameRate.swift`）。在 60 帧下画面被 libwebrtc 缩小、或帧发不出去持续 3 秒，就降到 30 并把完整分辨率还回来；之后 10 秒内没有任何受限且带宽估计够用，再升回 60，升上去没撑住的话下次等待时间加倍（上限 160 秒）。切换不重启采集、不重新协商。丢包本身不是降帧的理由。
- **只支持 Apple 芯片**：LinkShell.app 只构建 arm64（`cpu: arm64`），Intel Mac 上屏幕功能不可用。
- **首次引导**：权限由 LinkShell.app 自己的窗口带着设置（`--setup`），`linkshell setup` 把“启动 host → 屏幕权限 → 连接手机”一次做完，首次 `linkshell host --daemon` 时自动进入。
- **有人在看时不让显示器休眠**，连上时唤醒已休眠的显示器。

### 实测数字（同一台 Mac 上回环，1080p；不代表真实网络）

| 发送 → 接收 | 模式 | 帧率 | 延迟 p50 | p95 | 接收缓冲 |
|---|---|---|---|---|---|
| App → 模拟器 Safari（iOS 26.5） | 视频 | 60 | 20 ms | 23 ms | 0 ms |
| App → 模拟器 Safari | 视频 | 30 | 24 ms | 26 ms | 0.7 ms |
| App → 模拟器里的 LinkShell App（WKWebView） | 视频 | 30 | 约 25 ms | 约 28 ms | 1–3 ms |
| App → 无头 Chrome 154 | 视频 | 60 | 20 ms | 29 ms | 0.3 ms |
| App → 模拟器 Safari | socket（兼容） | 20 | 42 ms | 65 ms | – |
| App → 无头 Chrome | socket（兼容） | 20 | 42 ms | 63 ms | – |

延迟的量法：App 用 `--clock` 在屏幕上画一条 16 位格雷码的毫秒时间码，页面逐帧读回（`?measure=1`；host 设 `LINKSHELL_SCREEN_CLOCK=1` 时自动开启并把结果写进日志）。

资源：1080p30 采集 + 编码约占一个核的 11–17%，60 帧约 16–25%；静止画面约 1%。App 体积 13.6 MB，压缩包 6.8 MB（只含 arm64）。

### 真机实测（iPhone 15 Pro，App 2.3.0 的 WKWebView，2026-10-02）

| 链路 | 时长 | 延迟 p50 | p95 | 接收缓冲 | 备注 |
|---|---|---|---|---|---|
| Wi-Fi（局域网主机直连） | 62 秒 | 29 ms | 50 ms | 0.1 ms | 两次链路瞬断（约 1.1 秒、0.5 秒），都在 1 秒内追回，无累积延迟 |
| 本地快速链路（往返 2 ms） | 64 秒 | 20 ms | 25 ms | 0 ms | 无卡顿 |

五次进入五次走上视频直连。当时是 30 帧；蜂窝网络下的公网打洞没有留下测量数据（测量开关已关）。

### 四个假设的结论

| # | 结论 |
|---|---|
| V1 | 成立：模拟器和 iPhone 15 Pro 真机上，App 内 WKWebView 都把接收缓冲压到了 0 |
| V2 | 成立：预编译框架、无窗口、Developer ID 签名、`open` 启动均正常。未公证 |
| V3 | 未验证：需要真机在 4G/5G 下测直连成功率 |
| V4 | 改了做法：npm 包带不了 framework 的符号链接，所以包里放压缩包，host 首次使用时解开并校验可运行 |

### 还没验证的

蜂窝网络下的直连成功率；真实丢包和带宽变化下的表现；较新的 Android WebView 和 Android 真机；macOS 13–15；公证。

不支持 Intel 芯片的 Mac（2026-10-02 定）：LinkShell.app 只构建 arm64。

macOS 15 起，直接录屏的程序会被系统定期询问（“…requesting to bypass the system private window picker…”）。远程桌面类程序可以向 Apple 申请 `com.apple.developer.persistent-content-capture` 权利来免除，尚未申请。

## 参考

- WebRTC playout-delay 扩展头：https://webrtc.googlesource.com/src/+/main/docs/native-code/rtp-hdrext/playout-delay/README.md
- WebKit 的 WebRTC 支持（任意 web view 可用 RTCPeerConnection，recvonly）：https://webkit.org/blog/7763/a-closer-look-into-webrtc
- `jitterBufferTarget`（Safari 不支持）：https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget
- libwebrtc 的 ScreenCaptureKit 采集器：https://webrtc.googlesource.com/src/+/refs/heads/lkgr/modules/desktop_capture/mac/screen_capturer_sck.mm
- 预编译框架：https://www.github.com/stasel/WebRTC
- Sunshine 许可证（GPL-3.0）：https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2legal.html
- RustDesk 的架构与编解码：https://rustdesk.com/de/blog/rustdesk-vs-vnc-nat-traversal-codecs-verschlusselung
