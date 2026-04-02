# LinkShell AI Handoff

这个文件是给下一个接手的 AI 或开发者看的工程交接文档。目标不是重复 PRD，而是快速说明“现在代码是什么状态、从哪里进、接下来最可能继续改哪里”。

## 1. 当前仓库定位

LinkShell 是一个三段式终端桥接系统：

1. 本地 CLI：运行在用户电脑上，桥接真实 PTY 终端。
2. Gateway：部署在公网，负责配对、会话和消息转发。
3. Mobile App：Expo App，负责手机端查看和控制终端。

当前仓库已经具备可运行闭环，不是纯脚手架状态。

## 2. Monorepo 结构

```text
.
├── apps/
│   ├── mobile/                 # Expo App，当前交互迭代最频繁
│   └── web-debug/              # Web 调试端
├── packages/
│   ├── cli/                    # 本地桥接 CLI
│   ├── gateway/                # 网关服务
│   └── shared-protocol/        # 三端共享协议
├── docs/
│   ├── ai-handoff.md           # 当前文件
│   ├── deploy.md               # 部署文档
│   ├── user-guide.md           # 用户视角使用文档
│   └── site/                   # 落地页静态资源
├── README.md                   # 仓库级说明
└── PRD.md                      # 产品和系统设计背景
```

## 3. 现在最值得关注的部分

### 3.1 Mobile App

当前活跃开发重点在 apps/mobile。

技术栈：Expo SDK 54 + React Native 0.81.5 + React 19.1.0。

已经完成的方向：

1. 主导航为 首页 / 会话 / 设置 三个 Tab。
2. 新建连接入口收口到首页按钮 + ConnectionSheet（Modal，iOS sheet detents）。
3. 首页：标题/副标题、新建连接按钮、继续上次会话、最近会话历史（Swipeable 左滑删除，LayoutAnimation 过渡）。
4. 会话列表：按网关分组（并行拉取所有已保存网关的 /sessions），骨架加载动画、FadeIn 过渡、错误与空状态。
5. ConnectionSheet：扫码/手动输入分段控制、iOS pageSheet + sheet detents。
6. ServerPicker：多网关管理、检测、默认设置、全部主题化。
7. 完整 dark/light 主题系统：暗色科技风 + 浅色 iOS 系统风。
8. 集成 react-native-gesture-handler + react-native-reanimated。
9. 页面语言全部中文化。
10. 所有页面 safe area 修正完毕。

仍然最可能继续改的区域：

1. apps/mobile/src/screens/SessionScreen.tsx（终端体验核心）
2. apps/mobile/src/components/InputBar.tsx
3. apps/mobile/src/components/KeyboardAccessory.tsx
4. apps/mobile/src/components/ConnectionSheet.tsx
5. apps/mobile/src/screens/HomeScreen.tsx
6. apps/mobile/src/screens/SessionListScreen.tsx

移动端更详细说明见 apps/mobile/README.md。

### 3.2 Gateway

Gateway 现在已经能提供最小可用闭环：

1. 健康检查。
2. pairing 创建与 claim。
3. 活跃会话列表。
4. WebSocket host/client 转发。
5. 控制权相关消息流。

现阶段仍偏内存态实现，更适合开发和单实例部署。

### 3.3 CLI

CLI 当前已经能：

1. 启动 provider 或 custom command。
2. 连接 gateway。
3. 打印 pairing code 和二维码。
4. 发送终端输入、输出、尺寸变化。

后续如果要继续做稳定性，优先看 runtime 目录。

## 4. 关键入口文件

### 仓库入口

1. package.json
2. README.md
3. PRD.md

### Mobile

1. apps/mobile/App.tsx
2. apps/mobile/src/theme/index.tsx
3. apps/mobile/src/hooks/useSession.ts

### CLI

1. packages/cli/src/index.ts
2. packages/cli/src/runtime/bridge-session.ts
3. packages/cli/src/runtime/scrollback.ts
4. packages/cli/src/providers.ts

### Gateway

1. packages/gateway/src/index.ts
2. packages/gateway/src/pairings.ts
3. packages/gateway/src/sessions.ts
4. packages/gateway/src/relay.ts

### Protocol

1. packages/shared-protocol/src/index.ts

## 5. 常用命令

安装依赖：

```bash
pnpm install
```

整体类型检查：

```bash
pnpm typecheck
```

本地开发：

```bash
pnpm dev:gateway
pnpm dev:web
pnpm dev:app
```

CLI 联调：

```bash
pnpm --filter linkshell-cli dev start --gateway ws://localhost:8787/ws --provider custom --command bash
```

移动端单独类型检查：

```bash
pnpm --filter @linkshell/app typecheck
```

## 6. 当前约定

1. 使用 pnpm workspace。
2. TypeScript 为主。
3. Mobile 端主题统一从 apps/mobile/src/theme/index.tsx 读取，dark/light 均有完整独立配色。
4. Mobile UI 风格为 iOS 原生工具类 App，使用 SF Symbols，中文优先，避免多余装饰。
5. 新建连接入口已收口到首页按钮 + ConnectionSheet，不在其他位置重复。
6. 网络加载统一使用骨架动画 + FadeIn/LayoutAnimation 过渡。
7. 所有组件使用 useTheme() 动态主题 token，不硬编码颜色。
8. Expo/RN runtime 不支持 AbortSignal.timeout()，统一使用 src/utils/fetch-with-timeout.ts。

## 7. 最近移动端 UI 调整摘要

1. 首页重写：标题/副标题、新建连接按钮（带 loading 状态）、继续上次会话卡片、最近会话列表（react-native-gesture-handler Swipeable 左滑删除，LayoutAnimation 过渡）。
2. 会话列表重写：按网关分组（并行拉取所有已保存网关），每组独立 loading 骨架（pulsing skeleton）、错误提示、空状态，FadeIn 动画 + LayoutAnimation 过渡。
3. ConnectionSheet 重写：pageSheet + iOS sheet detents（scan 0.55/0.7、manual 0.7/large），扫码/手动分段控制，配对码 + 网关地址输入，状态反馈。
4. ServerPicker 全面主题化：移除全部硬编码颜色（~200 行 StyleSheet），改用 useTheme() 动态 token + 内联样式。
5. 完整 dark/light 主题系统：lightTheme 不再是 darkTheme 的 spread copy，有独立的 iOS 系统色配色方案。
6. 集成 react-native-gesture-handler + react-native-reanimated（含 babel.config.js plugin）。
7. App.tsx 外层包裹 GestureHandlerRootView。
8. 历史记录支持按 sessionId 去重和删除。
9. 所有页面 safe area 修正（使用 useSafeAreaInsets + paddingTop: insets.top + 2）。
10. useSession.ts 清理了调试用的 httpbin 诊断日志。

## 8. 如果下一个 AI 要继续做什么

推荐顺序：

1. 先读 README.md。
2. 再读 apps/mobile/README.md。
3. 如果是改终端体验，再看 apps/mobile/src/screens/SessionScreen.tsx 和相关组件。
4. 如果是改协议或稳定性，再看 packages/shared-protocol 和 packages/cli、packages/gateway 的 runtime。
5. PRD.md 只在需要产品背景和长期方向时再读，不适合拿来做快速进入点。