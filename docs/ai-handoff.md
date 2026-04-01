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

已经完成的方向：

1. 主导航重构为 首页 / 中央新建 / 会话 / 设置。
2. 新建连接入口收口到全局底部 + 按钮。
3. 会话详情页做过多轮安全区、主题、输入法工具栏和终端样式修正。
4. 页面整体语言已逐步切到中文。
5. 会话列表、设置页、首页都做过一轮新的信息架构整理。

仍然最可能继续改的区域：

1. apps/mobile/src/screens/SessionScreen.tsx
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
pnpm --filter @linkshell/cli dev start --gateway ws://localhost:8787/ws --provider custom --command bash
```

移动端单独类型检查：

```bash
pnpm --filter @linkshell/app typecheck
```

## 6. 当前约定

1. 使用 pnpm workspace。
2. TypeScript 为主。
3. Mobile 端主题统一从 apps/mobile/src/theme/index.tsx 读取。
4. Mobile UI 近期设计方向是“更像 iOS 原生的终端工具”，避免多余装饰。
5. 新建连接入口已经收口，不建议再把 gateway 管理和会话列表塞回连接弹窗。

## 7. 最近一轮移动端 UI 调整摘要

1. 会话页顶部和终端区域支持 light/dark 主题联动。
2. terminal WebView 内部 xterm theme 已与主题同步。
3. 输入法工具栏和系统键盘的衔接样式做过一轮修正。
4. tab bar 不再使用英文文字图标。
5. Sessions 页面补了 safe area 并做了中文化。
6. ConnectionSheet 收敛为“扫码 + 6 位配对码”两种入口。

## 8. 如果下一个 AI 要继续做什么

推荐顺序：

1. 先读 README.md。
2. 再读 apps/mobile/README.md。
3. 如果是改终端体验，再看 apps/mobile/src/screens/SessionScreen.tsx 和相关组件。
4. 如果是改协议或稳定性，再看 packages/shared-protocol 和 packages/cli、packages/gateway 的 runtime。
5. PRD.md 只在需要产品背景和长期方向时再读，不适合拿来做快速进入点。