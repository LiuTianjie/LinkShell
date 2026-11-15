# 融合模式：架构与协议（v2）

> 2026-11-15 设计并开始实现，分支 `fusion-arch-v2`。本文是融合模式的唯一规格：消息以 `packages/wire/src/fusion.ts` 的 schema 和 `packages/wire/test/fixtures/fusion/` 的样例为准，Swift 与 TypeScript 两端都对同一组样例做测试。协议与 0.10.10x 的融合两端**不兼容**，两台电脑都要升级。

## 1. 目标

一台电脑（**本地端**）把另一台电脑（**远端**）上的应用窗口显示成自己的窗口：每个远端应用在本地的 Dock / 任务栏、⌘Tab / Alt-Tab 里是一个独立应用。

现在只有 Mac → Mac。v2 要做到：

| 本地端 \ 远端 | macOS | Windows |
| --- | --- | --- |
| macOS（LinkShell.app hub + 每应用 Stub） | 已有 | 计划 |
| Windows（Electron 窗口） | 计划 | 不做 |

因此协议不能再携带只有 macOS 才有的概念作为必填项；平台差异通过握手里的 `platform` 和 `features` 表达。

## 2. v1 的问题（2026-11-15 盘点）

协议层：

- 约 50 种消息只存在于 Swift 的 `[String: Any]` 里，没有规格和版本协商；`apps` 发两次只为兼容 0.10.102。
- 标识是 macOS 的：`bundle`、`pid`、AX 菜单路径、红绿灯 `buttons`。
- `sig` 信封不对称：远端发 `{rtc:{t:"offer"}}`，本地发 `{t:"rtc.answer"}`。
- 死代码：`dragzone`（`evaluateDragZone` 无调用者，Stub 也不处理）、`onWindowHover`、`refreshFusionFilter`、`displays[].visible` / `id`、`layout[].pid` / `z`、`wclose.bundle`、`style.bundle`、`close` 别名。
- 剪贴板上限 8 MB 按原始字节算，base64 后超过接收端 8 MiB 帧上限，对端直接断开（`protocol`）。

媒体层：

- 每个窗口（以及每块虚拟屏幕的弹出层）是一整套 `ScreenSession`：独立的 `RTCPeerConnectionFactory`（一组线程）、PeerConnection、`SCStream`、编码器、4 条 DataChannel、socketpair 和读线程。窗口多了，ICE/DTLS 握手、TURN 分配、拥塞控制都是 N 份，并互相抢带宽。
- 窗口身份只靠「是哪条 PeerConnection」隐含；输入消息里没有窗口 id。
- 融合把 `ScreenSession` 塞满了 `fusion*` 分支，普通屏幕共享和融合互相牵制。
- 每关一个窗口泄漏一个 fd（socketpair 的 `pair[0]` 从不关闭），读线程可能也不退出。

生命周期：

- 连接一断，本地 hub 就向所有 Stub 发 `app.exited` 并退出：任何网络抖动都会让本地窗口全部消失，靠 UI 重新拉起。
- 远端会话结束时不把窗口放回原位（只记了 `moved` 集合，没有原始位置和大小）。
- 远端 Mac 上没有任何提示和「结束融合」入口。
- 两个停止入口行为不同：融合页「断开」调用远端 `fusion.stop`，⌘K「结束融合模式」不调用。
- 隧道模式的字节中转在渲染进程里，页面重载后 hub 5 秒看门狗超时退出，新页面不会自动接上。

平台：

- host 的 `FusionShare` 写死 `open -n -g -a` 和 unix socket；桌面主进程 `startFusionMode`、`queryFusionSocket` 写死 `MAC`；UI 的能力判断是硬编码的平台矩阵。

## 3. 组件

```
本地端                                              远端
┌──────────────────────────┐                ┌────────────────────────────┐
│ 桌面窗口（Electron）       │  fusion.start  │ host（Node）                │
│  fusion-store（渲染进程）  │──── RPC ──────▶│  FusionShare                │
│  main: fusion/ 模块        │◀── 端口+token ─│   └ 平台启动器 (mac / win)  │
│   ├ FusionHubDriver        │                │        │ 0600 socket / 管道  │
│   │  mac: LinkShell        │                │        ▼                    │
│   │       --fusion-local   │   控制连接      │ FusionRemote（每台一个进程）│
│   │  win: Electron 内置    │◀══ TLS-PSK ═══▶│   FusionRemoteSession       │
│   └ 隧道（直连失败时）      │  （直连或隧道） │    ├ 虚拟屏幕 / 窗口追踪     │
│ hub                       │                │    ├ 放置 / 窗口外观 / 菜单  │
│  ├ Stub（每个远端应用）     │   一条 PC       │    └ FusionMedia           │
│  └ FusionMediaReceiver    │◀══ WebRTC ═════│       N 个视频发送 + 4 条通道 │
└──────────────────────────┘                └────────────────────────────┘
```

