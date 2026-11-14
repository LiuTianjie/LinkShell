import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  dateLocaleTag,
  detectLocale,
  isLocale,
  isLocalePreference,
  resolveLocalePreference,
  setLocalePreference as syncCoreLocalePreference,
  t as translateCore,
  type I18nKey as CoreI18nKey,
  type Locale,
  type LocalePreference,
} from "@linkshell/client-core";
import {
  desktopPlatform,
  getActiveDesktopPlatform,
  normalizeDesktopPlatform,
  subscribeDesktopPlatform,
} from "../bridge/desktop-bridge";
import { STORAGE_KEYS, readLocal, saveLocal, subscribeStorageReady } from "./storage";

export {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  dateLocaleTag,
  detectLocale,
  isLocale,
  isLocalePreference,
  resolveLocalePreference,
  type CoreI18nKey,
  type Locale,
  type LocalePreference,
};

export type DesktopPlatformKind = "macos" | "windows" | "linux";

const desktopZh = {
  // App & Chrome
  "desktop.appName": "LinkShell",
  "desktop.workspace": "工作台",
  "desktop.localManagement": "本机管理",
  "desktop.toggleSidebar": "显示或隐藏侧栏",
  "desktop.toggleInspector": "显示或隐藏检查器",
  "desktop.toggleBottomDock": "打开或收起底部终端",
  "desktop.commandCenter": "搜索与命令",
  "desktop.shortcuts": "键盘快捷键",
  "desktop.newSession": "新建会话",

  // Platform labels
  "desktop.platform.thisMac": "这台 Mac",
  "desktop.platform.thisPc": "这台电脑",
  "desktop.platform.revealFinder": "在 Finder 中显示",
  "desktop.platform.revealExplorer": "在资源管理器中显示",
  "desktop.platform.revealFileManager": "在文件管理器中显示",
  "desktop.platform.finder": "Finder",
  "desktop.platform.explorer": "资源管理器",
  "desktop.platform.fileManager": "文件管理器",

  // Sidebar & Navigation
  "desktop.nav.sessions": "会话",
  "desktop.nav.activeSessions": "活跃会话",
  "desktop.nav.projects": "项目",
  "desktop.nav.scopeComputer": "当前电脑",
  "desktop.nav.scopeAll": "所有电脑",
  "desktop.nav.screen": "远程屏幕",
  "desktop.nav.fusion": "融合模式",
  "desktop.nav.terminals": "终端",
  "desktop.nav.files": "文件",
  "desktop.nav.ports": "端口预览",
  "desktop.nav.worktrees": "Worktree",
  "desktop.nav.computers": "电脑与连接",
  "desktop.nav.archive": "已归档",
  "desktop.nav.showMore": "展开其余 {count} 项",
  "desktop.nav.showLess": "收起",
  "desktop.nav.autoGroup": "自动",

  // Context Menus (Session & Project)
  "desktop.menu.rename": "重命名",
  "desktop.menu.fork": "分叉",
  "desktop.menu.forkHere": "创建会话分支",
  "desktop.menu.forkSameWorktree": "在同一 worktree 中创建会话分支",
  "desktop.menu.forkNewWorktree": "在新 worktree 中创建会话分支",
  "desktop.menu.copy": "复制",
  "desktop.menu.copyTitle": "复制标题",
  "desktop.menu.copyCwd": "复制工作目录",
  "desktop.menu.copyId": "复制会话 ID",
  "desktop.menu.copyPath": "复制路径",
  "desktop.menu.archive": "归档",
  "desktop.menu.unarchive": "恢复会话",
  "desktop.menu.archiveAll": "归档全部会话",
  "desktop.menu.deletePermanent": "永久删除",
  "desktop.menu.newInProject": "在此项目中新建会话",
  "desktop.menu.keepWorktree": "保留 worktree",
  "desktop.menu.removeWorktree": "一起删除改动与分支",

  // Fleet, Connection & Telemetry
  "desktop.fleet.connectComputer": "连接电脑",
  "desktop.fleet.pairDevice": "配对手机或设备",
  "desktop.fleet.forgetComputer": "移除配对电脑",
  "desktop.fleet.localStoppedTitle": "本机服务已停止",
  "desktop.fleet.localStoppedDesc": "启动{computer}的后台服务以恢复本地会话、终端与预览，或连接其他电脑。",
  "desktop.fleet.preparingLocal": "正在准备{computer}",
  "desktop.fleet.accessLocked": "此电脑已设置访问密码",
  "desktop.fleet.unlockPlaceholder": "输入访问密码",
  "desktop.fleet.unlockAction": "解锁电脑",
  "desktop.fleet.cpu": "处理器",
  "desktop.fleet.memory": "内存",
  "desktop.fleet.memoryIncludesCache": "含系统缓存",
  "desktop.fleet.disk": "磁盘可用",
  "desktop.fleet.diskUnavailable": "未提供",
  "desktop.fleet.battery": "电池",
  "desktop.fleet.lowBatteryWarning": "电量较低（未接电源）",
  "desktop.fleet.keepAwake": "防休眠",
  "desktop.fleet.keepAwakeSmart": "智能（会话运行时）",
  "desktop.fleet.keepAwakeAlways": "始终保持唤醒",
  "desktop.fleet.keepAwakeOff": "跟随系统休眠",
  "desktop.fleet.renameComputer": "电脑名称",
  "desktop.fleet.renameOutdated": "远端 LinkShell 版本较旧，暂不支持跨设备同步名称。",

  // New Session & Composer
  "desktop.composer.agent": "智能体",
  "desktop.composer.model": "模型",
  "desktop.composer.mode": "模式与权限",
  "desktop.composer.effort": "推理强度",
  "desktop.composer.project": "工作目录",
  "desktop.composer.branch": "分支",
  "desktop.composer.startInWorktree": "在新 Worktree 中启动",
  "desktop.composer.placeholder": "输入任务、@引用文件，或输入 / 执行命令",
  "desktop.composer.send": "发送",
  "desktop.composer.steer": "插话",
  "desktop.composer.queue": "加入发送队列",
  "desktop.composer.stop": "停止",
  "desktop.composer.queuedCount": "发送队列（{count}）",
  "desktop.composer.sendNow": "立即发送",
  "desktop.composer.editQueued": "取回编辑",
  "desktop.composer.moveUp": "上移",
  "desktop.composer.removeQueued": "移除",
  "desktop.composer.attachFile": "添加附件",
  "desktop.composer.pastedBlock": "粘贴文本（{lines} 行）",
  "desktop.composer.expandPasted": "展开为正文",
  "desktop.composer.takeover": "接管会话",
  "desktop.composer.releaseToDesktop": "交回终端",
  "desktop.composer.contextUsage": "上下文用量",
  "desktop.composer.sendFailed": "发送失败，输入和附件已保留；也可在消息卡片上重试。",

  // Conversation, Timeline, Approvals & Questions
  "desktop.timeline.searchPlaceholder": "在当前会话中搜索",
  "desktop.timeline.outlineAll": "全部",
  "desktop.timeline.outlineQuestions": "提问",
  "desktop.timeline.outlineApprovals": "审批",
  "desktop.timeline.outlineErrors": "报错",
  "desktop.timeline.jumpToBottom": "回到底部",
  "desktop.timeline.waitingAnswer": "等你回答",
  "desktop.timeline.waitingConfirm": "等你确认",
  "desktop.timeline.waitingAction": "等你处理",
  "desktop.timeline.toolNotSucceeded": "（工具未成功）",
  "desktop.timeline.declined": "已拒绝",
  "desktop.timeline.stopped": "已停止",
  "desktop.timeline.agentFailed": "智能体失败",
  "desktop.timeline.approve": "允许",
  "desktop.timeline.alwaysApprove": "始终允许",
  "desktop.timeline.deny": "拒绝",
  "desktop.timeline.recommended": "推荐",
  "desktop.timeline.unifiedDiff": "统一视图",
  "desktop.timeline.splitDiff": "并排视图",
  "desktop.timeline.addLineComment": "添加行批注",
  "desktop.timeline.submitReview": "发送 {count} 条代码批注",
  "desktop.timeline.cancelSubagent": "停止子智能体",

  // Workbench / Inspector
  "desktop.inspector.changes": "改动",
  "desktop.inspector.sessionChanges": "会话改动",
  "desktop.inspector.gitWorkspace": "Git 工作区",
  "desktop.inspector.commit": "提交改动",
  "desktop.inspector.revertFile": "还原文件",
  "desktop.inspector.askAgentCommit": "让 Agent 提交 / 创建 PR",
  "desktop.inspector.askAgentTest": "让 Agent 运行测试",
  "desktop.inspector.files": "文件",
  "desktop.inspector.showHidden": "显示隐藏文件",
  "desktop.inspector.preview": "预览",
  "desktop.inspector.source": "源码",
  "desktop.inspector.download": "下载文件",
  "desktop.inspector.saveFile": "保存",
  "desktop.inspector.unsavedConfirm": "当前文件有未保存的修改，确定放弃修改并离开吗？",
  "desktop.inspector.openIn": "在外部应用中打开",
  "desktop.inspector.terminal": "终端",
  "desktop.inspector.ports": "端口预览",
  "desktop.inspector.sendErrorToAgent": "把报错发给 Agent 修复",
  "desktop.inspector.tasks": "任务与子智能体",
  "desktop.inspector.side": "旁路问答",
  "desktop.inspector.goal": "目标",
  "desktop.inspector.settings": "会话设置",
  "desktop.inspector.acp": "ACP 智能体配置",
  "desktop.inspector.mcp": "MCP 工具与应用",
  "desktop.inspector.connectors": "连接器",

  // Remote Screen
  "desktop.screen.openDesktop": "打开桌面",
  "desktop.screen.start": "开启远程屏幕",
  "desktop.screen.stop": "断开画面",
  "desktop.screen.fullscreen": "全屏控制",
  "desktop.screen.exitFullscreen": "退出全屏",
  "desktop.screen.display": "显示器",
  "desktop.screen.clarity": "清晰度",
  "desktop.screen.clarityAuto": "自动适配窗口",
  "desktop.screen.clarityNative": "原画（最高 4K）",
  "desktop.screen.fps": "帧率上限",
  "desktop.screen.codec": "编码格式",
  "desktop.screen.codecAuto": "自动（优先 HEVC）",
  "desktop.screen.codecH264": "兼容 H.264",
  "desktop.screen.pacing": "帧调度",
  "desktop.screen.pacingImmediate": "最低延迟",
  "desktop.screen.pacingSmooth": "平滑防抖",
  "desktop.screen.controlOn": "键鼠控制中",
  "desktop.screen.controlOff": "仅观看",
  "desktop.screen.privacyCurtain": "远端隐私黑屏",
  "desktop.screen.lockOnDisconnect": "断开时自动锁屏",
  "desktop.screen.syncClipboard": "同步剪贴板",
  "desktop.screen.swapModifiers": "跨系统交换 ⌘ 与 Ctrl",
  "desktop.screen.taken": "屏幕画面已被另一台设备接手",
  "desktop.screen.idle": "长时间无操作，中继画面已自动暂停以节省流量",
  "desktop.screen.grantPermission": "在远端电脑授权屏幕录制与控制",

  // Fusion Mode (融合模式)
  "desktop.fusion.title": "融合模式",
  "desktop.fusion.subtitle": "把远端 Mac 上的应用作为独立本地窗口无缝运行在当前桌面与 Dock 中。",
  "desktop.fusion.start": "开启融合模式",
  "desktop.fusion.stop": "结束融合模式",
  "desktop.fusion.starting": "正在建立融合连接",
  "desktop.fusion.modeDirect": "局域网 / 直连高速通道",
  "desktop.fusion.modeTunnel": "端到端加密中继通道",
  "desktop.fusion.openAppsFolder": "打开本地融合应用目录",
  "desktop.fusion.launchApp": "启动应用",
  "desktop.fusion.quitApp": "退出远端应用",
  "desktop.fusion.forceQuitApp": "强制退出",
  "desktop.fusion.windowCount": "{count} 个窗口",
  "desktop.fusion.searchApps": "搜索应用名称",
  "desktop.fusion.emptyApps": "正在同步远端 Mac 的应用程序目录",
  "desktop.fusion.reasonNotElectron": "融合模式仅在 LinkShell macOS 桌面客户端中可用。",
  "desktop.fusion.reasonWindows": "Windows 客户端暂不支持 macOS 应用窗口融合，请使用远程屏幕完整桌面模式。",
  "desktop.fusion.reasonNonMacClient": "融合模式需要 macOS 桌面客户端。",
  "desktop.fusion.reasonLocal": "本机应用已在当前 Mac 上直接运行，无需开启融合模式。",
  "desktop.fusion.reasonNonMacRemote": "融合模式目前仅支持连接远端 macOS 电脑。",
  "desktop.fusion.reasonNoComputer": "请先选择一台远端 Mac 电脑。",
  "desktop.fusion.outdatedHost": "远端电脑的 LinkShell 版本较旧，请先更新远端 LinkShell 后再开启融合模式。",
  "desktop.fusion.lockedHost": "远端电脑设置了访问密码，请先在 LinkShell 中解锁后再打开融合应用。",
  "desktop.fusion.offlineHost": "「{name}」当前离线，无法打开融合应用。",

  // Management, Devices, Auth & Membership
  "desktop.manage.overview": "总览",
  "desktop.manage.devices": "已配对设备",
  "desktop.manage.password": "访问密码",
  "desktop.manage.usage": "用量统计",
  "desktop.manage.log": "运行日志",
  "desktop.manage.updates": "软件更新",
  "desktop.manage.settings": "系统设置",
  "desktop.manage.serviceRunning": "运行中",
  "desktop.manage.serviceStopped": "已停止",
  "desktop.manage.serviceUnreachable": "无法连接",
  "desktop.manage.startService": "启动服务",
  "desktop.manage.stopService": "停止服务",
  "desktop.manage.restartService": "重启服务",
  "desktop.manage.revokeDevice": "移除配对",
  "desktop.manage.revokeDeviceConfirm": "确定移除设备「{name}」的配对权限吗？移除后该设备需重新扫码或输入配对码才能连接本机。",
  "desktop.manage.generatePairCode": "生成 6 位配对码与二维码",
  "desktop.manage.gatewayOfficial": "官方网关（gateway.itool.tech）",
  "desktop.manage.gatewayCustom": "自建网关",
  "desktop.manage.gatewayOff": "关闭外网中继（仅本机）",
  "desktop.manage.surfaceTranslucent": "毛玻璃半透明侧栏",
  "desktop.manage.surfaceOpaque": "纯色不透明窗口",
  "desktop.manage.launchAtLogin": "登录系统时自动启动",
  "desktop.manage.installCli": "安装 linkshell 命令行工具",
  "desktop.manage.copyCliPath": "复制 linkshell.cmd 路径",
  "desktop.manage.appearance": "外观主题",
  "desktop.manage.appearanceLight": "浅色",
  "desktop.manage.appearanceDark": "深色",
  "desktop.manage.appearanceSystem": "跟随系统",
} as const;

