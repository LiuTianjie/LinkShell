# 融合模式：架构与协议（v2）

> 2026-11-15 设计并开始实现，分支 `fusion-arch-v2`。本文是融合模式的唯一规格：消息以 `packages/wire/src/fusion.ts` 的 schema 和 `packages/wire/test/fixtures/fusion/` 的样例为准，Swift 与 TypeScript 两端都对同一组样例做测试。协议与 0.10.10x 的融合两端**不兼容**，两台电脑都要升级。

## 1. 目标

一台电脑（**本地端**）把另一台电脑（**远端**）上的应用窗口显示成自己的窗口：每个远端应用在本地的 Dock / 任务栏、⌘Tab / Alt-Tab 里是一个独立应用。

现在只有 Mac → Mac。v2 要做到：

| 本地端 \ 远端 | macOS | Windows |
| --- | --- | --- |
| macOS（LinkShell.app hub + 每应用 Stub） | 已有 | 已实现，待实机验证（§8.2、§8.3） |
| Windows（Electron 窗口） | 已实现，待实机验证（§8.1） | 已实现，待实机验证 |

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

TCP + TLS 1.2 PSK（identity `linkshell-fusion-v1`，key = HMAC-SHA256(token, `linkshell-fusion-psk-v1`)），帧 = `[u32 BE 长度][JSON 对象]`。套件按顺序提供：`ECDHE-PSK-CHACHA20-POLY1305`、`ECDHE-PSK-AES128-CBC-SHA`、`PSK-AES128-GCM-SHA256`、`PSK-AES128-CBC-SHA`。Electron 的 BoringSSL（Windows 上的桌面端）没有 PSK-AES-GCM，所以 v1 唯一的 GCM 套件不够用；前两个带 ECDHE，有前向保密。2026-11-15 在一台 Mac 上实测：Network.framework、OpenSSL 3.5（Node）、Electron 44 两两之间都能谈成。

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
- 非主动断开（无 `bye`）：远端进入 30 秒宽限期；本地 hub 不退出、不关 Stub，窗口显示「正在重连」，由桌面端重新 `fusion.start` 后以 `resume` 接回。本地通常先发现断线（5 秒对 8 秒），所以远端在旧连接还没超时时也接受同一会话的 `resume`。断线期间关掉的窗口在接回后由远端补发 `wclose`，退出的应用补发 `app.exited`。
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
| `icon` | L 请求 / R 回复 | 请求：`app`、可选 `size`（要的边长，像素；Mac 的 Dock 要 1024，Windows 任务栏 256）；回复：`app`、`png`（base64），没有图标时不带 `png`。本地一次只请求一个，收到回复（或 2 秒没回）再请求下一个：一次请求上百个会把控制连接堵住几秒到几分钟，经网关中转时接收方落后 4 MB 还会被网关断开 |
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

