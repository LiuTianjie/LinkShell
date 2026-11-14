import type { Locale } from "@linkshell/client-core";
import { fileManagerLabel, getDesktopLocale, revealInFilesLabel } from "../../core/i18n";
import type {
  ScreenCodecChoice,
  ScreenFpsChoice,
  ScreenPacingChoice,
  ScreenWidthChoice,
} from "../../core/screen-client";

export type FusionCategoryKey =
  | "all"
  | "running"
  | "developer"
  | "productivity"
  | "utilities"
  | "social"
  | "entertainment"
  | "creative"
  | "other";

export type FusionAlertCopyKind =
  | "accessibility"
  | "recording"
  | "locked"
  | "webrtc"
  | "launch"
  | "stub"
  | "disconnected"
  | "generic";

export interface RemoteCopy {
  fullDesktop: string;
  fusionMode: string;
  modeSwitchLabel: string;
  fusionActiveShort: string;
  fusionOpenHub: string;
  fusionConnecting: string;
  fusionStart: string;
  fusionDisconnect: string;
  fusionToolbarLabel: string;
  fusionSearchPlaceholder: string;
  fusionClearSearch: string;
  fusionRefreshCatalog: string;
  fusionHubNotRunningReason: string;
  fusionRevealStubs: string;
  fusionRevealAppStub: string;
  fusionDirect: string;
  fusionTunnel: string;
  fusionActiveWindowsTitle: string;
  fusionCatalogTitle: string;
  fusionCategoriesLabel: string;
  fusionHeroTitle: string;
  fusionHeroDesc: string;
  fusionSyncingCatalog: string;
  fusionPausedHint: string;
  fusionOfflineCatalogHint: string;
  fusionNoMatchingAppsTitle: string;
  fusionNoMatchingAppsDesc: string;
  fusionUnsupportedTitle: string;
  fusionSwitchToScreen: string;
  fusionNewLocalSession: string;
  fusionLaunchApp: string;
  fusionActivateApp: string;
  fusionQuitApp: string;
  fusionForceQuitApp: string;
  fusionForceQuitConfirmTitle: (appName: string) => string;
  fusionForceQuitConfirmDesc: (appName: string) => string;
  fusionWindowCount: (count: number) => string;
  fusionAppsCount: (count: number) => string;
  fusionRunningLabel: string;
  fusionPermissionTitle: string;
  fusionPermissionDesc: string;
  fusionPermissionSteps: [string, string, string];
  fusionLockedTitle: string;
  fusionLockedDesc: string;
  fusionOutdatedTitle: string;
  fusionOutdatedDesc: string;
  fusionConnectionErrorTitle: string;
  fusionRetry: string;
  fusionCheckPermissions: string;
  fusionOffTitle: string;
  fusionOffDesc: string;
  fusionReconnecting: (attempt: number, max: number) => string;
  fusionAlertsLabel: string;
  fusionAlerts: Record<FusionAlertCopyKind, { title: string; remedy: string }>;
  categories: Record<FusionCategoryKey, string>;

