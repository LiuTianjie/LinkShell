# 灵动岛 + 项目管理 实施计划

## 现状分析

- Expo 54 + React Native 0.81，纯 JS 无自定义原生代码
- 协议层无工作目录/项目概念，session 只有 provider、hostname、platform
- Xcode 项目只有主 app target，无 Widget Extension
- 当前一个 session = 一个终端，无并行概念

---

## Phase 1: 项目（Project）概念 — 协议 + CLI + 移动端

这个优先做，因为灵动岛依赖项目上下文来展示有意义的信息。

### 1.1 协议扩展 (`packages/shared-protocol`)

在 `session.connect` payload 中增加 `cwd` 字段：

```typescript
sessionConnectPayloadSchema = z.object({
  // ...existing fields
  cwd: z.string().optional(),        // 工作目录绝对路径
  projectName: z.string().optional(), // 目录名作为项目名
});
```

新增消息类型 `session.info`，gateway 广播给 client：

```typescript
// gateway → client: session 元数据更新
sessionInfoPayloadSchema = z.object({
  provider: z.string().optional(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  cwd: z.string().optional(),
  projectName: z.string().optional(),
});
```

### 1.2 CLI 改动 (`packages/cli`)

- `bridge-session.ts`: 在 `session.connect` 中发送 `cwd: process.cwd()` 和 `projectName: path.basename(process.cwd())`
- 无需其他改动，CLI 已经在 cwd 下启动 PTY

### 1.3 Gateway 改动 (`packages/gateway`)

- `sessions.ts`: Session 对象增加 `cwd`、`projectName` 字段
- `relay.ts`: 从 host 的 `session.connect` 中提取 cwd/projectName，存入 session
- REST API `GET /sessions`: 返回 cwd 和 projectName
- client 连接时的 session info 广播中包含这些字段

### 1.4 移动端 — 项目选择 UI

**核心交互流程：**
```
HomeScreen → 点击 session → ProjectPickerScreen → 选择项目 → SessionScreen
                                ↑
                          展示该 session 下所有项目（按 cwd 分组）
                          + 最近使用的项目
                          + 新建连接按钮
```

**实际上更简单的方案：** 因为一个 CLI `linkshell start` = 一个 session = 一个 cwd，"项目"其实就是不同的 session。所以：

- SessionListScreen 改造：按 projectName 分组展示 sessions
- 每个 session 卡片显示：项目名、hostname、provider、状态
- HomeScreen 的"最近项目"= 最近连接的 sessions，按 projectName 去重
- 支持同时连接多个 session（多个终端标签页）

**具体改动：**

1. `useSession` hook → 支持多 session 管理（`useSessionManager`）
   - `sessions: Map<sessionId, SessionState>`
   - `activeSessionId: string`
   - 每个 session 独立的 WebSocket 连接
   - 切换 active session 时切换终端显示

2. `SessionScreen` → 顶部增加 session 标签栏
   - 水平滚动的标签，每个标签显示 projectName
   - 点击切换，长按关闭
   - 类似浏览器标签页

3. `HomeScreen` 改造
   - "最近项目"区域：按 projectName 展示，显示项目图标
   - 点击直接连接到对应 session
   - 显示 session 状态（active/disconnected）

4. `SessionListScreen` 改造
   - 按 projectName 分组
   - 每组显示项目名 + session 数量
   - 展开显示该项目下的所有 sessions

5. 本地存储
   - `@linkshell/projects`: 保存常用项目列表 `{ name, lastCwd, lastSessionId, lastUsedAt, pinned }`
   - 自动从连接历史中提取项目信息

### 1.5 涉及文件

| 包 | 文件 | 改动 |
|---|---|---|
| shared-protocol | `src/index.ts` | 增加 cwd/projectName 字段 |
| cli | `src/runtime/bridge-session.ts` | 发送 cwd |
| gateway | `src/sessions.ts` | 存储 cwd |
| gateway | `src/relay.ts` | 提取并广播 cwd |
| gateway | `src/index.ts` | REST API 返回 cwd |
| mobile | `src/hooks/useSession.ts` | 解析 session info 中的项目信息 |
| mobile | `src/hooks/useSessionManager.ts` | **新文件** — 多 session 管理 |
| mobile | `src/screens/HomeScreen.tsx` | 按项目展示最近连接 |
| mobile | `src/screens/SessionListScreen.tsx` | 按项目分组 |
| mobile | `src/screens/SessionScreen.tsx` | 多标签支持 |
| mobile | `src/storage/projects.ts` | **新文件** — 项目持久化 |

---

## Phase 2: 灵动岛（Dynamic Island / Live Activities）

### 2.1 技术方案

灵动岛需要原生 WidgetKit 扩展（Swift），通过 Expo Config Plugin 注入。

**架构：**
```
React Native App
    ↓ (App Groups + UserDefaults)
WidgetKit Extension (Swift)
    ↓
Dynamic Island UI (SwiftUI)
```

**通信方式：** App Groups shared UserDefaults
- App Group ID: `group.com.bd.linkshell`
- RN 侧通过 native module 写入 UserDefaults
- Widget 侧读取 UserDefaults 并更新 UI

