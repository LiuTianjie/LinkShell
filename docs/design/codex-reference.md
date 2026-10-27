# Codex / Claude 桌面版逆向参考（2026-10-27）

用 REA 静态分析本机安装的 Codex（`/Applications/ChatGPT.app`，bundle id `com.openai.codex`，26.1021.31345）和 Claude（`/Applications/Claude.app`，3.6556.2）。没有执行它们的代码，没有做运行时截图。下列数值来自它们 asar 里的构建产物，是这一个版本的快照。

## 技术栈

| | Codex | Claude |
| --- | --- | --- |
| 运行时 | OWL：OpenAI 自研 Chromium 壳，提供 Electron 兼容 API（`owl-electron-app.json` `runtimeName: "owl"`）；Chromium 156、Node 24.22 | Electron 44.9.3（Chrome 152） |
| 打包 | Electron Forge + Vite（Rolldown） | Electron Forge 8 + Vite |
| 界面来源 | 本地 `app://`，严格 CSP | 本地只画标题栏和错误页；主体（含 Code 标签）是远程 claude.ai，装在透明 `WebContentsView` 里 |
| React | 19.2.7 + React Compiler，React Router | 19.2.4 + React Compiler |
| 状态 | 自研原子 store（类 jotai）+ `useSyncExternalStore`，TanStack Query | zustand + TanStack Query |
| 样式 | Tailwind 4.3.3 + CSS Modules，`@layer`，`color-mix(in oklab)` | Tailwind 4.3.3 + 自有令牌 CDS |
| 组件 | Radix、cmdk、sonner、floating-ui | Radix、cmdk |
| 动画 | Motion（framer-motion 系） | Motion |
| 富文本 | unified/remark 自定义渲染、KaTeX、Mermaid；Shiki；ProseMirror 输入框；CodeMirror | unified/rehype、KaTeX、Mermaid；Shiki（worker）；Tiptap |
| 终端 | xterm.js + node-pty | xterm.js（WebGL）+ node-pty，在 `utilityProcess` 里 |
| 列表虚拟化 | 只在 diff 与文件树；对话不虚拟化 | TanStack Virtual |
| 原生 | Sparkle（`sparkle.node`）、better-sqlite3、objc-js、若干 Swift 小工具 | `swift_addon.node`（ScreenCaptureKit、Virtualization）、Rust napi 插件 |
| IPC | preload 暴露 `electronBridge`，一条消息总线；主题、初始侧栏数据在启动时同步取，首帧不等待 | 生成的强类型 IPC，约 1210 个方法 |

两家都是 Web 界面。它们比我们顺滑的原因是 Chromium 运行时、窗口层集成和下文这些工程细节，不在于"不是 Web"。

## Codex 窗口

- macOS：`titleBarStyle: 'hiddenInset'`，`trafficLightPosition: {x: 16, y: round((44·zoom − 14) / 2)}`（缩放 1 时 y = 15），`vibrancy: 'menu'`，`acceptFirstMouse: true`，`backgroundColor: '#00000000'`。
- 默认 1280×820，最小 480×600，恢复上次位置。
- 以下情况关闭 vibrancy，`<html>` 加 `.electron-opaque`，底色改用浅 `#f9f9f9` / 深 `#000`：窗口失焦、物理分辨率 ≥ 3840×2160（为性能）、用户开启"不透明窗口"。
- Windows / Linux：`titleBarStyle: 'hidden'` + `titleBarOverlay`，高 36·zoom；Windows 11 用 `mica`。
- `webPreferences`：`contextIsolation`、无 `nodeIntegration`、`scrollBounce: true`、`spellcheck: true`。
- 缩放用 CSS `zoom: var(--codex-window-zoom)`。

## Codex 设计令牌

来自 `webview/assets/app-shared-*.css`。

### 颜色

灰阶 `--gray-fixed-*`：0 `#fff`、50 `#f9f9f9`、75 `#f3f3f3`、100 `#ededed`、150 `#dfdfdf`、200 `#cdcdcd`、300 `#afafaf`、400 `#8f8f8f`、500 `#5d5d5d`、600 `#414141`、700 `#303030`、750 `#282828`、800 `#212121`、900 `#181818`、950 `#131313`、1000 `#0d0d0d`。