  /* Unified Remote Screen */
  navBack: string;
  navForward: string;
  screenHeaderTitle: string;
  screenToolbarLabel: string;
  screenStart: string;
  screenDisconnect: string;
  screenReconnect: string;
  screenDisplayLabel: string;
  screenQualityButton: string;
  screenQualityTitle: string;
  screenClarityLabel: string;
  screenFpsLabel: string;
  screenCodecLabel: string;
  screenPacingLabel: string;
  screenTransportModeLabel: string;
  screenTransportAuto: string;
  screenTransportCompat: string;
  screenDisplayCapHint: (fps: string) => string;
  screenControlActive: string;
  screenControlViewOnly: string;
  screenControlRequesting: string;
  screenControlUnavailableReason: string;
  screenKeysCaptureLabel: string;
  screenKeysCapturedOn: string;
  screenKeysCapturedOff: string;
  screenToolsLabel: string;
  screenPasteToRemote: string;
  screenCopyFromRemote: string;
  screenPrivacySection: string;
  screenPrivacyCurtain: string;
  screenLockOnDisconnect: string;
  screenClipboardSynced: string;
  screenClipboardEmpty: string;
  screenClipboardFailed: string;
  screenCurtainEnabledNote: string;
  screenCurtainDisabledNote: string;
  screenTelemetryLabel: string;
  screenTelemetryTitle: string;
  screenMetricEngine: string;
  screenMetricPath: string;
  screenMetricResolution: string;
  screenMetricFps: string;
  screenMetricCodec: string;
  screenMetricBitrate: string;
  screenMetricRtt: string;
  screenMetricDecode: string;
  screenEngineMetal: string;
  screenEngineWebRtc: string;
  screenEngineCompat: string;
  screenPathDirect: string;
  screenPathLan: string;
  screenPathTurn: string;
  screenPathRelay: string;
  screenDecodeHardware: string;
  screenDecodeSoftware: string;
  screenFullscreenEnter: string;
  screenFullscreenExit: string;
  screenReadyTitle: string;
  screenReadyDesc: string;
  screenConnectingTitle: string;
  screenConnectingDesc: string;
  screenRetryingTitle: string;
  screenIdlePausedTitle: string;
  screenIdlePausedDesc: string;
  screenTakenTitle: string;
  screenTakenDesc: string;
  screenPermissionTitle: string;
  screenPermissionDesc: string;
  screenUnsupportedTitle: string;
  screenUnsupportedDesc: string;
  screenOfflineTitle: string;
  screenOfflineDesc: string;
  screenFallbackBanner: string;
  screenTryNativeAgain: string;
  clarityChoices: Record<ScreenWidthChoice, string>;
  fpsChoices: Record<ScreenFpsChoice, string>;
  codecChoices: Record<ScreenCodecChoice, string>;
  pacingChoices: Record<ScreenPacingChoice, string>;
}