`{frame, visible, scale, hz}`：`frame` 为该显示器在本地全局点下的区域；`visible` 为可用区域（去掉菜单栏、Dock、任务栏）；`scale` 为像素/点，可为小数（Windows 的 1.25、1.5）；`hz` 为最高刷新率。远端按这些建同样布局的虚拟屏幕：虚拟屏幕只有 1x 和 2x，`scale` 大于 1 一律按 2x 建（`FusionProtocol.backingScale`）。`visible` 目前远端只记录，窗口仍限制在虚拟屏幕内。

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
- **数据通道**：整条连接只有 4 条，标签与普通屏幕共享相同：`input`（可靠有序）、`pointer`（无序、不重传）、`cursor`（无序，融合不使用，保留以与屏幕共享一致）、`shape`（可靠）。每条输入消息带 `stream`（流键）和整条连接共用的序号 `i`；`shape` 带 `k`，发给用户最近操作的那个窗口。流键不能放在 `k`：`key` 事件的 `k` 是键名，0.10.106 把流键写进 `k`，回车、退格、方向键和所有快捷键到了远端都成了名叫 `w12` 的键。为兼容 0.10.106 的远端，自身没有 `k` 的事件仍在 `k` 里再放一份流键；远端先读 `stream`，没有时读 `k`。
- **映射**：`wopen.stream` 和 `rtc {t:"streams"}` 给出 `{k, mid}`，本地按 transceiver 的 `mid` 把解码帧交给对应窗口。
- **重协商**：流增减时远端重新 offer（合并 50 ms 内的变化）。本地只回 answer，从不主动 offer。
- **码率**：所有流共享一个带宽估计；每个发送端按焦点设置 `maxBitrateBps`、`maxFramerate` 和 `networkPriority`（聚焦窗口 60/120 fps 高优先级，其他 30 fps，弹出层空闲时 2 fps）。
- **静止窗口**：Windows 的窗口截取（Windows.Graphics.Capture）只在窗口变化时出帧，一个不动的窗口之后不会再有关键帧。Node 远端保留每个流自上一个关键帧以来的全部访问单元（最多 240 个、8 MB），接收方刚连上、收到 PLI 或者刚拿到这个流的 `mid` 时整段重发一次（每个流每秒最多一次），本地于是看到窗口现在的样子。
- **编码名**：SDP 里写 `H264`。libwebrtc 按 offer 里的写法应答，再按这个名字找解码器，大小写敏感：werift 默认的 `h264` 在 Mac 的解码器工厂里找不到，每一帧都交给了什么也不做的解码器，画面永远不来（0.10.106 的 Windows 远端与远程桌面都是这样）。Mac 的接收端收到 offer 时把编码名改回规范写法，兼容旧的 Windows host。
- **裁剪元数据**：仍放在 H.264 SEI 里随帧传（窗口位置、裁剪、`ack`），v2 在数组末尾加了窗口 id（第 15 个元素）：transceiver 回收给下一个窗口时，本地据此丢掉上一个窗口残留的帧。

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
| `restart` | L | 本地的 PC 失败而控制连接还在：远端新建一条 PC，重新挂上所有流（每分钟最多几次） |

### 5.3 与普通屏幕共享的关系

融合不再使用 `ScreenSession`。远端用 `FusionMedia`（一条 PC，每个流一个 `ScreenCapturer` + 视频源），本地用 `FusionMediaReceiver`；`ScreenSession` 与 `DesktopScreenReceiver` 去掉所有融合分支，只服务普通屏幕共享。两者共用的是 `ScreenCapturer`、`Engine`、编码器、`Control` 和 `InputEvent`。

## 6. 代码结构

远端（`apps/mac/Sources/LinkShell/Fusion/Remote/`）：

| 文件 | 职责 |
| --- | --- |
| `FusionRemote.swift` | 进程入口、与 host 的 socket、token、监听器、当前会话 / 挂起会话 / resume |
| `FusionRemoteSession.swift` | 协议分发、握手、宽限期与 resume、`finish` / `end`、窗口还原 |
| `FusionDisplays.swift` | 虚拟屏幕的创建、重建与释放；远端 Dock 的隐藏与恢复（`FusionDock`） |
| `FusionWindowTracker.swift` | 窗口追踪（`track`）、弹出窗口、屏幕外窗口救回、记录窗口原始位置、聚焦 |
| `FusionPlacement.swift` | `place` 队列、seq / ack、采样器（`FusionSampler`，SEI 内容） |
| `FusionAccessibility.swift` | 窗口外观测量、菜单栏与 Dock 菜单镜像 |
| `FusionApps.swift` | 应用目录、图标、启动、退出 |
| `FusionStreams.swift` | 截取钩子；会话与 `FusionMedia` 之间：开关窗口流、弹出层 |
| `FusionMedia.swift` | 一条 PC、每个流一个视频发送端、共享输入通道、码率策略、重协商 |
| `FusionStatusItem.swift` | 远端菜单栏状态项 |

本地（`apps/mac/Sources/LinkShell/Fusion/Local/`）：

| 文件 | 职责 |
| --- | --- |
| `FusionLocal.swift` | 进程入口、控制连接、握手、`bye`、断线保持与 resume、退出原因 |
| `FusionHubSocket.swift` | 本机 socket：Stub 注册、桌面端控制请求（`StubClient`） |
| `FusionStubBundles.swift` | Stub `.app` 生成、图标合成、清理 |
| `FusionFrames.swift` | 窗口记录、解码帧裁剪、交给 Stub、弹出窗口（`FusionOutput`） |
| `FusionMediaReceiver.swift` | 一条 PC、按 mid 分流、输入发送 |

