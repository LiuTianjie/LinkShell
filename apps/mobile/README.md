# Mobile App Handoff

这个 README 只描述移动端当前实现，给下一个接手的人快速建立上下文。

## 1. 技术栈

1. Expo SDK 54
2. React Native 0.81.5
3. React 19.1.0
4. React Navigation Bottom Tabs
5. react-native-safe-area-context
6. react-native-webview
7. react-native-gesture-handler（Swipeable 左滑删除）
8. react-native-reanimated（配合 babel plugin）
9. expo-haptics
10. @react-native-async-storage/async-storage

## 2. 当前信息架构

底部 Tab 导航：

1. 首页 — 快速操作、继续上次会话、最近会话历史（左滑删除）
2. 会话 — 按网关分组的活动会话列表（并行拉取、骨架加载）
3. 设置 — 主题切换、网关管理

全屏流转：

1. ScannerScreen — 扫码连接
2. SessionScreen — 终端详情页
3. ConnectionSheet — 新建连接 Sheet（扫码 / 手动输入，iOS sheet detents）

## 3. 关键文件

1. App.tsx
   作用：应用入口、Tab 导航、连接弹层、scanner 和 session flow 切换。外层包裹 GestureHandlerRootView。

2. src/theme/index.tsx
   作用：完整 dark/light 主题 token 和 ThemeProvider 上下文。暗色为科技蓝绿调（#131314 bg, #adc6ff accent），浅色为 iOS 原生系统色（#f2f2f7 bg, #3a5fc8 accent）。

3. src/hooks/useSession.ts
   作用：会话连接状态、WebSocket 生命周期、终端数据、心跳、自动重连。

4. src/screens/HomeScreen.tsx
   作用：首页。标题/副标题、新建连接按钮（带 loading）、继续上次会话、最近会话列表（Swipeable 左滑删除，LayoutAnimation 过渡）。

5. src/screens/SessionListScreen.tsx
   作用：按网关分组的活动会话列表。并行从所有已保存网关拉取 /sessions，每组独立 loading 骨架、错误提示和空状态。FadeIn 动画 + LayoutAnimation 过渡。

6. src/screens/SessionScreen.tsx
   作用：终端详情页，WebView + xterm.js 渲染，是最核心也最容易继续调整的页面。

7. src/components/ConnectionSheet.tsx
   作用：新建连接 Modal。扫码/手动输入分段控制，iOS pageSheet 带 sheet detents，配对码输入 + 网关地址输入 + 连接状态反馈。

8. src/components/ServerPicker.tsx
   作用：网关服务器管理 Modal。增删改查多网关，检测可用性，设置默认。全部使用动态主题 token。

9. src/components/TerminalView.tsx
   作用：WebView + xterm 渲染桥接层。

10. src/components/InputBar.tsx
    作用：隐藏输入代理、系统键盘接入、快捷键入口。

11. src/components/KeyboardAccessory.tsx
    作用：iOS 键盘上方快捷工具栏。

12. src/storage/history.ts
    作用：AsyncStorage 历史记录管理，支持增删和按 sessionId 删除。

13. src/storage/servers.ts
    作用：AsyncStorage 网关服务器管理，支持增删改查、设置默认。

## 4. 当前设计状态

1. 整体风格为 iOS 原生工具类 App，使用 SF Symbols（expo-symbols），中文优先。
2. 完整 dark/light 主题系统，暗色为定制科技风，浅色为 iOS 系统色调。
3. 首页信息架构：标题 + 副标题 → 新建连接大按钮 → 继续上次 → 最近会话（左滑删除）。
4. 会话列表按网关分组，每组独立状态（loading / error / empty / 有数据）。
5. 新建连接入口收口到首页按钮 + ConnectionSheet，不在其他位置重复。
6. 网络加载场景有骨架动画（pulsing skeleton）和 FadeIn/LayoutAnimation 过渡。
7. ServerPicker 使用动态主题 token，无硬编码颜色。

## 5. 已知实现要点

1. 终端主题不是只改 RN 外层背景，还要同步到 WebView 内部的 xterm theme。
2. 会话页顶部、工具栏、终端背景都已接入主题。
3. iOS 键盘工具栏的视觉连续性做过专门修正，相关 token 在 theme 里单独定义。
4. RN 0.81 new arch 下 ATS（App Transport Security）需要在 Info.plist 配置 NSExceptionDomains。
5. Expo/RN runtime 不支持 AbortSignal.timeout()，使用 src/utils/fetch-with-timeout.ts 替代。
6. babel.config.js 需要 react-native-reanimated/plugin 作为最后一个 plugin。

## 6. 如果继续改 UI，优先看哪里

1. src/screens/SessionScreen.tsx（终端体验核心）
2. src/components/InputBar.tsx
3. src/components/KeyboardAccessory.tsx
4. src/components/ConnectionSheet.tsx
5. src/screens/HomeScreen.tsx

## 7. 本地开发

```bash
pnpm install
pnpm dev:app
pnpm --filter @linkshell/app typecheck
```

移动端使用 Expo development build（expo-dev-client）。Native rebuild：

```bash
cd apps/mobile && npx expo run:ios --device
```

Metro 通过 metro.config.js + symlink resolver 解析工作区依赖。

如果是 iPhone 真机调试，优先使用：

```bash
pnpm dev:ios
```

这个命令会以 LAN 模式启动 Metro，真机更容易直接连上。

本地一键原生开发构建：

```bash
pnpm devbuild:ios
pnpm devbuild:iphone
pnpm devbuild:android
```

这两个命令会自动执行：

1. 生成 terminal WebView 内嵌 HTML
2. 执行 Expo prebuild
3. 安装对应平台的 development build
4. 启动 Expo dev client 所需的 Metro

如果你只想先安装 development build，不立即启动 Metro：

```bash
pnpm --filter @linkshell/app devbuild ios --install-only
```

如果你要安装到 iPhone 真机：

```bash
pnpm devbuild:iphone
```

如果你只想给真机安装 development build，不立即启动 Metro：

```bash
pnpm devbuild:iphone:install
```

如果要把参数继续传给 Expo，例如 iOS 真机：

```bash
pnpm --filter @linkshell/app devbuild ios --device
```

推荐的真机调试流程：

1. iPhone 用数据线连到 Mac，或与 Mac 处于同一局域网
2. 首次安装开发壳运行 `pnpm devbuild:iphone`
3. 后续日常调试只运行 `pnpm dev:ios`
4. 在 iPhone 上打开 LinkShell development build，直接接收热更新

如果要联调完整链路，再同时启动：

```bash
pnpm dev:gateway
pnpm --filter linkshell-cli dev start --gateway ws://localhost:8787/ws --provider custom --command bash
```

## 8. 当前最适合下一个 AI 的切入方式

1. 先读这个文件。
2. 再读根目录 docs/ai-handoff.md。
3. 然后直接看 SessionScreen、InputBar、KeyboardAccessory 的当前实现。