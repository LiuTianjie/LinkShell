**一、PRD 正式文档草案**

## 产品名称
Claude / Codex Remote Bridge

## 1. 产品背景
Claude Code 与 Codex 的核心工作流都强依赖本地终端环境，但终端天然局限在用户电脑前。目标是构建一套三段式桥接系统，使用户可以在手机端远程查看并控制本地 Claude Code 或 Codex 的真实终端会话，同时保留尽可能接近原生终端的交互体验。

该系统由三部分组成：

1. 本地 CLI
运行在用户电脑上，负责接管或启动 Claude Code / Codex 会话，监听输出并写入输入。

2. 云端网关
部署在公网环境，负责连接中转、设备配对、会话管理、鉴权和重连。

3. 手机端 App
使用 Expo 开发，支持 iOS、Android，并在本地调试阶段支持 Web 端，负责还原终端体验并提供远程控制能力。

## 2. 产品目标
1. 在手机端远程查看和控制本地 Claude Code / Codex 终端会话。
2. 保留真实终端语义，包括颜色、光标、Ctrl+C、窗口大小变化、长文本粘贴和滚动。
3. 支持公网访问和跨网络环境的稳定连接。
4. 具备可恢复的短时断线重连能力。
5. 以单手机独占控制单个会话为 MVP，控制模型清晰可靠。
6. 提供 Web 调试端，便于本地协议和交互联调。

## 3. 非目标
1. 不在 MVP 中支持多设备协同控制。
2. 不在 MVP 中支持多人旁观或共享会话。
3. 不在 MVP 中支持端到端加密。
4. 不在 MVP 中支持文件同步、文件浏览或远程编辑。
5. 不在 MVP 中承诺完整兼容 tmux、vim、图片协议、OSC 8 超链接等高级终端能力。
6. 不在 MVP 中建设完整审计系统和全文终端日志持久化。

## 4. 核心用户场景
1. 用户在电脑上启动 Claude Code 或 Codex，并通过 CLI 桥接器创建远程会话。
2. 用户在手机 App 上登录并完成配对。
3. 用户在手机上查看当前终端输出、输入命令、发送控制键、复制粘贴内容。
4. 当网络短暂断开后，手机重新连接并继续恢复同一会话。

## 18. 当前实现状态
当前仓库已完成完整最小可用闭环，三端均可实际运行并联调。

已完成内容：

1. 已建立 pnpm monorepo，包含共享协议、CLI、Gateway、Mobile App、Web 调试端。
2. 共享协议包支持 16 种消息类型、ACK 确认、会话恢复和版本协商。
3. CLI 支持 PTY 桥接、多 provider（claude / codex / custom）、内置 Gateway、daemon 模式、QR 配对、scrollback 缓存和断线恢复。
4. Gateway 支持 pairing、会话管理、WebSocket host/client 转发、控制权管理、心跳检测、CORS 和限流。
5. Mobile App（Expo SDK 54 + React Native 0.81）已具备完整 UI：
   - 首页（标题/副标题/快速操作/历史会话/左滑删除）
   - 会话列表（按网关分组、并行拉取、骨架加载动画、下拉刷新）
   - 新建连接 Sheet（扫码/手动输入/分段控制/iOS sheet detents）
   - 网关服务器管理（多服务器/检测/默认/增删）
   - 终端详情（WebView + xterm.js 渲染、键盘工具栏、控制键）
   - 设置页
   - 完整 dark/light 主题系统
   - react-native-gesture-handler + react-native-reanimated 集成

当前范围内的实现定位：

1. CLI、Gateway、App 三端已具备完整可用闭环，不是脚手架状态。
2. Gateway 当前使用内存态 session 和 pairing，适合开发和单实例部署，尚未接入 Redis。
3. App 已接入 WebView + xterm.js 终端渲染，不再是纯文本镜像。
4. CLI 已支持 scrollback 缓存和断线恢复。

## 19. 当前目录结构