强调色：蓝 300 `#339cff` / 400 `#0285ff` / 500 `#0169cc`；绿 300 `#40c977` / 500 `#00a240`；红 400 `#fa423e` / 500 `#e02e2a`；橙 300 `#ff8549` / 500 `#e25507`；紫 300 `#ad7bf9`。

| 语义 | 浅色 | 深色 |
| --- | --- | --- |
| 文字 | `#1a1c1f` | `#dfdfdf` |
| 次级 / 三级文字 | 文字 70% / 50% | 白 70% / 50% |
| 主区表面 | `#fff` | `#181818` |
| 窗口底（不透明时） | `#f9f9f9` | `#000` |
| 侧栏（叠在 vibrancy 上） | `#ededed` 40% | `#212121` 同比 |
| 浮层（菜单、弹出） | `#fff` 70% | `#212121` 96% |
| 边框 / 重 / 轻 | 文字 8% / 12% / 5% | 白 8% / 16% / 4% |
| 次按钮底 / 悬停 / 按下 | 文字 5% / 5% / 4% | 白 5% / 8% / 12% |
| 幽灵按钮悬停 / 按下 | 文字 10% / 20% | 白 7% / 10% |
| 主按钮 | `#1a1c1f` 底白字 | `#0d0d0d` 底白字 |
| 强调、链接、焦点环 | `#339cff` | 焦点环 70% |
| 用户消息气泡 | 文字 5% | 文字 5% |
| diff 增 / 删 | 绿 500 / 红 600 15% | 绿 300 / 红 400 23% |

代码高亮（浅 / 深）：关键字 `#ab4f7a` / `#f8a6c8`，字符串 `#3a843f` / `#83d197`，名称 `#1f4e94` / `#63a8f8`，字面量 `#ac4f23` / `#f1a275`，变量 `#643cae` / `#b897f4`。主题由 preload 在首帧前写到 `<html data-theme>`。

### 字体

- 界面用系统字体 `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`；等宽 `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`。OpenAI Sans 只用于引导页和对话框。
- 正文 14px / 1.5；对话 14px；代码 12px；diff 行高 12px × 1.8。字号阶梯 11 / 12 / 14 / 16 / 18 / 28 / 36。
- 字重 400 / 500 / 600 / 700，另有为 SF 调的 510、590。例：控件标签 13px / 510 / −0.08px / 行高 18px。
- `-webkit-font-smoothing: antialiased`，`font-synthesis-weight: none`。

### 间距、圆角、阴影

- 基础单位 4px。面板内边距 20px，工具栏 16px。
- 圆角基数：xs 4、sm 6、md 8、lg 10、xl 12、2xl 16、3xl 20、4xl 24。支持 `corner-shape: superellipse(1.5)` 时 md 及以上 ×1.25（这是 Chromium 才有的属性，WebKit 没有）。
- 输入框圆角 22px；侧栏行圆角 10px。
- 发丝线 1px，Retina 上 0.5px；浅 `#00000014`，深 `#ffffff1a`。
- 阴影：sm `0 1px 2px -1px #00000014`；md `0 2px 4px -1px #00000014`；lg `0 4px 8px -2px #0000001a`；xl `0 8px 16px -4px #0000001f`；输入框 `0 0 0 1px #0000000a, 0 2px 8px #0000000a, 0 4px 80px 8px #00000006`（深色改为 `inset 0 0 1px #fff3`）。

### 动效

