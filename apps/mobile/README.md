# Mobile App Handoff

这个 README 只描述移动端当前实现，给下一个接手的人快速建立上下文。

## 1. 技术栈

1. Expo
2. React Native
3. React Navigation Bottom Tabs
4. react-native-safe-area-context
5. react-native-webview

## 2. 当前信息架构

底部主结构：

1. 首页
2. 中央新建连接按钮
3. 会话列表
4. 设置

全屏流转：

1. ScannerScreen 用于扫码连接
2. SessionScreen 用于终端详情页

## 3. 关键文件

1. App.tsx
   作用：应用入口、导航、连接弹层、scanner 和 session flow 切换。

2. src/theme/index.tsx
   作用：light/dark token 和主题上下文。

3. src/hooks/useSession.ts
   作用：会话连接状态、WebSocket 生命周期、终端数据。

4. src/screens/HomeScreen.tsx
   作用：首页概览和主入口。

5. src/screens/SessionListScreen.tsx
   作用：会话列表。

6. src/screens/SessionScreen.tsx
   作用：终端详情页，目前是最核心、也最容易继续调整的页面。

7. src/components/ConnectionSheet.tsx
   作用：底部新建连接 sheet，目前只保留扫码和 6 位配对码。

8. src/components/TerminalView.tsx
   作用：WebView + xterm 渲染桥接层。

9. src/components/InputBar.tsx
   作用：隐藏输入代理、系统键盘接入、快捷键入口。

10. src/components/KeyboardAccessory.tsx
    作用：iOS 键盘上方快捷工具栏。

## 4. 当前设计状态

最近设计方向已经明确：

1. 更接近 iOS 原生工具类 App，而不是夸张装饰风格。
2. 中文优先。
3. 会话页尽量克制，不要多余框体、重复操作区和伪终端 chrome。
4. 连接入口收口到中央 + 按钮，不再在首页堆大量入口。

## 5. 已知实现要点

1. 终端主题不是只改 RN 外层背景，还要同步到 WebView 内部的 xterm theme。
2. 会话页顶部、工具栏、终端背景都已经接入主题。
3. iOS 键盘工具栏的视觉连续性做过专门修正，相关 token 在 theme 里单独定义。
4. Sessions 页面已经补上顶部 safe area。

## 6. 如果继续改 UI，优先看哪里

1. src/screens/SessionScreen.tsx
2. src/components/InputBar.tsx
3. src/components/KeyboardAccessory.tsx
4. src/components/ConnectionSheet.tsx

## 7. 本地开发

```bash
pnpm install
pnpm dev:app
pnpm --filter @linkshell/app typecheck
```

如果要联调完整链路，再同时启动：

```bash
pnpm dev:gateway
pnpm --filter @linkshell/cli dev start --gateway ws://localhost:8787/ws --provider custom --command bash
```

## 8. 当前最适合下一个 AI 的切入方式

1. 先读这个文件。
2. 再读根目录 docs/ai-handoff.md。
3. 然后直接看 SessionScreen、InputBar、KeyboardAccessory 的当前实现。