- **host** 只做三件事：检查远端权限、启动远端进程、经端到端隧道发一次性 token。它不解析融合协议。
- **控制连接** 承载 §4 的全部消息。直连（局域网 / Tailscale）优先，否则经 host 的 `proxy.*` 流隧道。
- **媒体** 是一条 PeerConnection，每个窗口一个视频发送端（§5）。

## 4. 控制协议 v2

### 4.1 传输

不变：TCP + TLS 1.2 PSK（`TLS_PSK_WITH_AES_128_GCM_SHA256`，identity `linkshell-fusion-v1`，key = HMAC-SHA256(token, `linkshell-fusion-psk-v1`)），帧 = `[u32 BE 长度][JSON 对象]`。Node 的 `tls`（`pskCallback`）与 Network.framework 都支持这一套，Windows 端直接复用。

- 帧上限从 8 MiB 提高到 **16 MiB**；剪贴板原始数据仍限 8 MB，base64 后不会超帧。
- 所有矩形是 `{x, y, w, h}`（数字）。坐标空间写在字段说明里：**本地全局点**（本地主屏左上角为原点，向下为正）、**窗口内点**（窗口左上角为原点）。
- 应用标识 `app` 是不透明字符串：macOS 上是 bundle id，Windows 上是 AppUserModelID。接收方不得解析它。
- 窗口标识 `id` 是非负整数：macOS 上是 CGWindowID，Windows 上是 HWND 的低 32 位。

### 4.2 握手

```
本地                                   远端
 ── TLS 握手（PSK）───────────────────▶
 ── hello {proto, token, platform, features, displays, resume?} ─▶
 ◀─ welcome {proto, platform, features, session, resumed} ──────
 ◀─ apps {apps}                                     （<150 ms）
 ◀─ ready {displays}                       （虚拟屏幕建好之后）
 ◀─ rtc {config} / rtc {offer} …                 （§5）
 ◀─ wopen … / layout …
```

- `proto` 是整数，本版为 `2`。远端收到的 `hello` 没有 `proto` 或不等于 2 时，回 `bye {reason:"proto"}` 并关闭。本地在收到 `welcome` 之前收到任何其他消息（旧版远端会先发 `apps`），按「远端版本过旧」处理。
- host 的 `fusion.start` 结果也带 `proto` 和 `platform`，桌面端在拉起 hub 之前就能拒绝版本不匹配的远端。
- `features` 是字符串数组，表示发送方**能提供**的功能，见 §4.6。
- `resume`：本地断线重连时带上次 `welcome.session`。远端在宽限期内（30 秒）保留上次会话的虚拟屏幕和窗口状态，匹配就接回（`resumed: true`），并重发全部 `wopen`；否则开新会话。
- token 一次性：每次 `fusion.start` 发新的，`hello` 用掉即作废。

### 4.3 生命周期

- 心跳：本地每 1.5 秒 `ping {ts}`，远端回 `pong {ts}`。本地 5 秒、远端 8 秒没收到任何帧即判定断开。
- 主动结束：任一方发 `bye {reason, message?}` 后关闭连接。`reason`：`user`（用户结束）、`stopped`（host 停止）、`replaced`（另一台本地端连入）、`proto`、`token`、`error`。
- 远端收到 `bye` 或宽限期过后才真正结束会话：把每个被挪动过的窗口放回会话开始时记下的位置和大小，删除虚拟屏幕，恢复 Dock。
- 非主动断开（无 `bye`）：远端进入 30 秒宽限期；本地 hub 不退出、不关 Stub，窗口显示「正在重连」，由桌面端重新 `fusion.start` 后以 `resume` 接回。
- 远端在会话期间显示菜单栏状态项（「融合中：<本地电脑>」），提供「结束融合」，等同 `bye {reason:"user"}`。

### 4.4 消息

方向：L = 本地 → 远端，R = 远端 → 本地。