### 2.2 灵动岛展示内容

**Compact 视图（锁屏/折叠态）：**
- 左侧：provider icon（Claude/Codex 图标）
- 右侧：当前状态文字（思考中... / 等待输入 / 运行命令...）

**Expanded 视图（展开态）：**
- 顶部：项目名 + provider
- 中间：当前 Claude 输出的最后一行（截断）
- 底部操作按钮：
  - "Yes" / "No" — 当检测到 Claude 在问 Y/N 问题时
  - "继续" — 当检测到 Claude 等待确认时
  - "查看终端" — 跳转到 app

**状态检测逻辑（解析终端输出）：**
```
- 包含 "?" 且最后一行无新输出 → 等待用户回答
- 包含 "(y/n)" 或 "[Y/n]" → Y/N 确认
- 输出持续增长 → Claude 正在输出
- 无输出 + 光标闪烁 → 等待输入
- 包含 "thinking" / "⠋⠙⠹..." → 思考中
```

### 2.3 实现步骤

**Step 1: Expo Config Plugin（注入 WidgetKit Extension）**

创建 `apps/mobile/plugins/live-activity-plugin.js`：
- 修改 Xcode project 添加 Widget Extension target
- 设置 App Group capability
- 复制 Swift 源文件到 extension 目录
- 设置 deployment target iOS 16.1+

**Step 2: Swift Widget 代码**

创建 `apps/mobile/ios-widgets/` 目录：
- `LinkShellWidgetBundle.swift` — Widget 入口
- `LinkShellLiveActivity.swift` — Live Activity 定义
- `ActivityAttributes.swift` — 数据模型
- `DynamicIslandViews.swift` — SwiftUI 视图

**ActivityAttributes 数据模型：**
```swift
struct LinkShellAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String        // "thinking", "waiting", "outputting", "idle"
        var lastLine: String      // 最后一行输出
        var projectName: String
        var provider: String
        var quickActions: [QuickAction]  // 可用的快捷操作
    }
    var sessionId: String
}

struct QuickAction: Codable, Hashable {
    var label: String   // "Yes", "No", "Continue"
    var input: String   // 发送到终端的实际输入
}
```

**Step 3: Native Module（RN ↔ ActivityKit 桥接）**

创建 `apps/mobile/ios/LinkShell/LiveActivityModule.swift`：
- `startActivity(sessionId, projectName, provider)` — 启动 Live Activity
- `updateActivity(sessionId, status, lastLine, quickActions)` — 更新状态
- `endActivity(sessionId)` — 结束 Activity
- 通过 App Groups UserDefaults 共享数据

对应的 JS 桥接：`apps/mobile/src/native/LiveActivity.ts`

**Step 4: 终端输出解析器**

`apps/mobile/src/utils/terminal-parser.ts`：
- 解析终端输出流，检测 Claude 的状态
- 识别 Y/N 问题、等待输入、思考中等状态
- 生成 quickActions 列表
- 节流更新（最多每秒更新一次灵动岛）

**Step 5: 集成到 SessionScreen**

- session 连接时启动 Live Activity
- 终端输出时通过 parser 更新状态
- 快捷操作按钮点击 → 发送 terminal.input
- session 断开时结束 Live Activity
- app 进入后台时保持 Live Activity 活跃

### 2.4 涉及文件

| 目录 | 文件 | 说明 |
|---|---|---|
| mobile/plugins/ | `live-activity-plugin.js` | **新** Expo config plugin |
| mobile/ios-widgets/ | `*.swift` (4个文件) | **新** Widget Extension 源码 |
| mobile/ios/LinkShell/ | `LiveActivityModule.swift` | **新** Native Module |
| mobile/src/native/ | `LiveActivity.ts` | **新** JS 桥接 |
| mobile/src/utils/ | `terminal-parser.ts` | **新** 输出解析器 |
| mobile/src/screens/ | `SessionScreen.tsx` | 集成 Live Activity |
| mobile/ | `app.json` | 添加 plugin 配置 |

---

## 执行顺序

```
Phase 1 (项目概念)                    Phase 2 (灵动岛)
━━━━━━━━━━━━━━━━━━                   ━━━━━━━━━━━━━━━━━
1.1 协议扩展 ──────┐
1.2 CLI 发送 cwd ──┤
1.3 Gateway 存储 ──┘
        ↓
1.4 移动端多 session ──→ 2.1 Config Plugin
        ↓                     ↓
    发布测试              2.2 Swift Widget
                              ↓
                         2.3 Native Module
                              ↓
                         2.4 输出解析器
                              ↓
                         2.5 集成 + 测试
                              ↓
                          发布 TestFlight
```

**预计工作量：**
- Phase 1: 协议 + CLI + Gateway 改动较小，移动端多 session 管理是主要工作
- Phase 2: Config Plugin + Swift 代码是主要挑战，需要处理 Expo 构建流程

**风险点：**
- Expo Config Plugin 注入 Widget Extension 可能需要调试构建问题
- Live Activity 有 4KB payload 限制，需要精简数据
- 终端输出解析是启发式的，可能误判状态
- iOS 16.1+ 才支持灵动岛，需要做版本检查