```text
.
├── apps/
│   ├── mobile/                 # Expo App（iOS/Android）
│   │   ├── App.tsx             # 入口：导航、连接流、GestureHandler
│   │   ├── babel.config.js     # reanimated plugin
│   │   └── src/
│   │       ├── components/     # ConnectionSheet, ServerPicker, TerminalView, InputBar, KeyboardAccessory
│   │       ├── hooks/          # useSession (WebSocket), useAppState
│   │       ├── screens/        # Home, SessionList, Session, Settings, Scanner, Pairing
│   │       ├── storage/        # AsyncStorage: history, servers
│   │       ├── theme/          # dark/light 主题系统
│   │       └── utils/          # fetch-with-timeout, pairing-link
│   └── web-debug/              # Web 调试端（Vite + xterm.js）
├── packages/
│   ├── cli/                    # 本地 CLI（PTY、内置 Gateway、daemon、doctor/setup）
│   ├── gateway/                # 云端网关（配对、会话、路由、控制权、限流）
│   └── shared-protocol/        # 三端共享协议（Zod schema、16 种消息类型）
├── docs/
│   ├── ai-handoff.md           # AI 交接文档
│   ├── deploy.md               # Gateway 部署指南
│   ├── user-guide.md           # 用户使用文档
│   └── site/                   # 落地页
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml
└── PRD.md
```

各模块职责：

1. apps/mobile
Expo App（SDK 54 + RN 0.81），完整终端远程控制客户端。首页、会话列表（按网关分组）、连接面板（扫码/手动）、网关管理、终端详情、设置。支持 dark/light 主题切换、手势交互、骨架加载动画。

2. apps/web-debug
Vite + xterm.js 的 Web 调试端，用于本地协议联调。

3. packages/shared-protocol
三端共享协议定义，包含 16 种消息类型的 Zod schema。

4. packages/cli
本地桥接 CLI，支持 PTY、多 provider、内置 Gateway、daemon 模式、QR 配对、scrollback 缓存。

5. packages/gateway
云端网关，负责 pairing、会话管理、WebSocket 转发、控制权、心跳、CORS 和限流。

## 20. 本地启动方式

安装依赖：

```bash
pnpm install
```

启动网关：

```bash
pnpm dev:gateway
```

创建 pairing：

```bash
curl -X POST http://localhost:8787/pairings -H 'content-type: application/json' -d '{}'
```

启动 CLI 示例：

```bash
pnpm --filter linkshell-cli dev start \
	--gateway ws://localhost:8787/ws \
	--session-id <session-id> \
	--provider custom \
	--command bash
```

启动 Expo App：

```bash
pnpm dev:app
```

说明：

1. 当前 App 先输入 gateway 地址和 pairing code，再 claim session。
2. 当前 CLI 的 provider 建议先使用 custom + bash 做联调，再接 Claude 和 Codex 的真实命令。
3. node-pty 安装后若运行时报原生模块问题，需要执行 pnpm approve-builds 并允许 node-pty 构建脚本。

## 21. 下一阶段实现重点

第一优先级：

1. 共享协议补齐 ACK、resume、control ownership。
2. 网关从内存态迁移到 Redis。
3. CLI 增加断线恢复和 scrollback 缓存。
4. App 从文本镜像升级到终端 buffer 和 ANSI 渲染模型。

第二优先级：

1. Claude provider 与 Codex provider 的真实启动适配。
2. pairing 登录态与会话鉴权分离。
3. Web 调试体验增强。
4. 控制权抢占和显式释放机制。
5. 开发阶段，用户在 Web 端直接调试终端协议、渲染和交互。

## 5. 核心设计决策
1. CLI 必须采用 PTY 真终端桥接，而不是纯 stdout 和 stderr 代理。
原因是必须保留完整 TTY 语义。

2. 服务端允许明文中转，但默认不做不必要持久化。
原因是要降低实现复杂度，同时控制隐私面。

3. 会话控制模式以单手机独占为主。
原因是先解决输入冲突和控制权问题，再扩展旁观和协同。