const ZH_COPY = (locale: Locale): RemoteCopy => ({
  fullDesktop: "完整桌面",
  fusionMode: "融合模式",
  modeSwitchLabel: "远程视图模式",
  fusionActiveShort: "融合中",
  fusionOpenHub: "融合启动台",
  fusionConnecting: "连接中",
  fusionStart: "开启融合模式",
  fusionDisconnect: "断开融合",
  fusionToolbarLabel: "融合模式工具栏",
  fusionSearchPlaceholder: "搜索应用名称",
  fusionClearSearch: "清空搜索",
  fusionRefreshCatalog: "刷新应用目录",
  fusionHubNotRunningReason: "开启融合模式后可实时同步远端应用列表",
  fusionRevealStubs: `打开替身目录 (${fileManagerLabel(locale)})`,
  fusionRevealAppStub: revealInFilesLabel(locale),
  fusionDirect: "直连",
  fusionTunnel: "加密隧道",
  fusionActiveWindowsTitle: "运行中的融合窗口",
  fusionCatalogTitle: "远端应用目录",
  fusionCategoriesLabel: "应用分类",
  fusionHeroTitle: "将远端 Mac 应用无缝投射到本机桌面",
  fusionHeroDesc:
    "无需传输整张壁纸：远端应用直接出现在本机程序坞与 ⌘Tab 中，拥有独立窗口阴影、剪贴板协同与最高 120Hz 原生渲染。",
  fusionSyncingCatalog: "正在同步远端应用目录",
  fusionPausedHint: "融合连接已暂停，点击上方「开启融合模式」即可恢复。",
  fusionOfflineCatalogHint: "当前显示上次缓存的远端应用目录，点击任意应用即可自动连接并启动。",
  fusionNoMatchingAppsTitle: "未找到匹配的应用",
  fusionNoMatchingAppsDesc: "请尝试其他关键词，或切换至「全部」分类查看完整应用目录。",
  fusionUnsupportedTitle: "当前环境暂不支持融合模式",
  fusionSwitchToScreen: "切换至完整桌面",
  fusionNewLocalSession: "新建本地会话",
  fusionLaunchApp: "启动应用",
  fusionActivateApp: "前置窗口",
  fusionQuitApp: "退出应用",
  fusionForceQuitApp: "强制退出",
  fusionForceQuitConfirmTitle: (appName) => `强制退出「${appName}」？`,
  fusionForceQuitConfirmDesc: (appName) =>
    `远端 Mac 上的「${appName}」将立即终止，未保存的更改可能会丢失。`,
  fusionWindowCount: (count) => `${count} 个窗口`,
  fusionAppsCount: (count) => `${count} 款应用`,
  fusionRunningLabel: "运行中",
  fusionPermissionTitle: "需要远端 Mac 授权屏幕录制",
  fusionPermissionDesc: "融合模式需要远端 LinkShell.app 拥有屏幕录制与辅助功能权限才能捕获独立应用窗口。",
  fusionPermissionSteps: [
    "在远端 Mac 打开「系统设置 → 隐私与安全性 → 屏幕录制」",
    "开启 LinkShell 的开关（如已开启，请关闭后重新打开）",
    "同时确认「辅助功能」已允许 LinkShell 控制键鼠输入",
  ],
  fusionLockedTitle: "远端电脑已锁屏",
  fusionLockedDesc: "请先切换至「完整桌面」解锁远端 Mac，然后再启动融合应用窗口。",
  fusionOutdatedTitle: "远端 LinkShell 服务版本较旧",
  fusionOutdatedDesc: "请先升级远端 Mac 上的 LinkShell 至最新版本以支持应用级融合模式。",
  fusionConnectionErrorTitle: "融合模式连接异常",
  fusionRetry: "重新连接",
  fusionCheckPermissions: "请求远端权限检查",
  fusionOffTitle: "融合模式未开启",
  fusionOffDesc: "开启后，远端 Mac 的应用会以独立窗口出现在这台 Mac 的程序坞和 ⌘Tab 中。",
  fusionReconnecting: (attempt, max) => `连接中断，正在重新连接（第 ${attempt}/${max} 次）`,
  fusionAlertsLabel: "融合模式提示",
  fusionAlerts: {
    accessibility: { title: "远端 Mac 未授权辅助功能", remedy: "在远端 Mac 打开「系统设置 › 隐私与安全性 › 辅助功能」，允许 LinkShell，然后重新开启融合模式。" },
    recording: { title: "远端 Mac 未授权屏幕录制", remedy: "在远端 Mac 打开「系统设置 › 隐私与安全性 › 屏幕录制」，允许 LinkShell，然后重新开启融合模式。" },
    locked: { title: "远端 Mac 已锁屏", remedy: "切换到「完整桌面」解锁远端 Mac，融合窗口随后恢复正常。" },
    webrtc: { title: "窗口画面连接失败", remedy: "当前网络无法建立窗口画面直连。请确认两台电脑网络畅通，或重新开启融合模式。" },
    launch: { title: "远端应用无法打开", remedy: "确认该应用仍安装在远端 Mac 上，然后重试。" },
    stub: { title: "本机融合应用反复退出", remedy: "远端应用仍在运行。可在下方重新打开该应用，或断开后重新开启融合模式。" },
    disconnected: { title: "融合连接已断开", remedy: "检查远端 Mac 是否睡眠或离线，然后重新开启融合模式。" },
    generic: { title: "融合模式出现问题", remedy: "可尝试重新开启融合模式。" },
  },
  categories: {
    all: "全部",
    running: "运行中",
    developer: "开发工具",
    productivity: "效率",
    utilities: "实用工具",
    social: "社交",
    entertainment: "娱乐",
    creative: "创意",
    other: "其他",
  },

  navBack: "后退",
  navForward: "前进",
  screenHeaderTitle: "远程屏幕",
  screenToolbarLabel: "远程屏幕控制栏",
  screenStart: "连接桌面画面",
  screenDisconnect: "断开画面",
  screenReconnect: "重新连接",
  screenDisplayLabel: "显示器",
  screenQualityButton: "画质",
  screenQualityTitle: "画面与编码设置",
  screenClarityLabel: "画面清晰度",
  screenFpsLabel: "帧率上限",
  screenCodecLabel: "视频编码",
  screenPacingLabel: "画面节奏",
  screenTransportModeLabel: "传输通道",
  screenTransportAuto: "自动 (优先低延迟视频流)",
  screenTransportCompat: "兼容模式 (加密字节流)",
  screenDisplayCapHint: (fps) => `受本机显示器刷新率限制，当前按 ${fps} Hz 输出`,
  screenControlActive: "键鼠控制中",
  screenControlViewOnly: "仅观看",
  screenControlRequesting: "请求控制中",
  screenControlUnavailableReason: "远端电脑尚未授予辅助功能控制权限，当前仅支持观看画面",
  screenKeysCaptureLabel: "系统快捷键转发",
  screenKeysCapturedOn: "系统快捷键已转发至远端",
  screenKeysCapturedOff: "保留系统快捷键给本机",
  screenToolsLabel: "剪贴板与隐私",
  screenPasteToRemote: "发送本机剪贴板至远端",
  screenCopyFromRemote: "读取远端剪贴板至本机",
  screenPrivacySection: "远端隐私保护",
  screenPrivacyCurtain: "开启远端隐私黑屏",
  screenLockOnDisconnect: "断开连接时自动锁屏",
  screenClipboardSynced: "剪贴板已同步",
  screenClipboardEmpty: "剪贴板为空",
  screenClipboardFailed: "无法访问剪贴板",
  screenCurtainEnabledNote: "已开启远端物理显示器隐私黑屏",
  screenCurtainDisabledNote: "已恢复远端物理显示器画面",
  screenTelemetryLabel: "链路指标",
  screenTelemetryTitle: "实时传输诊断",
  screenMetricEngine: "渲染管线",
  screenMetricPath: "网络路径",
  screenMetricResolution: "实时分辨率",
  screenMetricFps: "实时帧率",
  screenMetricCodec: "解码格式",
  screenMetricBitrate: "传输码率",
  screenMetricRtt: "往返延迟",
  screenMetricDecode: "解码加速",
  screenEngineMetal: "原生 Metal",
  screenEngineWebRtc: "WebRTC 视频轨",
  screenEngineCompat: "加密字节流",
  screenPathDirect: "P2P 直连",
  screenPathLan: "局域网直连",
  screenPathTurn: "TURN 中继",
  screenPathRelay: "网关加密中继",
  screenDecodeHardware: "硬件加速",
  screenDecodeSoftware: "软件解码",
  screenFullscreenEnter: "全屏观看",
  screenFullscreenExit: "退出全屏",
  screenReadyTitle: "准备连接远程桌面",
  screenReadyDesc: "连接后可低延迟观看并操控远端桌面画面。",
  screenConnectingTitle: "正在建立远程画面连接",
  screenConnectingDesc: "正在协商最优端到端加密传输路径",
  screenRetryingTitle: "网络波动，正在自动重连画面",
  screenIdlePausedTitle: "画面已因空闲自动休眠",
  screenIdlePausedDesc: "为节省中继带宽，无人操作一段时间后画面已暂停，点击即可立即恢复。",
  screenTakenTitle: "画面已在其他窗口打开",
  screenTakenDesc: "另一台设备或窗口接管了远程画面，点击可重新接管至当前窗口。",
  screenPermissionTitle: "需要远端电脑授权屏幕录制",
  screenPermissionDesc: "请在远端电脑的系统隐私设置中允许 LinkShell 录制屏幕，完成后点击重新连接。",
  screenUnsupportedTitle: "此电脑当前不支持远程屏幕",
  screenUnsupportedDesc: "请确认远端电脑运行在图形桌面会话中并已安装桌面屏幕组件。",
  screenOfflineTitle: "远端电脑当前离线",
  screenOfflineDesc: "等待远端电脑重新上线后即可连接桌面画面。",
  screenFallbackBanner: "原生直连受网络限制，已自动切换至兼容通道",
  screenTryNativeAgain: "重试原生 Metal",
  clarityChoices: {
    auto: "随窗口自动适配",
    "1280": "1280p (省带宽)",
    "1600": "1600p (均衡)",
    "1920": "1080p (标准)",
    "2560": "1440p (高清)",
    "3200": "3200p (超清)",
    native: "原生物理分辨率",
  },
  fpsChoices: {
    "30": "30 FPS",
    "60": "60 FPS",
    "120": "120 FPS (高刷)",
  },
  codecChoices: {
    auto: "自动 (优先 HEVC)",
    h264: "兼容 H.264",
  },
  pacingChoices: {
    immediate: "最低延迟 (跟手优先)",
    smooth: "平滑防抖 (Wi-Fi 稳帧)",
  },
});