export type DesktopI18nKey = keyof typeof desktopZh;
export type AnyI18nKey = DesktopI18nKey | CoreI18nKey;

const desktopEn: Record<DesktopI18nKey, string> = {
  "desktop.appName": "LinkShell",
  "desktop.workspace": "Workspace",
  "desktop.localManagement": "Local Host",
  "desktop.toggleSidebar": "Toggle Sidebar",
  "desktop.toggleInspector": "Toggle Inspector",
  "desktop.toggleBottomDock": "Toggle Bottom Terminal",
  "desktop.commandCenter": "Command Center",
  "desktop.shortcuts": "Keyboard Shortcuts",
  "desktop.newSession": "New Session",

  "desktop.platform.thisMac": "This Mac",
  "desktop.platform.thisPc": "This PC",
  "desktop.platform.revealFinder": "Reveal in Finder",
  "desktop.platform.revealExplorer": "Show in File Explorer",
  "desktop.platform.revealFileManager": "Show in File Manager",
  "desktop.platform.finder": "Finder",
  "desktop.platform.explorer": "File Explorer",
  "desktop.platform.fileManager": "File Manager",

  "desktop.nav.sessions": "Sessions",
  "desktop.nav.activeSessions": "Active",
  "desktop.nav.projects": "Projects",
  "desktop.nav.scopeComputer": "Current Computer",
  "desktop.nav.scopeAll": "All Computers",
  "desktop.nav.screen": "Remote Screen",
  "desktop.nav.fusion": "Fusion Mode",
  "desktop.nav.terminals": "Terminals",
  "desktop.nav.files": "Files",
  "desktop.nav.ports": "Port Previews",
  "desktop.nav.worktrees": "Worktrees",
  "desktop.nav.computers": "Computers",
  "desktop.nav.archive": "Archived",
  "desktop.nav.showMore": "Show {count} more",
  "desktop.nav.showLess": "Show less",
  "desktop.nav.autoGroup": "Auto",

  "desktop.menu.rename": "Rename",
  "desktop.menu.fork": "Fork",
  "desktop.menu.forkHere": "Fork Session",
  "desktop.menu.forkSameWorktree": "Fork in Same Worktree",
  "desktop.menu.forkNewWorktree": "Fork in New Worktree",
  "desktop.menu.copy": "Copy",
  "desktop.menu.copyTitle": "Copy Title",
  "desktop.menu.copyCwd": "Copy Working Directory",
  "desktop.menu.copyId": "Copy Session ID",
  "desktop.menu.copyPath": "Copy Path",
  "desktop.menu.archive": "Archive",
  "desktop.menu.unarchive": "Restore Session",
  "desktop.menu.archiveAll": "Archive All Sessions",
  "desktop.menu.deletePermanent": "Delete Permanently",
  "desktop.menu.newInProject": "New Session in Project",
  "desktop.menu.keepWorktree": "Keep Worktree",
  "desktop.menu.removeWorktree": "Delete Changes & Branch",

  "desktop.fleet.connectComputer": "Connect Computer",
  "desktop.fleet.pairDevice": "Pair Phone or Device",
  "desktop.fleet.forgetComputer": "Forget Computer",
  "desktop.fleet.localStoppedTitle": "Local Host Stopped",
  "desktop.fleet.localStoppedDesc": "Start the background service on {computer} to restore local sessions, terminals, and previews.",
  "desktop.fleet.preparingLocal": "Preparing {computer}",
  "desktop.fleet.accessLocked": "Locked with Access Password",
  "desktop.fleet.unlockPlaceholder": "Enter access password",
  "desktop.fleet.unlockAction": "Unlock Computer",
  "desktop.fleet.cpu": "CPU",
  "desktop.fleet.memory": "Memory",
  "desktop.fleet.memoryIncludesCache": "Includes cache",
  "desktop.fleet.disk": "Disk Available",
  "desktop.fleet.diskUnavailable": "Unavailable",
  "desktop.fleet.battery": "Battery",
  "desktop.fleet.lowBatteryWarning": "Low battery (unplugged)",
  "desktop.fleet.keepAwake": "Keep Awake",
  "desktop.fleet.keepAwakeSmart": "Smart (while sessions run)",
  "desktop.fleet.keepAwakeAlways": "Always Keep Awake",
  "desktop.fleet.keepAwakeOff": "System Default",
  "desktop.fleet.renameComputer": "Computer Name",
  "desktop.fleet.renameOutdated": "Update remote LinkShell to sync computer names across devices.",

  "desktop.composer.agent": "Agent",
  "desktop.composer.model": "Model",
  "desktop.composer.mode": "Mode & Permissions",
  "desktop.composer.effort": "Reasoning Effort",
  "desktop.composer.project": "Directory",
  "desktop.composer.branch": "Branch",
  "desktop.composer.startInWorktree": "Start in New Worktree",
  "desktop.composer.placeholder": "Ask anything, @mention files, or type / for commands",
  "desktop.composer.send": "Send",
  "desktop.composer.steer": "Steer",
  "desktop.composer.queue": "Queue Message",
  "desktop.composer.stop": "Stop",
  "desktop.composer.queuedCount": "Queued ({count})",
  "desktop.composer.sendNow": "Send Now",
  "desktop.composer.editQueued": "Edit",
  "desktop.composer.moveUp": "Move Up",
  "desktop.composer.removeQueued": "Remove",
  "desktop.composer.attachFile": "Attach Files",
  "desktop.composer.pastedBlock": "Pasted text ({lines} lines)",
  "desktop.composer.expandPasted": "Expand Inline",
  "desktop.composer.takeover": "Take Over Session",
  "desktop.composer.releaseToDesktop": "Hand Back to Terminal",
  "desktop.composer.contextUsage": "Context Window",
  "desktop.composer.sendFailed": "Delivery failed. Your draft and attachments were preserved.",

  "desktop.timeline.searchPlaceholder": "Find in session",
  "desktop.timeline.outlineAll": "All",
  "desktop.timeline.outlineQuestions": "Questions",
  "desktop.timeline.outlineApprovals": "Approvals",
  "desktop.timeline.outlineErrors": "Errors",
  "desktop.timeline.jumpToBottom": "Jump to bottom",
  "desktop.timeline.waitingAnswer": "Awaiting answer",
  "desktop.timeline.waitingConfirm": "Awaiting approval",
  "desktop.timeline.waitingAction": "Action required",
  "desktop.timeline.toolNotSucceeded": "(non-zero exit)",
  "desktop.timeline.declined": "Declined",
  "desktop.timeline.stopped": "Stopped",
  "desktop.timeline.agentFailed": "Agent Failed",
  "desktop.timeline.approve": "Allow",
  "desktop.timeline.alwaysApprove": "Always Allow",
  "desktop.timeline.deny": "Deny",
  "desktop.timeline.recommended": "Recommended",
  "desktop.timeline.unifiedDiff": "Unified",
  "desktop.timeline.splitDiff": "Split",
  "desktop.timeline.addLineComment": "Add review comment",
  "desktop.timeline.submitReview": "Send {count} review comments",
  "desktop.timeline.cancelSubagent": "Stop Subagent",

  "desktop.inspector.changes": "Changes",
  "desktop.inspector.sessionChanges": "Session Edits",
  "desktop.inspector.gitWorkspace": "Git Working Tree",
  "desktop.inspector.commit": "Commit Changes",
  "desktop.inspector.revertFile": "Revert File",
  "desktop.inspector.askAgentCommit": "Ask Agent to Commit / PR",
  "desktop.inspector.askAgentTest": "Ask Agent to Run Tests",
  "desktop.inspector.files": "Files",
  "desktop.inspector.showHidden": "Show Hidden Files",
  "desktop.inspector.preview": "Preview",
  "desktop.inspector.source": "Source",
  "desktop.inspector.download": "Download",
  "desktop.inspector.saveFile": "Save",
  "desktop.inspector.unsavedConfirm": "You have unsaved changes. Discard them and leave?",
  "desktop.inspector.openIn": "Open In",
  "desktop.inspector.terminal": "Terminal",
  "desktop.inspector.ports": "Port Preview",
  "desktop.inspector.sendErrorToAgent": "Send Error to Agent to Fix",
  "desktop.inspector.tasks": "Tasks & Subagents",
  "desktop.inspector.side": "Side Chat",
  "desktop.inspector.goal": "Goal",
  "desktop.inspector.settings": "Session Settings",
  "desktop.inspector.acp": "ACP Agent Settings",
  "desktop.inspector.mcp": "MCP Apps & Tools",
  "desktop.inspector.connectors": "Connectors",

  "desktop.screen.openDesktop": "Open Screen",
  "desktop.screen.start": "Start Remote Screen",
  "desktop.screen.stop": "Disconnect",
  "desktop.screen.fullscreen": "Full Screen",
  "desktop.screen.exitFullscreen": "Exit Full Screen",
  "desktop.screen.display": "Display",
  "desktop.screen.clarity": "Resolution",
  "desktop.screen.clarityAuto": "Auto (Match Stage)",
  "desktop.screen.clarityNative": "Native (Up to 4K)",
  "desktop.screen.fps": "Frame Rate",
  "desktop.screen.codec": "Video Codec",
  "desktop.screen.codecAuto": "Auto (Prefer HEVC)",
  "desktop.screen.codecH264": "Compatible H.264",
  "desktop.screen.pacing": "Frame Pacing",
  "desktop.screen.pacingImmediate": "Lowest Latency",
  "desktop.screen.pacingSmooth": "Smooth Pacing",
  "desktop.screen.controlOn": "Controlling Input",
  "desktop.screen.controlOff": "View Only",
  "desktop.screen.privacyCurtain": "Privacy Curtain",
  "desktop.screen.lockOnDisconnect": "Lock on Disconnect",
  "desktop.screen.syncClipboard": "Sync Clipboard",
  "desktop.screen.swapModifiers": "Swap ⌘ and Ctrl Across OS",
  "desktop.screen.taken": "Another device took over this remote screen",
  "desktop.screen.idle": "Paused idle relayed stream to save bandwidth",
  "desktop.screen.grantPermission": "Grant Screen Recording & Accessibility on Remote Computer",

  "desktop.fusion.title": "Fusion Mode",
  "desktop.fusion.subtitle": "Stream individual remote Mac apps as native local windows in your desktop and Dock.",
  "desktop.fusion.start": "Start Fusion Mode",
  "desktop.fusion.stop": "Stop Fusion Mode",
  "desktop.fusion.starting": "Starting Fusion session",
  "desktop.fusion.modeDirect": "Direct / LAN Link",
  "desktop.fusion.modeTunnel": "E2EE Relay Tunnel",
  "desktop.fusion.openAppsFolder": "Open Local Fusion Apps Folder",
  "desktop.fusion.launchApp": "Launch App",
  "desktop.fusion.quitApp": "Quit Remote App",
  "desktop.fusion.forceQuitApp": "Force Quit",
  "desktop.fusion.windowCount": "{count} windows",
  "desktop.fusion.searchApps": "Search remote Mac apps",
  "desktop.fusion.emptyApps": "Syncing remote Mac application catalog",
  "desktop.fusion.reasonNotElectron": "Fusion Mode requires the LinkShell macOS Desktop app.",
  "desktop.fusion.reasonWindows": "Fusion app windowing is macOS-to-macOS only; use Full Remote Screen on Windows.",
  "desktop.fusion.reasonNonMacClient": "Fusion Mode requires a macOS client.",
  "desktop.fusion.reasonLocal": "Local apps already run natively on this Mac.",
  "desktop.fusion.reasonNonMacRemote": "Fusion Mode only supports remote macOS computers.",
  "desktop.fusion.reasonNoComputer": "Select a remote Mac first.",
  "desktop.fusion.outdatedHost": "Please update LinkShell on the remote Mac before starting Fusion Mode.",
  "desktop.fusion.lockedHost": "Unlock the remote Mac's access password in LinkShell before opening Fusion apps.",
  "desktop.fusion.offlineHost": "\"{name}\" is currently offline.",

  "desktop.manage.overview": "Overview",
  "desktop.manage.devices": "Paired Devices",
  "desktop.manage.password": "Access Password",
  "desktop.manage.usage": "Usage & ROI",
  "desktop.manage.log": "Host Logs",
  "desktop.manage.updates": "Updates",
  "desktop.manage.settings": "Settings",
  "desktop.manage.serviceRunning": "Running",
  "desktop.manage.serviceStopped": "Stopped",
  "desktop.manage.serviceUnreachable": "Unreachable",
  "desktop.manage.startService": "Start Service",
  "desktop.manage.stopService": "Stop Service",
  "desktop.manage.restartService": "Restart Service",
  "desktop.manage.revokeDevice": "Revoke",
  "desktop.manage.revokeDeviceConfirm": "Revoke pairing for \"{name}\"? It will need a new QR scan or 6-digit code to reconnect.",
  "desktop.manage.generatePairCode": "Generate 6-Digit Pairing Code & QR",
  "desktop.manage.gatewayOfficial": "Official Gateway (gateway.itool.tech)",
  "desktop.manage.gatewayCustom": "Self-Hosted Gateway",
  "desktop.manage.gatewayOff": "Off (Local Only)",
  "desktop.manage.surfaceTranslucent": "Translucent Vibrancy Sidebar",
  "desktop.manage.surfaceOpaque": "Opaque Window Surface",
  "desktop.manage.launchAtLogin": "Launch at Login",
  "desktop.manage.installCli": "Install linkshell CLI Command",
  "desktop.manage.copyCliPath": "Copy linkshell.cmd Path",
  "desktop.manage.appearance": "Appearance",
  "desktop.manage.appearanceLight": "Light",
  "desktop.manage.appearanceDark": "Dark",
  "desktop.manage.appearanceSystem": "System",
};