共享：`Fusion/FusionWire.swift`（传输）、`Fusion/FusionProtocol.swift`（版本、features、消息类型表、显示器签名、`chrome` 编解码）、`Fusion/FusionMetadata.swift`（SEI）。hub 与 Stub 之间的本机 IPC 不属于本协议，沿用原来的消息名。

`ScreenSession` 已去掉全部融合分支，只服务普通屏幕共享。

host：`fusion.ts` 的 `fusionPlatform()` 决定本机能当哪种远端；`fusion.start` 返回 `proto` 与 `platform`。Windows 远端尚未实现，`fusion.start` 返回明确的「还在开发中」。

桌面端：`fusion-store` 在拉起 hub 之前检查 `proto`；hub 报告 `reconnecting` 时重新 `fusion.start` 拿新 token，交给已在运行的 hub 以 `resume` 接回。主进程里 hub 的启动与查询（`startFusionMode`、`queryFusionSocket`）仍写在 `main.ts`，等 Windows 本地端实现时再抽成 `FusionHubDriver`。

### 停止

融合页「断开」与 ⌘K「结束融合模式」走同一条路径：桌面端让本地 hub 退出，hub 先发 `bye {reason:"user"}`，远端立即还原窗口、删除虚拟屏幕、恢复 Dock。hub 若已不在，远端在 30 秒宽限期后自行结束。远端菜单栏的「结束融合」发 `bye {reason:"user"}` 给本地，本地 hub 退出并显示原因。

## 7. 实施顺序与状态

1. 协议规格、schema 与样例 —— 完成。
2. Swift 拆文件 —— 完成。
3. Swift 接入 v2：握手、`app` 标识、`chrome`、`bye`、去掉死代码与兼容补丁、帧上限 —— 完成。
4. 生命周期：窗口还原、远端状态项、宽限期与 resume、本地断线不关窗口、统一停止入口 —— 完成。
5. 一条 PeerConnection：`FusionMedia` / `FusionMediaReceiver`，`ScreenSession` 去掉融合分支 —— 完成。
6. host 返回 `proto` / `platform`，桌面端检查版本并驱动 resume —— 完成；主进程 `FusionHubDriver` 留到第 7 步。
7. Windows 本地端（Electron）与 Windows 远端（host + `LinkShell.Screen.exe --fusion`）—— 已实现，见 §8.5。

第 2–5 步只做了单元测试（协议样例、纯逻辑、传输）和编译，**没有两台 Mac 的端到端验证**：一条 PC 的重协商与 transceiver 回收、resume、窗口还原、远端状态项都要实机确认。

## 8. Windows

应用永远在自己的系统上运行：传的只是窗口画面、对窗口的输入和窗口信息。下面两部分各自独立，Windows 本地连 Windows 远端在两部分都完成后即可用。

### 8.1 Windows 本地端（Electron，显示 Mac 或 Windows 的应用）