| `t` | 方向 | 字段 |
| --- | --- | --- |
| `hello` | L | `proto`、`token`、`platform`、`features`、`displays[]`（§4.5）、`resume?` |
| `welcome` | R | `proto`、`platform`、`features`、`session`、`resumed` |
| `bye` | 双向 | `reason`、`message?` |
| `ping` / `pong` | L / R | `ts` |
| `displays` | L | `displays[]`：本地显示器变化（0.8 秒防抖） |
| `apps` | R | `apps[]`：`{app, name, category, system}`，`system` 为布尔 |
| `ready` | R | `displays[]`：`{index, frame}`，`frame` 为该显示器在本地全局点下对应的区域（含远端菜单栏条带） |
| `launch` | L | `app` |
| `quit` | L | `app`、`force` |
| `app.exited` | R | `app` |
| `app.hidden` | R | `app`、`on` |
| `icon` | L 请求 / R 回复 | 请求：`app`；回复：`app`、`png`（base64，1024 px） |
| `wopen` | R | `id`、`app`、`title`、`activate`、`frame`（本地全局点）、`chrome`（§4.7）、`stream` |
| `wclose` | R | `id` |
| `wstyle` | R | `id`、`title?`、`chrome` |
| `layout` | R | `windows[]`：`{id, app, own, layer, title, frame, ack?, parent?, offset?}`，前到后排序；`own=false` 为弹出窗口，`offset` 为相对父窗口的偏移 |
| `place` | L | `id`、`seq`、`frame`（本地全局点）、`resize` |
| `wclose.req` | L | `id` |
| `focus` | L | `id` |
| `prewarm` | L | `id`（0 = 不确定哪个窗口） |
| `app.active` | L | `on`：本地没有任何融合应用在前台时为 `false` |
| `fullscreen` / `minimize` | R | `id`、`on` / `id` |
| `menu.fetch` / `menu` / `menu.press` | L / R / L | `app`、`path[]`；`menu` 回 `items[]` 或 `error` |
| `dockmenu` / `dockmenu.press` | R / L | `app`、`items[]` / `app`、`path[]` |
| `clip` | 双向 | `text?`、`rtf?`（base64）、`png?`（base64） |
| `alert` | R | `kind`、`subject?`、`message` 或 `clear: true` |
| `rtc` | 双向 | `m`：§5.2 |

`menu*` 与 `dockmenu*` 只在对方声明了对应 feature 时发送。

### 4.5 显示器描述（`hello.displays[]` / `displays.displays[]`）

`{frame, visible, scale, hz}`：`frame` 为该显示器在本地全局点下的区域；`visible` 为可用区域（去掉菜单栏、Dock、任务栏）；`scale` 为像素/点，可为小数（Windows 的 1.25、1.5）；`hz` 为最高刷新率。远端按这些建同样布局的虚拟屏幕；`visible` 用于把窗口限制在本地可用区域内。

### 4.6 features

| feature | 含义 |
| --- | --- |
| `menubar` | 远端能提供应用菜单（`menu.fetch`）；Windows 远端没有，菜单在窗口里 |
| `dockmenu` | 远端能提供 Dock 菜单项 |
| `clipboard` | 剪贴板同步 |
| `virtual-displays` | 远端用虚拟屏幕复刻本地布局 |
| `keys` | 远端接受物理键码（输入通道的 `keydown/keyup`） |

### 4.7 窗口外观 `chrome`

```
{ style: "mac" | "windows" | "none",
  toolbar: boolean,          // 有工具栏（mac：圆角更大）
  radius?: number,           // 圆角，点
  buttons?: { close?, minimize?, zoom? },   // 窗口内点矩形
  hitrects?: [rect, …] }     // 标题栏区域内可点的控件，窗口内点
```

`style: "mac"` 时本地端用 `buttons` 截获红绿灯；`"windows"` 时窗口自绘标题栏，`buttons` 是最小化/最大化/关闭按钮。

## 5. 媒体

### 5.1 一条 PeerConnection

每个融合会话一条 PeerConnection，远端是发起方（offer）。

- **视频**：每个「流」一个 send-only 视频 transceiver。流是一个窗口（`w<id>`）或一块虚拟屏幕的弹出层（`d<index>`）。窗口关闭时 transceiver 置为 inactive 并回收给下一个窗口，避免 SDP 无限增长。
- **数据通道**：整条连接只有 4 条，标签与普通屏幕共享相同：`input`（可靠有序）、`pointer`（无序、不重传）、`cursor`（无序）、`shape`（可靠）。每条输入、光标、形状消息都带 `k`（流键）。
- **映射**：`wopen.stream` 和 `rtc {t:"streams"}` 给出 `{k, mid}`，本地按 transceiver 的 `mid` 把解码帧交给对应窗口。
- **重协商**：流增减时远端重新 offer（合并 50 ms 内的变化）。本地只回 answer，从不主动 offer。
- **码率**：所有流共享一个带宽估计；每个发送端按焦点设置 `maxBitrateBps`、`maxFramerate` 和 `networkPriority`（聚焦窗口 60/120 fps 高优先级，其他 30 fps，弹出层空闲时 2 fps）。
- **裁剪元数据**：不变，仍放在 H.264 SEI 里随帧传（窗口位置、裁剪、`ack`）。