const desktopJa: Record<DesktopI18nKey, string> = {
  "desktop.appName": "LinkShell",
  "desktop.workspace": "ワークスペース",
  "desktop.localManagement": "このコンピュータ管理",
  "desktop.toggleSidebar": "サイドバーの表示切替",
  "desktop.toggleInspector": "インスペクタの表示切替",
  "desktop.toggleBottomDock": "下部ターミナルの表示切替",
  "desktop.commandCenter": "コマンドセンター",
  "desktop.shortcuts": "ショートカット一覧",
  "desktop.newSession": "新規セッション",

  "desktop.platform.thisMac": "この Mac",
  "desktop.platform.thisPc": "この PC",
  "desktop.platform.revealFinder": "Finder で表示",
  "desktop.platform.revealExplorer": "エクスプローラーで表示",
  "desktop.platform.revealFileManager": "ファイルマネージャーで表示",
  "desktop.platform.finder": "Finder",
  "desktop.platform.explorer": "エクスプローラー",
  "desktop.platform.fileManager": "ファイルマネージャー",

  "desktop.nav.sessions": "セッション",
  "desktop.nav.activeSessions": "実行中・待機中",
  "desktop.nav.projects": "プロジェクト",
  "desktop.nav.scopeComputer": "現在のコンピュータ",
  "desktop.nav.scopeAll": "すべてのコンピュータ",
  "desktop.nav.screen": "リモート画面",
  "desktop.nav.fusion": "融合モード",
  "desktop.nav.terminals": "ターミナル",
  "desktop.nav.files": "ファイル",
  "desktop.nav.ports": "ポートプレビュー",
  "desktop.nav.worktrees": "Worktree",
  "desktop.nav.computers": "コンピュータ",
  "desktop.nav.archive": "アーカイブ済み",
  "desktop.nav.showMore": "他 {count} 件を表示",
  "desktop.nav.showLess": "折りたたむ",
  "desktop.nav.autoGroup": "自動",

  "desktop.menu.rename": "名前を変更",
  "desktop.menu.fork": "フォーク",
  "desktop.menu.forkHere": "セッションを分岐",
  "desktop.menu.forkSameWorktree": "同じ Worktree で分岐",
  "desktop.menu.forkNewWorktree": "新しい Worktree で分岐",
  "desktop.menu.copy": "コピー",
  "desktop.menu.copyTitle": "タイトルをコピー",
  "desktop.menu.copyCwd": "作業ディレクトリをコピー",
  "desktop.menu.copyId": "セッション ID をコピー",
  "desktop.menu.copyPath": "パスをコピー",
  "desktop.menu.archive": "アーカイブ",
  "desktop.menu.unarchive": "復元",
  "desktop.menu.archiveAll": "すべてのセッションをアーカイブ",
  "desktop.menu.deletePermanent": "完全に削除",
  "desktop.menu.newInProject": "このプロジェクトで新規セッション",
  "desktop.menu.keepWorktree": "Worktree を残す",
  "desktop.menu.removeWorktree": "変更とブランチも削除",

  "desktop.fleet.connectComputer": "コンピュータを接続",
  "desktop.fleet.pairDevice": "スマホ・デバイスをペアリング",
  "desktop.fleet.forgetComputer": "ペアリングを解除",
  "desktop.fleet.localStoppedTitle": "ローカルサービス停止中",
  "desktop.fleet.localStoppedDesc": "{computer}のバックグラウンドサービスを起動してローカルセッションやターミナルを復元します。",
  "desktop.fleet.preparingLocal": "{computer}を準備中",
  "desktop.fleet.accessLocked": "アクセスパスワードで保護されています",
  "desktop.fleet.unlockPlaceholder": "アクセスパスワードを入力",
  "desktop.fleet.unlockAction": "ロック解除",
  "desktop.fleet.cpu": "CPU",
  "desktop.fleet.memory": "メモリ",
  "desktop.fleet.memoryIncludesCache": "キャッシュ含む",
  "desktop.fleet.disk": "空きディスク",
  "desktop.fleet.diskUnavailable": "未取得",
  "desktop.fleet.battery": "バッテリー",
  "desktop.fleet.lowBatteryWarning": "バッテリー残量低下（未充電）",
  "desktop.fleet.keepAwake": "スリープ防止",
  "desktop.fleet.keepAwakeSmart": "スマート（実行中のみ）",
  "desktop.fleet.keepAwakeAlways": "常にスリープ防止",
  "desktop.fleet.keepAwakeOff": "システム設定に従う",
  "desktop.fleet.renameComputer": "コンピュータ名",
  "desktop.fleet.renameOutdated": "名前の同期にはリモート側の LinkShell 更新が必要です。",

  "desktop.composer.agent": "エージェント",
  "desktop.composer.model": "モデル",
  "desktop.composer.mode": "モードと権限",
  "desktop.composer.effort": "推論強度",
  "desktop.composer.project": "作業ディレクトリ",
  "desktop.composer.branch": "ブランチ",
  "desktop.composer.startInWorktree": "新しい Worktree で開始",
  "desktop.composer.placeholder": "指示を入力、@でファイル参照、/でコマンド",
  "desktop.composer.send": "送信",
  "desktop.composer.steer": "割り込み送信",
  "desktop.composer.queue": "キューに追加",
  "desktop.composer.stop": "停止",
  "desktop.composer.queuedCount": "送信待ち（{count}）",
  "desktop.composer.sendNow": "今すぐ送信",
  "desktop.composer.editQueued": "編集に戻す",
  "desktop.composer.moveUp": "上へ移動",
  "desktop.composer.removeQueued": "削除",
  "desktop.composer.attachFile": "ファイルを添付",
  "desktop.composer.pastedBlock": "貼り付けテキスト（{lines} 行）",
  "desktop.composer.expandPasted": "本文に展開",
  "desktop.composer.takeover": "セッションを引き継ぐ",
  "desktop.composer.releaseToDesktop": "ターミナルへ戻す",
  "desktop.composer.contextUsage": "コンテキスト使用量",
  "desktop.composer.sendFailed": "送信に失敗しました。下書きと添付ファイルは保持されています。",

  "desktop.timeline.searchPlaceholder": "セッション内を検索",
  "desktop.timeline.outlineAll": "すべて",
  "desktop.timeline.outlineQuestions": "質問",
  "desktop.timeline.outlineApprovals": "承認",
  "desktop.timeline.outlineErrors": "エラー",
  "desktop.timeline.jumpToBottom": "最新へ移動",
  "desktop.timeline.waitingAnswer": "回答待ち",
  "desktop.timeline.waitingConfirm": "承認待ち",
  "desktop.timeline.waitingAction": "対応待ち",
  "desktop.timeline.toolNotSucceeded": "（非ゼロ終了）",
  "desktop.timeline.declined": "拒否済み",
  "desktop.timeline.stopped": "停止済み",
  "desktop.timeline.agentFailed": "エージェント失敗",
  "desktop.timeline.approve": "許可",
  "desktop.timeline.alwaysApprove": "常に許可",
  "desktop.timeline.deny": "拒否",
  "desktop.timeline.recommended": "推奨",
  "desktop.timeline.unifiedDiff": "統合表示",
  "desktop.timeline.splitDiff": "分割表示",
  "desktop.timeline.addLineComment": "行コメントを追加",
  "desktop.timeline.submitReview": "{count} 件のレビューコメントを送信",
  "desktop.timeline.cancelSubagent": "サブエージェントを停止",

  "desktop.inspector.changes": "変更差分",
  "desktop.inspector.sessionChanges": "セッション変更",
  "desktop.inspector.gitWorkspace": "Git 作業ツリー",
  "desktop.inspector.commit": "変更をコミット",
  "desktop.inspector.revertFile": "ファイルを元に戻す",
  "desktop.inspector.askAgentCommit": "エージェントにコミット / PR を依頼",
  "desktop.inspector.askAgentTest": "エージェントにテスト実行を依頼",
  "desktop.inspector.files": "ファイル",
  "desktop.inspector.showHidden": "隠しファイルを表示",
  "desktop.inspector.preview": "プレビュー",
  "desktop.inspector.source": "ソース",
  "desktop.inspector.download": "ダウンロード",
  "desktop.inspector.saveFile": "保存",
  "desktop.inspector.unsavedConfirm": "未保存の変更があります。破棄して移動しますか？",
  "desktop.inspector.openIn": "外部アプリで開く",
  "desktop.inspector.terminal": "ターミナル",
  "desktop.inspector.ports": "ポートプレビュー",
  "desktop.inspector.sendErrorToAgent": "エラーをエージェントに送って修正",
  "desktop.inspector.tasks": "タスク・サブエージェント",
  "desktop.inspector.side": "サイド質問",
  "desktop.inspector.goal": "ゴール",
  "desktop.inspector.settings": "セッション設定",
  "desktop.inspector.acp": "ACP エージェント設定",
  "desktop.inspector.mcp": "MCP アプリ・ツール",
  "desktop.inspector.connectors": "コネクタ",

  "desktop.screen.openDesktop": "画面を開く",
  "desktop.screen.start": "リモート画面を開始",
  "desktop.screen.stop": "切断",
  "desktop.screen.fullscreen": "フルスクリーン",
  "desktop.screen.exitFullscreen": "フルスクリーン終了",
  "desktop.screen.display": "ディスプレイ",
  "desktop.screen.clarity": "解像度",
  "desktop.screen.clarityAuto": "自動（ウィンドウに合わせる）",
  "desktop.screen.clarityNative": "ネイティブ（最大 4K）",
  "desktop.screen.fps": "フレームレート",
  "desktop.screen.codec": "コーデック",
  "desktop.screen.codecAuto": "自動（HEVC 優先）",
  "desktop.screen.codecH264": "互換 H.264",
  "desktop.screen.pacing": "フレーム制御",
  "desktop.screen.pacingImmediate": "最低遅延",
  "desktop.screen.pacingSmooth": "スムーズ優先",
  "desktop.screen.controlOn": "操作中",
  "desktop.screen.controlOff": "閲覧のみ",
  "desktop.screen.privacyCurtain": "プライバシーブラインド",
  "desktop.screen.lockOnDisconnect": "切断時に画面ロック",
  "desktop.screen.syncClipboard": "クリップボード同期",
  "desktop.screen.swapModifiers": "OS 間で ⌘ と Ctrl を入れ替え",
  "desktop.screen.taken": "別のデバイスがこの画面を引き継ぎました",
  "desktop.screen.idle": "無操作が続いたため中継ストリームを一時停止しました",
  "desktop.screen.grantPermission": "リモート側で画面収録とアクセシビリティを許可",

  "desktop.fusion.title": "融合モード",
  "desktop.fusion.subtitle": "リモート Mac のアプリを個別のネイティブウィンドウとしてこのデスクトップと Dock で実行します。",
  "desktop.fusion.start": "融合モードを開始",
  "desktop.fusion.stop": "融合モードを終了",
  "desktop.fusion.starting": "融合セッションを接続中",
  "desktop.fusion.modeDirect": "LAN / ダイレクト高速接続",
  "desktop.fusion.modeTunnel": "E2EE 中継トンネル接続",
  "desktop.fusion.openAppsFolder": "ローカルの融合アプリフォルダを開く",
  "desktop.fusion.launchApp": "アプリを起動",
  "desktop.fusion.quitApp": "リモートアプリを終了",
  "desktop.fusion.forceQuitApp": "強制終了",
  "desktop.fusion.windowCount": "{count} ウィンドウ",
  "desktop.fusion.searchApps": "リモート Mac のアプリを検索",
  "desktop.fusion.emptyApps": "リモート Mac のアプリ一覧を同期中",
  "desktop.fusion.reasonNotElectron": "融合モードは LinkShell macOS デスクトップアプリでのみ利用できます。",
  "desktop.fusion.reasonWindows": "Windows 版は macOS アプリ融合に非対応です。リモート画面をご利用ください。",
  "desktop.fusion.reasonNonMacClient": "融合モードには macOS クライアントが必要です。",
  "desktop.fusion.reasonLocal": "この Mac 上のアプリはそのままネイティブ実行できます。",
  "desktop.fusion.reasonNonMacRemote": "融合モードはリモートの macOS コンピュータ専用です。",
  "desktop.fusion.reasonNoComputer": "リモートの Mac を選択してください。",
  "desktop.fusion.outdatedHost": "リモートの LinkShell を最新バージョンに更新してから融合モードを開始してください。",
  "desktop.fusion.lockedHost": "融合アプリを開く前に LinkShell でアクセスパスワードを解除してください。",
  "desktop.fusion.offlineHost": "「{name}」は現在オフラインです。",

  "desktop.manage.overview": "概要",
  "desktop.manage.devices": "ペアリング済みデバイス",
  "desktop.manage.password": "アクセスパスワード",
  "desktop.manage.usage": "使用量と価値",
  "desktop.manage.log": "ホストログ",
  "desktop.manage.updates": "アップデート",
  "desktop.manage.settings": "設定",
  "desktop.manage.serviceRunning": "実行中",
  "desktop.manage.serviceStopped": "停止",
  "desktop.manage.serviceUnreachable": "接続不可",
  "desktop.manage.startService": "サービス開始",
  "desktop.manage.stopService": "サービス停止",
  "desktop.manage.restartService": "再起動",
  "desktop.manage.revokeDevice": "解除",
  "desktop.manage.revokeDeviceConfirm": "デバイス「{name}」のペアリングを解除しますか？再接続には再ペアリングが必要です。",
  "desktop.manage.generatePairCode": "6桁コードとQRコードを発行",
  "desktop.manage.gatewayOfficial": "公式ゲートウェイ（gateway.itool.tech）",
  "desktop.manage.gatewayCustom": "セルフホストゲートウェイ",
  "desktop.manage.gatewayOff": "オフ（ローカルのみ）",
  "desktop.manage.surfaceTranslucent": "半透明サイドバー",
  "desktop.manage.surfaceOpaque": "不透明ウィンドウ",
  "desktop.manage.launchAtLogin": "ログイン時に自動起動",
  "desktop.manage.installCli": "linkshell CLI コマンドをインストール",
  "desktop.manage.copyCliPath": "linkshell.cmd のパスをコピー",
  "desktop.manage.appearance": "外観モード",
  "desktop.manage.appearanceLight": "ライト",
  "desktop.manage.appearanceDark": "ダーク",
  "desktop.manage.appearanceSystem": "システム設定に従う",
};