- 时长：basic 150ms、moderate 200ms、relaxed 300ms。默认过渡 150ms `cubic-bezier(.4, 0, .2, 1)`。
- 曲线：enter `cubic-bezier(.19, 1, .22, 1)`；exit `(.8, 0, .4, 1)`；move `(.65, 0, .35, 1)`；snappy `(.23, 1, .32, 1)`；card `(.16, 1, .3, 1)`；snappy 弹簧 `linear(0, .086, .2539, .428, .5786, .698, .7879, .8534, .8998, .9323, .9546, .9697, .98, .9868, .9913, .9943, .9963, .9976, .9985, 1)`。
- 侧栏收起：Motion 弹簧 `{duration: 0.3, bounce: 0.1}` 驱动一个 0→1 的 motion value，宽度和透明度从它派生，逐帧不触发 React 重渲染。悬停探出 0.12s `[0, 0, .58, 1]`。侧 / 底面板弹簧 `{duration: 0.5, bounce: 0.1}`。遵守减少动态效果。
- 流式 Markdown：块从透明到不透明，`cubic-bezier(.37, .55, .86, .88)`，每段 `--fade-delay` 错开；150ms，自适应流式时 700ms。图片 scale .98→1。
- 加载文字：裁到文字上的微光，2s `steps(48)`。

## Codex 的顺滑手法

1. **自适应流式缓冲**（最关键）。网络块和绘制分开：
   - 到达速率取指数滑动平均（新 0.1 + 旧 0.9，字符/秒）；
   - 每 50ms 按积压量放字，速率朝"积压 × 1.5"或"积压 / 1.2"调整，小数字符累计到下次；
   - 每个 `requestAnimationFrame` 最多发布一次，组件经 `useSyncExternalStore` 读取；
   - 窗口隐藏时暂停。
2. **贴底滚动**，自己写的：
   - 容器 `overflow-anchor: none`、`overscroll-behavior-y: contain`、`scrollbar-gutter: stable both-edges`，`scroll-padding-bottom` = 实测底栏高度 + 16px；
   - 离底 24px 内算"在底部"；
   - 内容变高时在 `useLayoutEffect` 里的 `ResizeObserver` 修正滚动，不跳；
   - 从 wheel、pointer、touch 读用户意图（8px 容差），方向保持 1s；
   - 回到底部是 260ms 的逐帧补间，ease-out `1 − (1 − t)³`。
3. 菜单行 `content-visibility: auto`，代码视图 `contain`，`will-change` 用得很少。

## Codex 布局

- 工具栏 46px（窗口计算用 44px）。
- 侧栏宽 `clamp(240px, 275px, min(520px, 100vw − 320px))`，拖动默认 340px；窗口窄于 768px 时隐藏。行高 30px，圆角 10px，水平内边距 8px，图标 16px。侧栏半透明叠在 vibrancy 上。
- 主区不透明，0.5px 分隔线，裁成 12px 圆角。
- 对话列最宽 48rem（768px）居中，宽块可到 56rem；顶部留 32px，条目间距 16px。
- 输入框悬浮在底部、离边 16px，上方有渐隐；浮层次级表面、22px 圆角、输入框阴影；最低 44px，按钮 28px。
- 右侧面板（diff、终端、浏览器、文件）在分栏工作区里停靠。

## Claude 的可参考值

- 窗口：`titleBarStyle: 'hidden'`，红绿灯 (17, 17) 居中在 24px 标题行；默认不透明，页面通过 IPC 再开 `vibrancy: 'sidebar'`。底色浅 `#fcfcfb` / 深 `#151515`，或页面上次上报的颜色。
- 暖灰：10 `#fcfcfb`、20 `#f9f9f7`、50 `#f0efec`、200 `#c3c2b7`、600 `#52514e`、800 `#20201f`、850 `#151515`、900 `#0b0b0b`；品牌色 `#d97757`。
- 动效时长 60 / 120 / 200 / 300 / 450ms；曲线 `(.165, .84, .44, 1)`、`(.32, .72, 0, 1)`，回弹 `(.34, 1.3, .64, 1)`。
- 本地壳 HTML 里放了骨架侧栏，远程页面画完前显示它。透明 `WebContentsView` 叠在壳上，避免白屏。

## 没能确定的

- OWL 对应的 Electron API 版本；Motion、xterm、Shiki、Radix 的精确版本。
- 运行时才看得到的东西：vibrancy 的实际观感、帧耗时。没有截图，以免碰用户真实的 Codex / Claude 资料。
- Codex 的设置、审阅、浏览器页只抽样看过。