4. Web 端目标为开发调试优先。
原因是 Web 的主要职责是加速联调和 smoke test，而不是替代原生端。

## 6. 整体架构

### 6.1 架构概览
系统分为三层：

1. 本地数据源层
本地 CLI 在用户电脑上运行，启动或托管 Claude Code / Codex 进程，并通过 PTY 捕获完整终端字节流。

2. 云端控制与中转层
网关负责配对、鉴权、WebSocket 长连接、消息路由、会话状态、心跳和断线恢复。

3. 客户端显示与输入层
Expo App 负责登录、配对、终端渲染、输入回写、复制粘贴、特殊键和窗口尺寸同步。

### 6.2 数据流
1. Claude Code 或 Codex 输出终端字节流。
2. 本地 CLI 通过 PTY 读取原始输出并打包为终端事件。
3. 网关通过 WSS 转发终端事件到手机或 Web 客户端。
4. 手机端输入事件经网关返回本地 CLI。
5. CLI 将输入写回 PTY，从而驱动本地会话继续运行。

## 7. 各模块职责

### 7.1 本地 CLI
CLI 以 npm 包形式发布，主要职责如下：

1. 启动或附着 Claude Code / Codex 进程。
2. 用 PTY 捕获 stdout、stderr、控制序列、窗口变化和退出状态。
3. 维护本地会话状态，包括窗口大小、scrollback、最近输出和 ack 水位。
4. 接收远端输入并写回 PTY。
5. 在与网关断连时保留短时会话窗口，支持重连恢复。
6. 作为网关与真实终端之间的唯一可信源。

CLI 内部建议拆分为四个模块：

1. Process Supervisor
2. Terminal Stream Adapter
3. Gateway Transport Client
4. Session Store

### 7.2 云端网关
网关只负责连接与控制面，不负责运行 AI CLI 逻辑。职责如下：

1. 创建和管理配对会话。
2. 维护 API 鉴权和实时连接鉴权。
3. 维护终端会话状态、设备绑定和控制权归属。
4. 通过 WebSocket 转发终端消息。
5. 维护心跳、短窗口缓存、ACK 和重连逻辑。
6. 输出基础可观测性指标和错误日志。

网关内部建议拆成两部分：

1. HTTP API
负责配对、登录态校验、会话摘要和显式释放会话。

2. Realtime 服务
负责 WebSocket 会话、实时转发、ACK、心跳和控制权管理。

### 7.3 手机端 App
App 使用 Expo 开发，负责：

1. 登录和设备配对。
2. 展示可连接会话列表。
3. 连接终端会话并渲染输出。
4. 采集文本输入、特殊键、复制粘贴和滚动行为。
5. 发送窗口 resize 事件。
6. 在前后台切换、网络切换和屏幕旋转时保持合理会话体验。

App 内部建议拆为五层：

1. Auth / Pairing
2. Session List
3. Terminal Session Store
4. Renderer Adapter
5. Input Controller

## 8. 终端能力设计

### 8.1 为什么必须使用 PTY
PTY 是 MVP 成功的前提。若仅代理标准输出和输入，会丢失以下关键能力：

1. ANSI 颜色与样式
2. 光标移动与重绘
3. Ctrl+C 等信号输入
4. 窗口大小变化
5. readline 行编辑体验
6. 全屏程序和复杂终端行为的基础兼容

### 8.2 MVP 支持矩阵
第一阶段建议支持：

1. 24 位颜色
2. 粗体、下划线、反显
3. 光标移动
4. 清屏、清行
5. 标题更新
6. bell
7. bracketed paste
8. resize
9. 基本滚动与 scrollback

第一阶段不承诺：

1. tmux 完整兼容
2. vim 完整兼容
3. 图片输出协议
4. 高级鼠标事件
5. 完整 OSC 扩展

## 9. 连接与协议设计

### 9.1 传输层
实时通信采用 WSS 作为主链路，HTTP API 作为控制面。