export const DESKTOP_DICTIONARIES: Record<Locale, Record<DesktopI18nKey, string>> = {
  zh: desktopZh,
  en: desktopEn,
  ja: desktopJa,
};

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, token: string) => {
    const val = params[token];
    return val === undefined ? `{${token}}` : String(val);
  });
}

export function isDesktopI18nKey(key: string): key is DesktopI18nKey {
  return key in desktopZh;
}

export function translateDesktop(
  locale: Locale,
  key: AnyI18nKey,
  params?: Record<string, string | number>,
): string {
  if (isDesktopI18nKey(key)) {
    const template = DESKTOP_DICTIONARIES[locale]?.[key] ?? desktopZh[key];
    return interpolate(template, params);
  }
  return translateCore(locale, key, params);
}

export function useActiveDesktopPlatform(
  override?: DesktopPlatformKind,
): DesktopPlatformKind {
  const active = useSyncExternalStore(
    subscribeDesktopPlatform,
    getActiveDesktopPlatform,
    () => desktopPlatform,
  );
  return override ?? active;
}

export function resolveTargetPlatform(
  targetPlatform: string | undefined | null,
  fallback: DesktopPlatformKind = getActiveDesktopPlatform(),
): DesktopPlatformKind {
  return normalizeDesktopPlatform(targetPlatform) ?? fallback;
}

