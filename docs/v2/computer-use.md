# Computer Use 会话预览

状态：2026-10-08，已实现独立预览、macOS 目标窗口连续采集，以及现有 direct/relay 传输。已在 Chrome 和独立 iOS 模拟器窗口实测；Android 手机 UI 和跨公网网关尚未实测。没有接入 Codex 私有 PiP 视频接口。

## 帧源

`CodexDriver` 从 app-server 的 MCP 结果读取经过校验的 `result._meta["codex/toolSurface"]`，聊天 `result.content` 的图片仍只是历史附件。

- `browserUse`：浏览器元数据里的截图提供初始帧。Chrome / Edge 的 bundle ID 和目标标签页标题用于匹配 macOS 窗口。只有唯一匹配的窗口才开始连续取帧；切到其他标签页时暂停。能取得 Accessibility 网页区域时裁掉浏览器工具栏，否则显示目标窗口。
- `computerUse`：原生 appId 与工具提供的窗口标题头用于定位窗口，不读取聊天图片。没有标题时仅接受该应用唯一的可采集窗口；歧义时暂停。Simulator 已验证。每帧再次核对窗口 owner PID 和已知标题，避免窗口复用或切标签后串画面。
- 连续取帧来自独立 LinkShell.app helper 进程中的 ScreenCaptureKit，仅采集目标窗口，没有指针或键盘控制能力。不更改 Codex、不打包供应商原生模块，也不占用正常屏幕共享的 helper。

`codex/toolSurface` 是版本敏感的桌面实现细节。当前验证版本为 Codex app-server 0.159.3；缺失或不符合 schema 的字段不进入预览。Linux、Windows、内嵌浏览器和无法唯一匹配的窗口没有此连续采集能力；浏览器存在合法元数据截图时仍可保留该帧。

调研发现 Codex 内部存在原生 PiP 帧回调，但独立进程实测受到 XPC 调用者身份校验拒绝，收到 0 帧。不能把内部接口名称视为公开第三方视频 API；当前实现使用 macOS 的公开窗口采集接口。

## 传输与资源隔离

```text
目标窗口 → ScreenCaptureKit → 限尺寸 JPEG → Host 缩放/去重 WebP
                                               ↓
                      现有 HostStreams → WebRTC data channel
                                               ↓ 无直连时
                                         加密 relay RPC
                                               ↓
                                  纯画面悬浮窗 / 放大查看
```

采用可独立解码的图片帧，复用端口预览和屏幕共享已有的字节流。这里的 WebRTC 是 **data channel**，不是新的视频 track；无需修改 gateway 的路由、鉴权或协议路径。

`sessions.preview` 返回短期、随机、一次性的只读授权，随后经现有 proxy/direct 通道打开 loopback 帧服务。每个消费者必须 ack 才能收到下一帧；消费过慢只保留最新帧，不堆积历史图片。没有 ack 会断开。调用方不能仅凭一个 direct 标志取得直连速率，Host 还校验该连接的 direct 状态。

helper 故障由预览独立处理，保留最后帧并有界退避重试。关闭预览只释放它自己的流和采集，不关闭正常 RPC、普通端口流或屏幕共享。单 helper 最多同时采集 4 个目标。

## 带宽约束

- 采集最多 3 fps；Host 直连帧最大 480 × 720，单帧最多 48 KiB，发送预算 96 KB/s。
- relay 帧最大 320 × 480，必要时继续降低尺寸和质量，单帧最多 16 KiB；最短间隔 2 秒。
- relay 单观看连接按 4 KB/s、Host 汇总按 6 KB/s 进行应用层计费节流。计费为编码帧长度的两倍再加 512 字节，覆盖两层 base64 与信封的余量；这不是网卡层硬上限，TCP/TLS/WebSocket 等开销另计。初始帧允许一次有界突发。
- 相同编码画面不重复发送。无观看者、收起、离开会话、App 后台或关闭预览时停止订阅和采集；全屏也保持同档带宽。
- 真实 Chrome 一分钟采样：relay 20 帧 / 24,674 字节图片数据；direct 63 帧 / 179,512 字节。真实 Simulator 一分钟采样：relay 13 帧 / 118,666 字节；direct 127 帧 / 2,601,862 字节。场景不同，不能当作固定流量承诺；未包含全部网络开销。Simulator 画面包含正在变化的会话内容及递归小窗，变化更密集。

## 状态与界面

Host 按 session 保存目标、最后帧和采集信息；原生目标没有初始截图也可以保存并启动采集。连续帧最多每十秒持久化一次，停止观看和 Host 正常退出时再保存。回合结束不清除预览。

手机按电脑与 session 保存展开、收起、主动关闭状态。退出再进入、空闲会话重开、App 重新加载都恢复对应状态与最后帧。手动关闭不会被普通帧更新重新打开；`desktop.preview.show` 是现有仅本机 desktop RPC 下的显式恢复操作。不同会话各自订阅，不从聊天列表的最后一次工具图片推断画面。

浮窗只显示画面，以及收起、放大、关闭按钮；收起后是一个小图标。小窗和收起图标都支持拖拽，以 8 点位移阈值区分拖动与点击，限制在当前聊天可见区域内。位置按电脑和会话在当前 App 进程保存，旋转、键盘及分栏改变可用尺寸时按相对位置恢复。外层已经避开导航栏的聊天区域不再重复增加 header inset；否则取导航栏与页面 inset 的较大值。拖拽区域从实际标题栏下方开始，避免上方留下无法拖入的空白。附带修复仅在展示层去掉 Codex 用户图片消息的文件封装文字，原始消息保持不变。

## 验证与交付边界

自动验证覆盖元数据提取、无聊天图片的原生采集启动、持久化恢复、图片限制、去重、一次性授权、ack 背压、直连及回退重新进入、普通 RPC/端口流不受关闭预览影响。Mac helper 已成功构建及 Developer ID 签名。

真实操作验证了 Chrome 连续窗口帧，以及 Simulator 原生窗口出画和收起浮窗。工具调用之外仍有帧到达。iOS 模拟器内已验证退出恢复和重新加载恢复；当前共享 Simulator 的前台焦点受另一项测试影响，放大及退出放大已验证，拖拽与关闭交互仍需独占设备验收。Android UI 未验收；旧 APK 不能代表当前实现。

从现有 HEAD 单独提取本功能后，完整 build、typecheck 和 App lint 通过；Host 238 项、client-core 41 项、wire 17 项、App 定向 6 项测试通过，Host 7 项环境相关测试跳过。Mac helper 31 项测试通过。

需要更新 wire、mac helper、host、携带源码编译的 CLI，以及 App / client-core。gateway 不需要功能更新。所有制品和流水线完成后仍由用户亲自发布。

## 调研依据

- [公开 MCP 协议源码](https://github.com/openai/codex/blob/0e1520605f67969b58e53762be4d675c036a981d/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs)：保留 `_meta`。
- 本机 Codex 0.159.3 与本会话真实工具结果，以及窗口采集/直连/回退实测。
- [社区浏览器 PiP 行为报告](https://github.com/openai/codex/issues/44448)、[社区 PiP 持久设置请求](https://github.com/openai/codex/issues/32451)：这些讨论没有提供第三方视频订阅接口。