WSS 负责：
1. 终端输出
2. 输入回传
3. 心跳
4. ACK
5. 重连
6. 控制权管理

HTTP API 负责：
1. 创建配对
2. 完成配对
3. 查询会话摘要
4. 显式释放会话
5. 调试辅助接口

### 9.2 协议分层
建议协议分成两层：

1. 传输层
字段包括 messageId、sessionId、deviceId、traceId、timestamp、ack 和 error。

2. 终端层
事件包括 terminal_output、terminal_input、terminal_resize、terminal_exit、bell、title、control_claim、control_grant、control_release、resume。

### 9.3 可靠性模型
1. 每个输出块带 seq。
2. 客户端返回已消费的最大 seq 作为 ACK。
3. 网关仅保留有限待确认窗口。
4. CLI 保留最近输出和状态作为最终恢复源。
5. 重连后从最后 ACK 点开始差量同步。

## 10. 配对与鉴权设计

### 10.1 配对流程
1. CLI 请求创建 pairing session。
2. 网关返回短期 pairing code 或深链。
3. 手机 App 登录后输入或扫描配对信息。
4. 网关建立 CLI 与手机之间的会话绑定。
5. 绑定成功后，网关向双方下发实时连接所需的 session token。

### 10.2 鉴权策略
1. 用户身份鉴权与实时会话鉴权分离。
2. API 使用 access token。
3. 实时连接使用 session token。
4. CLI 不长期持有用户主身份凭据。
5. 会话具有 TTL，并支持显式撤销。

## 11. 控制权模型
MVP 采用单手机独占控制单会话。

规则如下：

1. 同一时刻只允许一个 controller。
2. 后续若新增 observer，也只能只读，不可输入。
3. 若新设备申请接管，必须走显式控制权流程。
4. CLI 侧应支持主动释放或拒绝控制。
5. 协议层必须预留控制权相关事件，避免未来重构。

## 12. 客户端渲染策略

### 12.1 iOS 和 Android
建议使用原生 Canvas 型终端渲染方案。
理由：

1. 性能更稳定。
2. 更容易控制字符栅格、滚动和光标。
3. 更适合处理特殊键、输入法和布局同步。

### 12.2 Web
建议使用 xterm.js 作为调试壳。
理由：

1. 终端能力成熟。
2. 可以快速验证协议闭环。
3. 可以在本地调试阶段减少原生端调试成本。

### 12.3 统一抽象
渲染器虽然可以分平台实现，但会话状态、协议消费、输入事件模型必须共享，保证三端语义一致。

## 13. 数据与隐私策略
1. 服务端允许明文中转。
2. 默认不持久化全文终端内容。
3. Redis 只保存短期会话元数据、ACK 水位、连接映射和 TTL。
4. 日志仅记录结构化事件、连接状态和错误摘要。
5. 用户应能显式释放或撤销会话。
6. App 在接管控制前应展示当前设备名称、来源和最近活动时间，降低误操作风险。

## 14. 可观测性要求
必须至少具备以下指标：

1. 当前连接数
2. 活跃会话数
3. 平均 RTT
4. 重连次数
5. 未 ACK backlog
6. 异常关闭原因
7. 配对成功率
8. 会话恢复成功率

## 15. 技术范围建议
建议从一开始就采用 monorepo，至少包含以下工程单元：

1. 本地 CLI 包
2. 云端网关服务
3. Expo App
4. 共享协议包
5. 共享终端模型包

## 16. 里程碑规划

### M1 协议与闭环定义
产出统一协议、状态机、错误码、最小闭环设计。

### M2 CLI MVP
产出可桥接 Claude Code / Codex 的 PTY CLI。

### M3 网关 MVP
产出配对、WSS、ACK、重连和会话管理。

### M4 Web 调试端
产出可用于开发联调的终端调试界面。

### M5 Expo 原生端
产出 iOS 和 Android 可用的终端 App MVP。