export function thisComputerLabel(
  locale: Locale = getDesktopLocale(),
  platform: DesktopPlatformKind = getActiveDesktopPlatform(),
): string {
  return translateDesktop(
    locale,
    platform === "macos" ? "desktop.platform.thisMac" : "desktop.platform.thisPc",
  );
}

export function thisComputerSpacedLabel(
  locale: Locale = getDesktopLocale(),
  platform: DesktopPlatformKind = getActiveDesktopPlatform(),
): string {
  const base = thisComputerLabel(locale, platform);
  if (locale === "zh" && platform === "macos") return `${base} `;
  return base;
}

export function revealInFilesLabel(
  locale: Locale = getDesktopLocale(),
  platform: DesktopPlatformKind = getActiveDesktopPlatform(),
): string {
  if (platform === "macos") return translateDesktop(locale, "desktop.platform.revealFinder");
  if (platform === "windows") return translateDesktop(locale, "desktop.platform.revealExplorer");
  return translateDesktop(locale, "desktop.platform.revealFileManager");
}

export function fileManagerLabel(
  locale: Locale = getDesktopLocale(),
  platform: DesktopPlatformKind = getActiveDesktopPlatform(),
): string {
  if (platform === "macos") return translateDesktop(locale, "desktop.platform.finder");
  if (platform === "windows") return translateDesktop(locale, "desktop.platform.explorer");
  return translateDesktop(locale, "desktop.platform.fileManager");
}