const EN_COPY = (locale: Locale): RemoteCopy => ({
  fullDesktop: "Full Desktop",
  fusionMode: "Fusion Mode",
  modeSwitchLabel: "Remote view mode",
  fusionActiveShort: "Fused",
  fusionOpenHub: "Fusion Hub",
  fusionConnecting: "Connecting",
  fusionStart: "Start Fusion Mode",
  fusionDisconnect: "Disconnect Fusion",
  fusionToolbarLabel: "Fusion Mode toolbar",
  fusionSearchPlaceholder: "Search remote apps",
  fusionClearSearch: "Clear search",
  fusionRefreshCatalog: "Refresh catalog",
  fusionHubNotRunningReason: "Start Fusion Mode to sync live remote apps",
  fusionRevealStubs: `Reveal Stub Folder (${fileManagerLabel(locale)})`,
  fusionRevealAppStub: revealInFilesLabel(locale),
  fusionDirect: "Direct",
  fusionTunnel: "E2E Tunnel",
  fusionActiveWindowsTitle: "Active Fused Windows",
  fusionCatalogTitle: "Remote Applications",
  fusionCategoriesLabel: "Application categories",
  fusionHeroTitle: "Project remote Mac apps onto this Mac",
  fusionHeroDesc:
    "Skip streaming the whole desktop: remote macOS windows appear natively in your local Dock and ⌘Tab with per-window shadows, clipboard sync, and up to 120Hz Metal rendering.",
  fusionSyncingCatalog: "Syncing remote applications",
  fusionPausedHint: "Fusion connection is paused. Click Start Fusion Mode above to resume.",
  fusionOfflineCatalogHint:
    "Showing cached remote catalog. Click any app to connect and launch it automatically.",
  fusionNoMatchingAppsTitle: "No matching applications",
  fusionNoMatchingAppsDesc: "Try a different search query or switch back to All applications.",
  fusionUnsupportedTitle: "Fusion Mode is unavailable here",
  fusionSwitchToScreen: "Open Full Desktop",
  fusionNewLocalSession: "New Local Session",
  fusionLaunchApp: "Launch App",
  fusionActivateApp: "Bring to Front",
  fusionQuitApp: "Quit App",
  fusionForceQuitApp: "Force Quit",
  fusionForceQuitConfirmTitle: (appName) => `Force quit "${appName}"?`,
  fusionForceQuitConfirmDesc: (appName) =>
    `"${appName}" on the remote Mac will terminate immediately and unsaved changes may be lost.`,
  fusionWindowCount: (count) => (count === 1 ? "1 window" : `${count} windows`),
  fusionAppsCount: (count) => (count === 1 ? "1 app" : `${count} apps`),
  fusionRunningLabel: "Running",
  fusionPermissionTitle: "Screen Recording permission required",
  fusionPermissionDesc:
    "Fusion Mode requires Screen Recording and Accessibility permissions for LinkShell on the remote Mac.",
  fusionPermissionSteps: [
    "Open System Settings → Privacy & Security → Screen Recording on the remote Mac",
    "Enable LinkShell (toggle off and back on if already enabled)",
    "Ensure LinkShell is also enabled under Accessibility for pointer & keyboard input",
  ],
  fusionLockedTitle: "Remote Mac is locked",
  fusionLockedDesc: "Switch to Full Desktop to unlock the remote Mac before launching fused windows.",
  fusionOutdatedTitle: "Remote LinkShell Host needs an update",
  fusionOutdatedDesc: "Upgrade LinkShell on the remote Mac to use seamless App-Window Fusion.",
  fusionConnectionErrorTitle: "Fusion connection interrupted",
  fusionRetry: "Reconnect",
  fusionCheckPermissions: "Prompt Remote Permission Check",
  fusionOffTitle: "Fusion Mode is off",
  fusionOffDesc: "Turn it on to open the remote Mac's apps as their own windows here, in the Dock and ⌘Tab.",
  fusionReconnecting: (attempt, max) => `Connection lost, reconnecting (attempt ${attempt} of ${max})`,
  fusionAlertsLabel: "Fusion notices",
  fusionAlerts: {
    accessibility: { title: "Accessibility not allowed on the remote Mac", remedy: "On the remote Mac, open System Settings › Privacy & Security › Accessibility, allow LinkShell, then start Fusion again." },
    recording: { title: "Screen Recording not allowed on the remote Mac", remedy: "On the remote Mac, open System Settings › Privacy & Security › Screen Recording, allow LinkShell, then start Fusion again." },
    locked: { title: "The remote Mac is locked", remedy: "Switch to Full Desktop and unlock the remote Mac; fused windows recover afterwards." },
    webrtc: { title: "A window's picture could not connect", remedy: "This network cannot carry the window picture directly. Check both Macs' connection, or start Fusion again." },
    launch: { title: "The remote app could not open", remedy: "Make sure the app is still installed on the remote Mac, then try again." },
    stub: { title: "A fused app keeps quitting on this Mac", remedy: "The remote app is still running. Open it again below, or disconnect and start Fusion again." },
    disconnected: { title: "Fusion disconnected", remedy: "Check whether the remote Mac is asleep or offline, then start Fusion again." },
    generic: { title: "Fusion ran into a problem", remedy: "Try starting Fusion again." },
  },
  categories: {
    all: "All",
    running: "Running",
    developer: "Developer",
    productivity: "Productivity",
    utilities: "Utilities",
    social: "Social",
    entertainment: "Media",
    creative: "Creative",
    other: "Other",
  },

  navBack: "Back",
  navForward: "Forward",
  screenHeaderTitle: "Remote Screen",
  screenToolbarLabel: "Remote screen controls",
  screenStart: "Connect Desktop",
  screenDisconnect: "Disconnect",
  screenReconnect: "Reconnect",
  screenDisplayLabel: "Display",
  screenQualityButton: "Quality",
  screenQualityTitle: "Picture & Codec Settings",
  screenClarityLabel: "Resolution",
  screenFpsLabel: "Frame Rate Cap",
  screenCodecLabel: "Video Codec",
  screenPacingLabel: "Frame Pacing",
  screenTransportModeLabel: "Transport Mode",
  screenTransportAuto: "Auto (Low-latency WebRTC)",
  screenTransportCompat: "Compatible (E2E Byte Stream)",
  screenDisplayCapHint: (fps) => `Capped at ${fps} Hz to match local display refresh rate`,
  screenControlActive: "Controlling",
  screenControlViewOnly: "View Only",
  screenControlRequesting: "Requesting",
  screenControlUnavailableReason:
    "Accessibility control is not enabled on the remote computer; viewing only",
  screenKeysCaptureLabel: "Forward system shortcuts",
  screenKeysCapturedOn: "System shortcuts forwarded to remote",
  screenKeysCapturedOff: "Keep system shortcuts on local computer",
  screenToolsLabel: "Clipboard & Privacy",
  screenPasteToRemote: "Send Clipboard to Remote",
  screenCopyFromRemote: "Copy Remote Clipboard",
  screenPrivacySection: "Remote Privacy",
  screenPrivacyCurtain: "Enable Remote Privacy Curtain",
  screenLockOnDisconnect: "Lock Remote Screen on Disconnect",
  screenClipboardSynced: "Clipboard synced",
  screenClipboardEmpty: "Clipboard is empty",
  screenClipboardFailed: "Clipboard access failed",
  screenCurtainEnabledNote: "Remote physical display curtain enabled",
  screenCurtainDisabledNote: "Remote physical display restored",
  screenTelemetryLabel: "Telemetry",
  screenTelemetryTitle: "Live Stream Diagnostics",
  screenMetricEngine: "Pipeline",
  screenMetricPath: "Network Path",
  screenMetricResolution: "Resolution",
  screenMetricFps: "Frame Rate",
  screenMetricCodec: "Codec",
  screenMetricBitrate: "Bitrate",
  screenMetricRtt: "Round-Trip",
  screenMetricDecode: "Decoder",
  screenEngineMetal: "Native Metal",
  screenEngineWebRtc: "WebRTC Video",
  screenEngineCompat: "E2E Byte Stream",
  screenPathDirect: "Direct P2P",
  screenPathLan: "LAN Direct",
  screenPathTurn: "TURN Relay",
  screenPathRelay: "Gateway Relay",
  screenDecodeHardware: "Hardware",
  screenDecodeSoftware: "Software",
  screenFullscreenEnter: "Full Screen",
  screenFullscreenExit: "Exit Full Screen",
  screenReadyTitle: "Ready to connect remote screen",
  screenReadyDesc: "Open a low-latency stream to view and control the remote desktop.",
  screenConnectingTitle: "Connecting to remote screen",
  screenConnectingDesc: "Negotiating encrypted end-to-end media transport",
  screenRetryingTitle: "Reconnecting remote screen",
  screenIdlePausedTitle: "Screen paused due to inactivity",
  screenIdlePausedDesc:
    "Relayed video pauses after idle time to save bandwidth. Click to resume immediately.",
  screenTakenTitle: "Screen opened in another window",
  screenTakenDesc: "Another viewer took over this stream. Click to reclaim it here.",
  screenPermissionTitle: "Screen Recording permission needed",
  screenPermissionDesc:
    "Grant Screen Recording permission to LinkShell on the remote computer, then reconnect.",
  screenUnsupportedTitle: "Screen sharing unavailable",
  screenUnsupportedDesc:
    "Ensure the remote computer has an active graphical desktop session and screen helper.",
  screenOfflineTitle: "Remote computer is offline",
  screenOfflineDesc: "The remote screen will be available once the computer comes back online.",
  screenFallbackBanner: "Direct Metal blocked by network; using compatible stream",
  screenTryNativeAgain: "Retry Native Metal",
  clarityChoices: {
    auto: "Auto (Fit Window)",
    "1280": "1280p (Data Saver)",
    "1600": "1600p (Balanced)",
    "1920": "1080p (Standard)",
    "2560": "1440p ( Crisp)",
    "3200": "3200p (Ultra)",
    native: "Native Resolution",
  },
  fpsChoices: {
    "30": "30 FPS",
    "60": "60 FPS",
    "120": "120 FPS (ProMotion)",
  },
  codecChoices: {
    auto: "Auto (Prefer HEVC)",
    h264: "Compatible H.264",
  },
  pacingChoices: {
    immediate: "Lowest Latency",
    smooth: "Smooth Pacing (Wi-Fi)",
  },
});