### M6 稳定性与安全增强
产出控制权机制、恢复策略、限流和观察性增强。

## 17. 验收标准
1. CLI 能稳定桥接 Claude Code 或 Codex，且颜色、Ctrl+C、长文本粘贴和 resize 正常。
2. 网关在短时网络抖动下不会误释放会话。
3. Web 调试端可以完成完整输入输出闭环。
4. iOS 和 Android 端可以完成查看、输入、粘贴、滚动和窗口变化处理。
5. 三端协议在进入实现后不会频繁漂移。
6. 从本地 CLI 到手机端形成真实可用的远程终端体验，而不是纯文本镜像。

**二、技术任务清单**

下面这份是按工程执行顺序拆开的任务列表，重点是让你后面能直接按阶段推进。

## Phase 0 文档与仓库初始化
1. 明确 monorepo 结构。
建议至少规划五个工作区：cli、gateway、app、shared-protocol、shared-terminal。

2. 在 PRD.md 固化产品边界。
写清目标、非目标、控制权模型、隐私边界和阶段目标。

3. 定义全局命名约定。
包括 session、device、pairing、controller、observer、ack、resume 等关键术语。

4. 定义统一错误码体系。
例如配对失败、会话过期、控制权冲突、会话不存在、重连失败、CLI 退出。

交付结果：
1. monorepo 目录规划
2. 术语表
3. PRD 初稿
4. 错误码清单

## Phase 1 共享协议与状态机
1. 设计消息 envelope。
字段至少包括 messageId、type、sessionId、deviceId、timestamp、traceId。

2. 设计实时事件类型。
至少包括：
pairing_create
pairing_complete
session_connect
terminal_output
terminal_input
terminal_resize
session_ack
session_resume
terminal_exit
control_claim
control_grant
control_reject
control_release
session_error

3. 定义会话状态机。
建议状态：
pending_pairing
connecting
active
reconnecting
idle
terminated

4. 定义终端输出块模型。
需要明确 seq、chunk、encoding、stream、isReplay、isFinal、title、exitCode 等字段。

5. 定义 ACK 与重连恢复模型。
需要明确最大窗口、丢包恢复策略、重放边界和 TTL。

6. 定义控制权状态。
明确 controller 的唯一性、抢占策略、超时策略和释放条件。

交付结果：
1. 协议文档
2. 时序图
3. 状态机图
4. 错误码和事件枚举

依赖关系：
这是全项目阻塞项，后面所有模块都依赖这一层。

## Phase 2 CLI 架构设计与 MVP
1. 设计 Provider 抽象。
把 Claude 和 Codex 的启动方式解耦。

2. 设计 PTY Session Runtime。
负责启动子进程、接收字节流、写回输入、resize、退出收尾。

3. 设计 Process Supervisor。
负责启动、退出、崩溃处理、重试和清理。

4. 设计 Terminal Stream Adapter。
负责字节分片、ANSI 透传、chunk 合并、输出 seq 和 scrollback 缓存。

5. 设计 Gateway Transport Client。
负责 WSS 建连、心跳、ACK、重连和 resume。

6. 设计 Session Store。
负责本地恢复窗口、最近输出缓存、cols 和 rows、lastAckedSeq 和状态持久化。

7. 明确 Claude Provider 细节。
包括二进制发现、启动命令、环境变量和登录态检查。

8. 明确 Codex Provider 细节。
同样隔离启动参数和可执行文件发现逻辑。

9. 设计 CLI 命令面。
至少要有启动桥接、列出可用 provider、查看会话状态、主动断开远程控制等命令。

交付结果：
1. CLI 模块边界
2. Provider 适配设计
3. 会话恢复策略
4. 命令行体验设计

依赖关系：
依赖 Phase 1，完成后可以与网关并行进入实现。

## Phase 3 网关架构设计与 MVP
1. 设计 HTTP API。
至少包括创建配对、完成配对、查询会话摘要、释放会话。

2. 设计 WSS 实时连接层。
负责房间路由、消息转发、心跳和控制权。