- **主进程**（`apps/desktop/src/main/fusion/`）：`wire.ts` 是 Node 版控制连接（与 `FusionWire` 同一套 TLS-PSK 与分帧）；`hub-driver.ts` 定义 `FusionHubDriver`（启动、状态、启动/退出应用、停止），`MacHub` 是现在的 `--fusion-local` 进程，`ElectronHub` 在主进程里实现同样的协议状态机：握手、目录、窗口记录、`bye`、断线保持与 `resume`。
- **窗口**：每个远端窗口一个无边框 `BrowserWindow`。位置由本地决定（拖动、缩放后发 `place`，带递增的 `seq`），尺寸在远端确认（`ack`）后采纳远端的实际大小。Windows 上用 `setAppDetails` 给每个远端应用一个 AppUserModelID（`LinkShell.Fusion.<slug>.<hash>`）、图标（PNG 内嵌的 ICO）与重新启动命令，于是每个应用在任务栏、Alt-Tab 里独立；用过的应用在开始菜单 `LinkShell\<电脑>\` 下生成快捷方式（`shell.writeShortcutLink`），Windows 搜索能找到。
- **画面**：每台远端一个隐藏的渲染窗口加载 `fusion.html`（desktop-ui 的第二个入口），持有那条 RTCPeerConnection；远端窗口的 `BrowserWindow` 由它 `window.open` 打开，与它同一进程，可以直接把轨道放进子窗口的 `<video>`。裁剪元数据用 encoded insertable streams 从 H.264 SEI 读出，按 RTP 时间戳与 `requestVideoFrameCallback` 对上，每一帧调整 `<video>` 的位置与缩放。
- **输入**：子窗口里的鼠标、键盘带上流键 `stream` 发到 `input` / `pointer` 通道（§5.1）。远端是 Mac 时 Ctrl 映射为 ⌘。
- **光标**：远端在 `shape` 通道上说光标的样子，子窗口用它作为 CSS 光标（`image-set(… 2x)`：PNG 两个像素一个点，按远端的点数大小画）。
- **标题栏**：Mac 窗口的红绿灯在画面里：关闭发 `wclose.req`，最小化、缩放在本地做；标题栏空白处是拖动区（`-webkit-app-region: drag`），`hitrects` 是非拖动区。Mac 应用的菜单：标题栏右键弹出原生菜单（`menu.fetch`）。
- **弹出菜单**：显示层流 `d<i>` 里的每个弹出窗口一个不抢焦点、置顶的子窗口。
- 这套也能在 Mac 上跑（`LINKSHELL_FUSION_HUB=electron`），用来在单机上测试。

### 8.2 Windows 远端（被 Mac 或 Windows 使用）

- **host 自己就是远端**：Windows 上 `FusionShare` 不启动单独进程，在 host 里开同一套 TLS-PSK 控制服务；WebRTC 用 werift（远程桌面已经在用），一条 PeerConnection，每个流一个视频 transceiver。
- **`LinkShell.Screen.exe --fusion`**：窗口枚举与变化（EnumWindows，约 30 Hz：位置、标题、所属进程与 AppUserModelID、是否最小化 / 隐藏 / 工具窗口 / 弹出菜单），应用目录（`shell:AppsFolder`），图标，启动（`shell:AppsFolder\<AUMID>`），退出（`WM_CLOSE`，强制时结束进程），缩放（`SetWindowPos`），聚焦（`SetForegroundWindow`），关闭（`WM_CLOSE`），标题栏按钮（`DWMWA_CAPTION_BUTTON_BOUNDS`），输入（`SendInput`，先把目标窗口切到前台）。与 host 之间是标准输入输出上的 JSON 行，与远程桌面的组件一样。
- **窗口属于哪个应用**：窗口按目录里的应用 id 归到被启动的应用，对不上就不显示（本地看到应用「运行中」却没有窗口；与电脑快慢无关，没有超时）。目录自动排除 LinkShell 自身与它生成的 `LinkShell.Fusion.*` 快捷方式；同一可执行文件有多个快捷方式时，不带启动参数的主程序优先于 `_crx_` / 带参 PWA 快捷方式，虚拟目录项还回退读取注册表 `App Paths`。归属依次看：窗口自己的 AppUserModelID 已被融合 → 已融合进程及其子进程（或 `Chrome.<配置>` 这类基础前缀已被融合，解决选完用户资料后新窗口换 id 的问题）→ 目录中已有的窗口/进程 AppUserModelID 或可执行文件映射 → 启动时学到的别名（首个窗口出现后仍继续观察 30 秒，覆盖启动器/资料选择器交接；已在运行并被拉到前台的窗口同样接管）。Windows 应用在切换窗口（如资料选择器关闭、主窗口稍后出现）期间有 2 秒退出缓冲，避免误发 `app.exited` 把本地 Stub 提前关掉。还不行的：已经在后台运行、点了之后窗口又不到前台的应用；以管理员身份运行的应用（读不到进程，也截不到）。
- 关闭的窗口流如果还有排队没发完的包，不再发：它的 transceiver 可能已经给了新窗口，旧包会夹在新窗口的包中间。
- **帧的交付**：ffmpeg 的输出是 AVI 块流（每帧带长度，host 请求时），不是原始 H.264：一帧读完就交出，不等下一帧。见 `screen-realtime.md` §10.1。
- **截取**：每个窗口一个 ffmpeg：`gfxcapture=hwnd=<h>:capture_border=1:capture_cursor=0:width=W:height=H:resize_mode=crop:max_framerate=60`（FFmpeg 8.1 起有，随包的就是 8.1），之后走远程桌面同样的硬件 H.264 编码器选择。有的驱动拒绝零拷贝路径（Intel UHD 615：`vpp_qsv` 建帧池失败），每次都要先失败一次再走 CPU 转换，在小电脑上多花一秒；助手程序把成功的路径报给 host（`[video] encoder=… path=native|compatible`），host 记住并通过 `LINKSHELL_WINDOWS_VIDEO_HINT` 让下一次先试它。`capture_border=1` 截整个可见窗口（含标题栏，不含不可见的缩放边框）；画布固定为窗口所在显示器的大小，窗口在左上角，缩放窗口不必重启编码器。host 在每一帧前插入与 Mac 相同格式的 SEI。
- **弹出菜单、下拉框、提示**：在 Windows 上是独立的顶层窗口。每块显示器一路 ddagrab 流作为 `d<i>`，SEI 列出其中的弹出窗口；本地按 `offset` 把它们放在父窗口旁边。
- **坐标**：远端没有虚拟屏幕，窗口留在原地。本地位置由本地决定，远端记住每个窗口最后一次 `place` 的本地位置，用于 `wopen` / `layout`；只同步尺寸：本地点数 × 远端显示器缩放 = 远端像素。
- **features**：`clipboard`（文字与图片，没有 RTF）；没有 `keys`（按键按名字输入）、`menubar`、`dockmenu`、`virtual-displays`。
- **剪贴板**：助手程序在它的 STA 线程上每 0.5 秒看一次 `GetClipboardSequenceNumber`；前台窗口属于已融合的应用时，把变化读成文字和 PNG（`Clipboard.GetImage` 转码）发给 host，写入对方发来的内容后记下序号，不回送。带 `ExcludeClipboardContentFromMonitorProcessing` 的内容（密码管理器）不读。host 只在本地端声明了 `clipboard`、并且用户进过一次窗口（第一个 `focus`）之后才转发，两个方向都是，与 Mac 相同；上限同样是 8 MiB。给助手程序的一行超过 64 KB 时只有 `{"t":"clip"` 开头的才收。
- **助手程序的节奏**：输入一到就处理（不再等 33 ms 的窗口轮询）；没有已融合的应用时每 0.5 秒才看一次窗口；每个窗口属于哪个应用缓存 1.5 秒，目录整份建好后再换上（半份目录会把已经在运行的应用永久认成它的可执行文件）；对别的进程的窗口用 `SWP_ASYNCWINDOWPOS` 和 `ShowWindowAsync`，一个没有响应的应用不会卡住所有窗口。助手程序退出后 host 重新启动它，间隔逐次加倍到 30 秒。
- **编码器结束**（窗口所在显示器变了、锁屏、一次截取失败）：host 把这一路重新启动，间隔 0.5 秒起逐次加倍，连续 5 次都撑不过 20 秒才报错；此前是只提示一次，窗口一直空白。offer 10 秒没有 answer 时重新发，不再卡住之后所有窗口。
- **限制**：锁屏、UAC 安全桌面时不可用；窗口重叠时，只有前台窗口的悬停是准的（一操作就切到前台）；显卡同时硬件编码的路数有限，非聚焦窗口降到 30 fps，超过上限时只编码最近使用的几个窗口。

### 8.3 Mac 本地端显示 Windows 窗口

- `chrome.style == "windows"`：Stub 不画红绿灯、不做 macOS 圆角；Windows 的最小化 / 最大化 / 关闭按钮区域映射成本地操作。
- 远端 `platform == "windows"` 时，⌘ 映射为 Ctrl，Option 映射为 Alt。
- 远端没有 `menubar`：Stub 只显示自己的最小菜单（退出、窗口）。

### 8.4 验证

- **模拟对端**：TS 写的参考实现能扮演远端或本地，单机跑握手、窗口、画面、输入。Windows 本地端在 Mac 上就能对着它测。
- **Windows CI**：在 Windows runner 上对真实窗口（记事本）跑 Windows 远端：列出应用、启动、收到 `wopen`、视频轨道有帧、点击后窗口状态变化。
- **实机**：两台电脑的组合（Mac↔Windows、Windows↔Windows）、多显示器与缩放、输入法、快捷键、断线恢复、结束后窗口状态。

### 8.5 状态（2026-11-15）

实机首测（Mac mini 远端 + MacBook Pro / Surface Go 本地，0.10.106）之后修正的问题：
- Mac 远端每次 `fusion.start` 重建监听时，旧监听还没释放端口就监听同一端口，约一半失败（`Address already in use`）。现在等旧监听 `.cancelled` 再开，端口仍被占时重试 1 秒，再不行用任意端口。
- Windows 本地端的回车、退格、方向键、快捷键全部丢失：流键覆盖了键名（§5.1）。
- Mac 本地端连 Windows 远端从未出画面：编码名大小写（§5.1）；另有静止窗口不再出关键帧、offer 要等 ICE 收集完才发（在网卡多的电脑上要等 5 秒）。
- 窗口在后台自己关掉：远端用 `NSRunningApplication` 判断应用是否退出，它会短暂查不到活着的进程，于是把应用的窗口全部关闭（日志里随后同一个 pid 又被融合）。现在以进程表为准（`kill(pid, 0)`）。另外 ping 与 pong 都在主线程上，主线程忙时（大量图标、Accessibility 不应答的应用）对端 5 秒收不到就断开；现在都在连接自己的队列上。
- 本地 Mac 自己也是别人的融合远端时，把那些虚拟屏幕也报给了远端，对方一开一关它就要重建屏幕；重建期间的媒体重启被拒绝，画面断掉。现在不报 LinkShell 自己的虚拟屏幕，重建期间的重启等重建完成再做。
- 远程桌面里 Mac 的光标在 Windows 上大一倍：CSS 光标按 PNG 的像素画了，现在用 `image-set` 带上倍率。


已验证：
- Mac 本地端（本次构建）经网关隧道连 Windows 远端实机（Surface Go，0.10.106 host）：控制连接稳定、视频 2 秒内连通、记事本两个窗口出现在 Mac 上、退出与结束正常。
- Mac 本地端对 host 的模拟远端（同一台 Mac）：握手、媒体连通、首帧解码。
- `apps/desktop/scripts/fusion-e2e.mjs`：真实 Electron 里的 `FusionElectronHub` + `fusion.html`，对着 host 的模拟远端（同一台 Mac）：窗口打开、画面按 SEI 裁剪、点击送到远端窗口、缩放、关闭、回收的 transceiver 上的新窗口，8 项通过。
- `packages/host/test/fusion-remote.test.ts`：Node 远端 + 模拟平台，真实 TLS-PSK 与 WebRTC（werift 作接收方）：握手、目录、`wopen`、`streams`、带 SEI 的 RTP、按流键分发输入、缩放确认、关闭与 `app.exited`。
- TLS-PSK 套件：Network.framework、OpenSSL 3.5、Electron 44 两两握手（每个套件逐一）。
- `apps/windows/src/*.cs` 在 Mono `mcs -langversion:5` 下编译通过（与 .NET Framework 自带编译器同一语言版本）。

未验证（需要 Windows 实机或 Windows CI）：`Fusion.cs` 的 P/Invoke 与窗口分类、`gfxcapture` 截取与硬件编码、`SendInput` 落点、任务栏 AppUserModelID 分组与开始菜单快捷方式、多显示器与缩放、Mac 本地端连 Windows 远端的整条路径。Windows CI 新增 `apps/windows/test/fusion.test.mjs`（记事本：目录、启动、窗口与标题栏、缩放、关闭）。

尚未实现：Windows 远端的光标形状；剪贴板里的文件（协议里没有文件消息，要做得另加分块传输）；Windows 两侧的 RTF。

Electron 本地端的剪贴板（`apps/desktop/src/main/fusion/clipboard.ts`）：Electron 没有剪贴板变化计数，所以在远端的窗口得到焦点时看一次（读文字和 PNG，按内容摘要判断是否变过），停留在窗口里时每 0.7 秒只比较文字和格式；连续两张图片格式相同，要到下一次窗口得到焦点才会发现。远端发来的内容写入后记下摘要，不回送。

状态（2026-11-16）：Windows 远端与 Electron 本地端的剪贴板有单元测试（规则、大小上限、不回送）和 host 模拟远端的测试；Electron 44 的 `clipboard.read()` 在 Mac 上读过一次。C# 一侧（读写剪贴板、PNG 转码）没有在 Windows 上编译或运行过。

已知限制：Windows 远端的每帧元数据（`ack`、窗口大小）是在 host 发出这一帧时取的最新值，不是截取时刻的值（Mac 远端用 4 ms 采样环按截取时间对齐），缩放过程中裁剪会有短暂错位；`MAX_WINDOW_STREAMS`（6）个窗口以上不再出画面，并提示一次。