const JA_COPY = (locale: Locale): RemoteCopy => ({
  ...EN_COPY(locale),
  fullDesktop: "フルデスクトップ",
  fusionMode: "融合モード",
  modeSwitchLabel: "リモート表示モード",
  fusionActiveShort: "融合中",
  fusionOpenHub: "融合ランチャー",
  fusionConnecting: "接続中",
  fusionStart: "融合モードを開始",
  fusionDisconnect: "融合を切断",
  fusionSearchPlaceholder: "アプリ名で検索",
  fusionSyncingCatalog: "リモートアプリ一覧を同期中",
  fusionPausedHint: "融合接続は一時停止中です。上の「融合モードを開始」で再開できます。",
  fusionDirect: "直接接続",
  fusionTunnel: "暗号化トンネル",
  fusionActiveWindowsTitle: "実行中の融合ウインドウ",
  fusionCatalogTitle: "リモートアプリケーション",
  fusionHeroTitle: "リモート Mac アプリをこの Mac にシームレス投影",
  fusionSwitchToScreen: "フルデスクトップへ切替",
  fusionLaunchApp: "起動",
  fusionActivateApp: "前面に表示",
  fusionQuitApp: "終了",
  fusionForceQuitApp: "強制終了",
  fusionRetry: "再接続",
  fusionOffTitle: "融合モードはオフです",
  fusionOffDesc: "オンにすると、リモート Mac のアプリがこの Mac の Dock と ⌘Tab に独立したウインドウとして現れます。",
  fusionReconnecting: (attempt, max) => `接続が切れました。再接続中（${attempt}/${max} 回目）`,
  fusionAlertsLabel: "融合モードのお知らせ",
  categories: {
    all: "すべて",
    running: "実行中",
    developer: "開発ツール",
    productivity: "仕事効率化",
    utilities: "ユーティリティ",
    social: "ソーシャル",
    entertainment: "メディア",
    creative: "クリエイティブ",
    other: "その他",
  },
  navBack: "戻る",
  navForward: "進む",
  screenHeaderTitle: "リモート画面",
  screenStart: "画面に接続",
  screenDisconnect: "切断",
  screenReconnect: "再接続",
  screenQualityButton: "画質",
  screenQualityTitle: "画質とコーデック設定",
  screenCodecLabel: "ビデオコーデック",
  screenControlActive: "操作中",
  screenControlViewOnly: "表示のみ",
  screenFullscreenEnter: "フルスクリーン",
  screenFullscreenExit: "フルスクリーン終了",
});