3. 设计 Redis 数据模型。
需要明确 session key、pairing key、controller key、ack 水位和 TTL。

4. 设计认证流。
区分 access token 与 session token。

5. 设计连接恢复流。
包括 reconnect、resume、重放窗口和异常关闭处理。

6. 设计控制权流。
包括 claim、grant、reject、release 的时序。

7. 设计服务限流。
至少覆盖配对接口、连接建立、输入频率和异常重连。

8. 设计可观测性。
日志、指标、trace 和基础告警。

交付结果：
1. 网关 API 设计
2. WSS 路由设计
3. Redis 数据结构
4. 鉴权与恢复时序

依赖关系：
依赖 Phase 1，可与 CLI 的详细设计并行推进。

## Phase 4 Web 调试端
1. 设计最小登录与配对页。
仅满足联调，不追求完整产品体验。

2. 设计会话连接页。
展示连接状态、延迟、控制权和最近错误。

3. 接入 xterm.js。
用于验证终端输出、输入、resize 和 scrollback。

4. 打通输入回传。
覆盖普通输入、回车、退格、方向键、Ctrl+C、粘贴。

5. 打通重连与 resume。
验证协议闭环。

6. 增加开发调试面板。
便于查看消息序列、ACK、水位和异常关闭原因。

交付结果：
1. 最小终端调试页
2. 协议 smoke test 环境
3. 联调辅助信息面板

依赖关系：
依赖 Phase 1 和网关、CLI 最小闭环。

## Phase 5 Expo App 架构与 MVP
1. 设计登录与配对流。
支持输入配对码或未来扩展扫码。

2. 设计会话列表页。
展示活跃会话、最近活动时间和设备来源。

3. 设计 Terminal Session Store。
统一管理连接、输出、光标、scrollback、控制权和 ACK。

4. 设计 Renderer Adapter。
原生端与 Web 端共享会话语义，分离渲染实现。

5. 设计原生终端渲染模型。
明确字符栅格、滚动区域、光标渲染、样式层和重绘策略。

6. 设计输入控制器。
覆盖文本输入、特殊键、复制粘贴、长按、滚动和 resize。

7. 设计键盘附件栏。
至少提供 Esc、Tab、Ctrl、方向键。

8. 设计前后台切换策略。
明确进入后台后的连接保活或快速恢复行为。

9. 设计横竖屏与 resize。
保证终端列数和行数变化能同步回本地 PTY。

交付结果：
1. App 信息架构
2. 终端渲染方案
3. 输入与控制交互方案
4. 前后台与旋转策略

依赖关系：
依赖协议稳定和网关、CLI 最小闭环跑通。

## Phase 6 稳定性与安全增强
1. 优化断线恢复窗口。
明确 CLI 保留时长、网关缓存时长和客户端恢复时限。

2. 完善控制权策略。
支持新设备申请接管、旧设备超时释放和 CLI 本地主动断开。

3. 加强隐私保护。
默认不落全文日志，只存结构化元数据。

4. 完善限流与防滥用。
覆盖 pairing 爆破、连接风暴、恶意输入和重连抖动。

5. 建立最小可观测性告警。
例如会话恢复失败率、活跃连接异常下降、ACK backlog 飙升。

交付结果：
1. 恢复与抢占策略定稿
2. 限流与告警策略
3. 生产化运行边界

## Phase 7 测试与验收
1. 协议测试
验证消息 schema、状态机流转和错误码语义。

2. CLI 测试
验证颜色、Unicode、Ctrl+C、粘贴、resize、退出事件。

3. 网关测试
验证重连、ACK、TTL、控制权和路由正确性。

4. Web 测试
验证输入输出闭环和调试信息完整性。

5. App 测试
验证 iOS、Android、Web 的输入法、滚动、复制粘贴、前后台切换和旋转。

6. 端到端测试
从本地启动真实 Claude 或 Codex 会话，到手机端远程控制形成完整闭环。