export interface LocaleState {
  preference: LocalePreference;
  locale: Locale;
}

function readStoredLocalePreference(): LocalePreference {
  const saved = readLocal<string>(STORAGE_KEYS.locale, "system");
  return isLocalePreference(saved) ? saved : "system";
}

function applyDocumentLang(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = dateLocaleTag(locale);
}

const initialPref = readStoredLocalePreference();
const initialLocale = resolveLocalePreference(initialPref);
syncCoreLocalePreference(initialPref);
applyDocumentLang(initialLocale);

export const localeStore = createStore<LocaleState>(() => ({
  preference: initialPref,
  locale: initialLocale,
}));

subscribeStorageReady(() => {
  const pref = readStoredLocalePreference();
  const nextLocale = resolveLocalePreference(pref);
  syncCoreLocalePreference(pref);
  applyDocumentLang(nextLocale);
  localeStore.setState({ preference: pref, locale: nextLocale });
});

export function getDesktopLocale(): Locale {
  return localeStore.getState().locale;
}

export function getDesktopLocalePreference(): LocalePreference {
  return localeStore.getState().preference;
}

export function setDesktopLocalePreference(preference: LocalePreference): Locale {
  const resolved = resolveLocalePreference(preference);
  saveLocal(STORAGE_KEYS.locale, preference);
  syncCoreLocalePreference(preference);
  applyDocumentLang(resolved);
  localeStore.setState({ preference, locale: resolved });
  return resolved;
}

export type TranslateFn = (key: AnyI18nKey, params?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => Locale;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { locale, preference } = useStore(localeStore);

  useEffect(() => {
    applyDocumentLang(locale);
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      preference,
      setPreference: setDesktopLocalePreference,
      t: (key, params) => translateDesktop(locale, key, params),
    }),
    [locale, preference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  const storeState = useStore(localeStore);
  return useMemo<I18nContextValue>(() => {
    if (context) return context;
    return {
      locale: storeState.locale,
      preference: storeState.preference,
      setPreference: setDesktopLocalePreference,
      t: (key, params) => translateDesktop(storeState.locale, key, params),
    };
  }, [context, storeState.locale, storeState.preference]);
}

export function useT(): TranslateFn {
  return useI18n().t;
}