### 5.2 `rtc` 消息

`{t:"rtc", m:{…}}`，`m.t`：

| `m.t` | 方向 | 字段 |
| --- | --- | --- |
| `config` | R | `iceServers[]` |
| `offer` / `answer` | R / L | `sdp` |
| `ice` | 双向 | `candidate`、`sdpMid`、`sdpMLineIndex` |
| `streams` | R | `streams[]`：`{k, mid}`，每次 offer 之前发 |
| `control` | L 请求 / R 回复 | 回复：`available`、`trusted` |
| `state` | R | `connection`：仅用于日志 |

### 5.3 与普通屏幕共享的关系

融合不再使用 `ScreenSession`。远端用 `FusionMedia`（一条 PC，每个流一个 `ScreenCapturer` + 视频源），本地用 `FusionMediaReceiver`；`ScreenSession` 与 `DesktopScreenReceiver` 去掉所有融合分支，只服务普通屏幕共享。两者共用的是 `ScreenCapturer`、`Engine`、编码器、`Control` 和 `InputEvent`。

## 6. 代码结构

远端（`apps/mac/Sources/LinkShell/Fusion/Remote/`）：

| 文件 | 职责 |
| --- | --- |
| `FusionRemote.swift` | 进程入口、与 host 的 socket、token、监听器 |
| `FusionRemoteSession.swift` | 协议分发、握手、宽限期与 resume、会话结束 |
| `FusionDisplays.swift` | 虚拟屏幕的创建、重建与释放 |
| `FusionWindowTracker.swift` | 窗口追踪（`track`）、弹出窗口、屏幕外窗口救回、窗口原始位置记录与还原 |
| `FusionPlacement.swift` | `place` 队列、seq / ack、采样器 |
| `FusionAccessibility.swift` | 窗口外观、菜单栏与 Dock 菜单镜像 |
| `FusionApps.swift` | 应用目录、图标、启动、退出 |
| `FusionMedia.swift` | 一条 PC、视频发送端、输入通道 |
| `FusionStatusItem.swift` | 远端菜单栏状态项 |

本地（`apps/mac/Sources/LinkShell/Fusion/Local/`）：

| 文件 | 职责 |
| --- | --- |
| `FusionLocal.swift` | 进程入口、控制连接、断线保持与 resume |
| `FusionHubSocket.swift` | 本机 socket：Stub 注册、桌面端控制请求 |
| `FusionStubBundles.swift` | Stub `.app` 生成、图标合成、清理 |
| `FusionFrames.swift` | 解码帧裁剪、交给 Stub、弹出窗口 |
| `FusionMediaReceiver.swift` | 一条 PC、按 mid 分流、输入发送 |

共享：`FusionWire.swift`（传输）、`FusionProtocol.swift`（消息常量、版本、矩形与外观的编解码）、`FusionMetadata.swift`（SEI）。

桌面主进程：`apps/desktop/src/main/fusion/`，`FusionHubDriver` 接口；`mac-hub.ts` 实现现在的 `--fusion-local` 进程，Windows 实现留待 Windows 本地端。

host：`FusionShare` 依赖 `FusionLauncher` 接口；`launchers/mac.ts` 为现在的实现，Windows 启动器留待 Windows 远端。

## 7. 实施顺序

1. 协议规格、schema 与样例（本文 + `packages/wire`）。
2. Swift 拆文件（只移动代码，不改行为）。
3. Swift 接入 v2：握手、`app` 标识、`chrome`、`bye`、去掉死代码与兼容补丁、帧上限、fd 泄漏。
4. 生命周期：窗口还原、远端状态项、宽限期与 resume、本地断线不关窗口、统一停止入口。
5. 一条 PeerConnection：`FusionMedia` / `FusionMediaReceiver`，`ScreenSession` 去掉融合分支。
6. host 与桌面端按平台分派，UI 按 `fusion.start` 返回的 `platform` / `features` 判断能力。
7. Windows 本地端（Electron），然后 Windows 远端。

第 2–5 步需要两台 Mac 实测；单元测试只覆盖协议样例、纯逻辑与传输。