export function getRemoteCopy(locale: Locale = getDesktopLocale()): RemoteCopy {
  if (locale === "en") return EN_COPY(locale);
  if (locale === "ja") return JA_COPY(locale);
  return ZH_COPY(locale);
}

/** Normalizes localized / raw macOS LSApplicationCategoryType values into canonical category keys. */
export function resolveAppCategory(
  category?: string,
  rawCategory?: string,
): Exclude<FusionCategoryKey, "all" | "running"> {
  const probe = `${category ?? ""} ${rawCategory ?? ""}`.toLowerCase();
  if (
    probe.includes("developer") ||
    probe.includes("开发") ||
    probe.includes("xcode")
  ) {
    return "developer";
  }
  if (
    probe.includes("productivity") ||
    probe.includes("business") ||
    probe.includes("finance") ||
    probe.includes("效率") ||
    probe.includes("商务")
  ) {
    return "productivity";
  }
  if (probe.includes("utilities") || probe.includes("实用工具")) {
    return "utilities";
  }
  if (probe.includes("social") || probe.includes("社交")) {
    return "social";
  }
  if (
    probe.includes("music") ||
    probe.includes("video") ||
    probe.includes("entertainment") ||
    probe.includes("games") ||
    probe.includes("娱乐") ||
    probe.includes("音乐") ||
    probe.includes("视频")
  ) {
    return "entertainment";
  }
  if (
    probe.includes("graphics") ||
    probe.includes("design") ||
    probe.includes("photography") ||
    probe.includes("创意") ||
    probe.includes("图形") ||
    probe.includes("设计")
  ) {
    return "creative";
  }
  return "other";
}
