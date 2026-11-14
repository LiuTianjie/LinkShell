/**
 * Lightweight, zero-dependency, compile-time checked i18n dictionary and locale state helper
 * shared across Mobile (iOS/Android/Watch), Web, Desktop (Electron/macOS), and CLI.
 *
 * IMPORTANT (App Store Guideline 3.1.1):
 * `mobile.membership.*` strings are strictly informational — they contain ZERO purchase links,
 * ZERO checkout URLs, ZERO price tags, and ZERO buy/upgrade CTAs.
 * Desktop/Web upgrade CTAs live exclusively under `desktop.membership.*`.
 */

export type Locale = "zh" | "en" | "ja";
export type LocalePreference = "system" | Locale;

export const SUPPORTED_LOCALES: readonly Locale[] = ["zh", "en", "ja"] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "简体中文",
  en: "English",
  ja: "日本語",
} as const;

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en" || value === "ja";
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

export function dateLocaleTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en-US";
}

function parseLanguageTag(raw: string): Locale | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized.startsWith("zh") ||
    normalized.includes("-hans") ||
    normalized.includes("-hant") ||
    normalized.includes("_hans") ||
    normalized.includes("_hant")
  ) {
    return "zh";
  }
  if (normalized.startsWith("ja") || normalized === "jp") {
    return "ja";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  // Any other explicit non-empty locale tag defaults to English for international users.
  return "en";
}

function readEnvironmentLocale(): string | undefined {
  const nav = (globalThis as { navigator?: { language?: string; languages?: readonly string[] } }).navigator;
  if (nav?.language) return nav.language;
  if (nav?.languages?.length) return nav.languages[0];
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * Detects `Locale` (`"zh" | "en" | "ja"`) from an optional BCP-47 / POSIX locale string,
 * falling back to the runtime environment locale and finally `"en"`.
 */
export function detectLocale(input?: string): Locale {
  if (typeof input === "string" && input.trim().length > 0) {
    return parseLanguageTag(input) ?? "en";
  }
  const envTag = readEnvironmentLocale();
  if (envTag) {
    return parseLanguageTag(envTag) ?? "en";
  }
  return "en";
}

export function resolveLocalePreference(preference?: LocalePreference | string | null, systemLocale?: string): Locale {
  if (isLocale(preference)) return preference;
  return detectLocale(systemLocale);
}

const zh = {
  // Language selector
  "locale.label": "界面语言",
  "locale.system": "跟随系统",
  "locale.zh": "简体中文",
  "locale.en": "English",
  "locale.ja": "日本語",

  // Common actions
  "common.cancel": "取消",
  "common.confirm": "确认",
  "common.save": "保存",
  "common.copy": "复制",
  "common.copied": "已复制",
  "common.refresh": "刷新",
  "common.retry": "重试",
  "common.close": "关闭",
  "common.search": "搜索",
  "common.loading": "加载中…",
  "common.signOut": "退出",
  "common.signedIn": "已登录",

  // Navigation
  "nav.sessions": "会话",
  "nav.computer": "我的电脑",
  "nav.computers": "电脑",
  "nav.screen": "远程屏幕",
  "nav.fusion": "融合模式",
  "nav.terminals": "终端",
  "nav.files": "文件",
  "nav.ports": "端口预览",
  "nav.worktrees": "Worktree",
  "nav.changes": "改动",
  "nav.usage": "用量与价值",
  "nav.steward": "LSA 总管",
  "nav.account": "账号与电脑",
  "nav.settings": "设置",
  "nav.archived": "已归档",
  "nav.projects": "项目",
  "nav.commandCenter": "命令面板",

  // Connection states
  "connection.online": "已连接",
  "connection.offline": "未连接",
  "connection.connecting": "连接中",
  "connection.reconnecting": "正在恢复",
  "connection.locked": "需要密码",
  "connection.lanDirect": "局域网直连",
  "connection.gatewayRelay": "加密中继",
  "connection.reconnect": "重新连接",

  // Welcome / onboarding
  "welcome.restoringComputers": "正在恢复电脑列表…",
  "welcome.checkConnection": "需要检查连接设置",
  "welcome.cannotLoadComputers": "暂时无法读取电脑列表",
  "welcome.connectionRefusedHint": "连接被拒绝，请在「账号与电脑」中检查账号或配对状态后重试。",
  "welcome.offlineSavedHint": "账号仍保留在这台设备上。连接恢复后，会自动显示你的电脑。",
  "welcome.connectComputerTitle": "连接你的电脑",
  "welcome.connectComputerSubtitle": "Agent 在你的电脑上运行，LinkShell 让你随时随地接力掌控。先在电脑上安装桌面版或 CLI。",
  "welcome.desktopTitle": "桌面版 · macOS / Windows",
  "welcome.desktopDesc": "下载安装后打开 LinkShell，登录账号或显示配对码即可连接，无需配置环境。",
  "welcome.desktopInstallGuide": "查看下载与安装引导",
  "welcome.cliTitle": "CLI · 在电脑终端安装",
  "welcome.cliTapToCopy": "轻点复制 · 需要 Node.js 22.13 或更新版本",
  "welcome.scanQrToAdd": "扫码添加电脑",
  "welcome.signInAccount": "登录 iTool 账号",
  "welcome.accountAndComputers": "账号与电脑",
  "welcome.footerHint": "扫码：打开桌面版配对码，或在电脑运行 linkshell pair。同账号或同一局域网下的电脑可自动发现连接。",

  // Session states & outline/search
  "session.new": "新建会话",
  "session.untitled": "新会话",
  "session.idle": "空闲",
  "session.running": "运行中",
  "session.waiting": "等待确认",
  "session.waitingApproval": "等待审批",
  "session.waitingQuestion": "等待回答",
  "session.error": "执行出错",
  "session.offline": "电脑离线",
  "session.completed": "已完成",
  "session.thinking": "思考中…",
  "session.responding": "正在回复…",
  "session.usingTool": "正在使用工具…",
  "session.archive": "归档会话",
  "session.restore": "恢复会话",
  "session.delete": "删除会话",
  "session.rename": "重命名",
  "session.stop": "停止",
  "session.allow": "允许",
  "session.allowAlways": "总是允许",
  "session.reject": "拒绝",
  "session.rejectAndStop": "拒绝并停止",
  "session.searchPlaceholder": "在当前会话中搜索…",
  "session.outline": "回合大纲",
  "session.outlineAll": "全部",
  "session.outlinePrompts": "提问",
  "session.outlineApprovals": "审批",
  "session.outlineErrors": "报错",
  "session.noMatches": "未找到匹配内容",
  "session.ttsReadAloud": "语音播报摘要",
  "session.ttsEnabled": "通勤语音摘要已开启",
  "session.ttsDisabled": "通勤语音摘要已关闭",

  // Composer (`@file` autocomplete + quick prompts)
  "composer.placeholder": "输入指令，输入 / 调用斜杠命令，输入 @ 引用项目文件…",
  "composer.send": "发送",
  "composer.mentionFiles": "引用项目文件",
  "composer.mentionEmpty": "没有匹配的项目文件",
  "composer.mentionSearching": "正在检索项目文件…",
  "composer.quickPrompts": "快捷指令",
  "composer.quickRunTests": "跑测试并修报错",
  "composer.quickRunTestsPrompt": "请运行当前项目的测试套件，如果发现失败或类型错误请直接定位并修复。",
  "composer.quickSummarize": "总结当前改动",
  "composer.quickSummarizePrompt": "请简明总结目前的改动范围、关键设计决策以及尚未验证的风险点。",
  "composer.quickContinue": "继续推进",
  "composer.quickContinuePrompt": "请继续完成剩余步骤，并在完成后做一次完整自检。",
  "composer.quickCommitPr": "提交并创建 PR",
  "composer.quickCommitPrPrompt": "请检查当前 git 状态与 diff，整理清晰的 commit 提交，并推送分支创建或更新 PR。",

  // Changes & Diff panel
  "changes.title": "代码改动",
  "changes.sessionEdits": "本会话改动",
  "changes.gitWorkingTree": "Git 工作区 Diff",
  "changes.empty": "当前没有检测到未提交或本会话代码改动",
  "changes.truncated": "部分超大改动已截断显示",
  "changes.addComment": "添加行批注",
  "changes.commentPlaceholder": "写下针对这一行的修改意见…",
  "changes.saveComment": "保存批注",
  "changes.cancelComment": "取消",
  "changes.submitReview": "汇总发送批注 ({count})",
  "changes.reviewCount": "{count} 条批注",
  "changes.askCommitPr": "让 Agent 提交并提 PR",
  "changes.askCommitPrPrompt": "我已经审阅完当前改动，请整理清晰的 commit 信息提交代码，并推送分支创建 PR。",
  "changes.askRunTests": "跑测试自检",
  "changes.askRunTestsPrompt": "请针对当前工作区的所有改动运行相关单元测试与类型检查，确保全部通过。",
  "changes.revertFile": "还原文件",
  "changes.revertConfirmTitle": "确认还原文件？",
  "changes.revertConfirmBody": "这将丢弃 {path} 在工作区中的未提交改动，操作不可撤销。",
  "changes.reverted": "已还原 {path}",
  "changes.statusModified": "已修改",
  "changes.statusAdded": "新增",
  "changes.statusDeleted": "已删除",
  "changes.statusRenamed": "重命名",
  "changes.statusUntracked": "未跟踪",
  "changes.binaryFile": "二进制文件（不显示文本对比）",

  // Keep-awake & Battery telemetry
  "power.battery": "电池 {percent}%",
  "power.charging": "充电中 · {percent}%",
  "power.onBattery": "使用电池 · {percent}%",
  "power.pluggedIn": "已接通电源",
  "power.lowBatteryWarning": "电脑电量仅剩 {percent}% 且未插电，请注意防止断电休眠",
  "power.keepAwake": "防休眠策略",
  "power.keepAwakeSmart": "智能防休眠（推荐）",
  "power.keepAwakeSmartDesc": "会话运行、待审批或远程连接期间阻止系统休眠，空闲后自动释放",
  "power.keepAwakeAlways": "始终保持唤醒",
  "power.keepAwakeAlwaysDesc": "Host 运行期间始终阻止系统闲置睡眠（允许熄屏）",
  "power.keepAwakeOff": "跟随系统睡眠",
  "power.keepAwakeOffDesc": "不主动阻止电脑进入系统睡眠",
  "power.keepAwakeActive": "防休眠生效中",
  "power.keepAwakeIdle": "当前空闲可休眠",

  // Port preview & runtime error bridge
  "ports.readyPill": "localhost:{port} 已就绪",
  "ports.openPreview": "打开预览",
  "ports.errorsCount": "{count} 条运行报错",
  "ports.sendErrorsToAgent": "把这 {count} 条报错发给 Agent 修复",
  "ports.sendErrorsPromptPrefix": "端口预览页面捕获到以下前端运行时报错，请排查并修复：",
  "ports.empty": "当前没有检测到本地监听的 HTTP 服务",
  "ports.refresh": "刷新端口",

  // Remote screen toolbar, clipboard & privacy
  "screen.title": "远程屏幕",
  "screen.display": "显示器",
  "screen.quality": "画质",
  "screen.pasteToComputer": "粘贴到电脑",
  "screen.copyFromComputer": "读取电脑剪贴板",
  "screen.clipboardSynced": "剪贴板已同步",
  "screen.clipboardEmpty": "剪贴板为空",
  "screen.clipboardFailed": "剪贴板同步失败",
  "screen.privacyCurtain": "防窥黑屏",
  "screen.privacyCurtainOn": "远端防窥黑屏已开启",
  "screen.privacyCurtainOff": "远端防窥黑屏已关闭",
  "screen.lockOnDisconnect": "断开时自动锁屏",
  "screen.reconnect": "重连画面",
  "screen.fullscreen": "全屏",

  // Usage ROI & value report
  "usage.title": "用量与价值账单",
  "usage.estimatedApiValue": "等效 API 价值",
  "usage.subscriptionReferenceNote": "按公开模型 API 单价折算（订阅制用户仅供参考）",
  "usage.remoteTurns": "远程推进轮次",
  "usage.remoteApprovals": "远程完成审批",
  "usage.roiSummary": "近 {days} 天离席推进 {turns} 轮任务 · 远程审批 {approvals} 次 · 调度约 ${cost} 算力",
  "usage.totalTokens": "总 Token",
  "usage.sessions": "活跃会话",
  "usage.days1": "今日",
  "usage.days7": "近 7 天",
  "usage.days30": "近 30 天",

  // LinkShell Agent (LSA) Phase 1 Steward
  "lsa.title": "LSA 研发总管",
  "lsa.subtitle": "自动定位仓库、派发任务、回合后自动验收并跟进承诺",
  "lsa.yearlyBadge": "年度会员专属多机总管",
  "lsa.dispatchPlaceholder": "描述目标，例如：定位登录模块 bug 并在独立 Worktree 修复且跑通测试…",
  "lsa.dispatchAction": "派发任务",
  "lsa.activeTasks": "进行中任务",
  "lsa.waitingDecision": "待你拍板",
  "lsa.followups": "到期跟进",
  "lsa.memories": "长期记忆",
  "lsa.accept": "验收通过",
  "lsa.retry": "补充指导并重试",
  "lsa.cancel": "取消任务",
  "lsa.steerPlaceholder": "向总管追加指导意见…",
  "lsa.emptyTasks": "还没有派发给 LSA 总管的任务",

  // Mobile membership (STRICT App Store 3.1.1 safe: NO links, NO URLs, NO prices, NO buy CTAs!)
  "mobile.membership.title": "iTool 账户权益",
  "mobile.membership.loading": "正在确认账户状态…",
  "mobile.membership.unavailable": "账户状态暂不可用",
  "mobile.membership.readFailed": "状态读取失败，请重试",
  "mobile.membership.refresh": "刷新账户状态",
  "mobile.membership.refreshing": "正在刷新…",
  "mobile.membership.freeAccount": "基础账户",
  "mobile.membership.freeHint": "跨网官方中继网关需要有效的 iTool 账户权益（新注册账号确认邮箱即享 7 天免费体验）。可在电脑端 LinkShell 管理账户状态，回到此处自动同步；同一 Wi-Fi 下也可使用局域网直连或自建网关。",
  "mobile.membership.trialBadge": "7 天免费体验 · 剩余 {days} 天",
  "mobile.membership.validUntil": "LinkShell 有效期至 {date}",

  // Desktop & Web membership (Trial badge, renewal banner, upgrade CTAs, referral growth card)
  "desktop.membership.checking": "正在查询会员…",
  "desktop.membership.failed": "会员状态获取失败",
  "desktop.membership.refresh": "刷新会员状态",
  "desktop.membership.notSubscribed": "未开通会员",
  "desktop.membership.subscribeAction": "开通会员",
  "desktop.membership.upgradeYearlyAction": "升级年度",
  "desktop.membership.expiresOn": "{date}到期",
  "desktop.membership.trialBadge": "7 天免费试用 · 剩余 {days} 天",
  "desktop.membership.trialExpiringBanner": "免费试用仅剩 {days} 天，开通正式会员可继续无缝使用官方跨网中继网关",
  "desktop.membership.activateOfficialPlan": "开通正式会员",
  "desktop.membership.referralTitle": "邀请好友 · 双方各得 14 / 30 天",
  "desktop.membership.referralDesc": "分享专属链接给好友，好友首次开通月度会员双方各得 14 天，开通年度会员双方各得 30 天。",
  "desktop.membership.referralStats": "已邀请 {invited} 人 · 已获赠 {rewarded} 次 · 累计 +{days} 天",
  "desktop.membership.copyInviteLink": "复制邀请链接",
  "desktop.membership.copiedInviteLink": "已复制链接",

  // Android polish
  "android.checkForUpdate": "检查应用更新",
  "android.upToDate": "当前已是最新版本",
  "android.updateAvailable": "发现新版本 {version}",
  "android.backgroundServiceActive": "LinkShell 后台守护连接运行中",
} as const;

export type I18nKey = keyof typeof zh;
export type I18nVars = Record<string, string | number | undefined>;

const en: Record<I18nKey, string> = {
  "locale.label": "Language",
  "locale.system": "System Default",
  "locale.zh": "简体中文",
  "locale.en": "English",
  "locale.ja": "日本語",

  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.save": "Save",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.refresh": "Refresh",
  "common.retry": "Retry",
  "common.close": "Close",
  "common.search": "Search",
  "common.loading": "Loading…",
  "common.signOut": "Sign out",
  "common.signedIn": "Signed in",

  "nav.sessions": "Sessions",
  "nav.computer": "My Computer",
  "nav.computers": "Computers",
  "nav.screen": "Remote Screen",
  "nav.fusion": "Fusion",
  "nav.terminals": "Terminals",
  "nav.files": "Files",
  "nav.ports": "Port Previews",
  "nav.worktrees": "Worktrees",
  "nav.changes": "Changes",
  "nav.usage": "Usage & ROI",
  "nav.steward": "LSA Steward",
  "nav.account": "Account & Computers",
  "nav.settings": "Settings",
  "nav.archived": "Archived",
  "nav.projects": "Projects",
  "nav.commandCenter": "Command Palette",

  "connection.online": "Connected",
  "connection.offline": "Disconnected",
  "connection.connecting": "Connecting",
  "connection.reconnecting": "Reconnecting",
  "connection.locked": "Locked",
  "connection.lanDirect": "LAN Direct",
  "connection.gatewayRelay": "Encrypted Relay",
  "connection.reconnect": "Reconnect",

  "welcome.restoringComputers": "Restoring your computers…",
  "welcome.checkConnection": "Check connection settings",
  "welcome.cannotLoadComputers": "Unable to load computers right now",
  "welcome.connectionRefusedHint": "Connection was refused. Check your account or pairing status in Account & Computers and try again.",
  "welcome.offlineSavedHint": "Your account stays signed in on this device. Your computers will appear automatically once connected.",
  "welcome.connectComputerTitle": "Connect Your Computer",
  "welcome.connectComputerSubtitle": "Coding agents run on your computer while LinkShell lets you follow, steer, and approve from anywhere. Install the desktop app or CLI first.",
  "welcome.desktopTitle": "Desktop App · macOS / Windows",
  "welcome.desktopDesc": "Install and open LinkShell, then sign in or scan the pairing QR code — no runtime setup needed.",
  "welcome.desktopInstallGuide": "Download & Setup Guide",
  "welcome.cliTitle": "CLI · Install in Terminal",
  "welcome.cliTapToCopy": "Tap to copy · Requires Node.js 22.13+",
  "welcome.scanQrToAdd": "Scan QR to Pair",
  "welcome.signInAccount": "Sign in with iTool",
  "welcome.accountAndComputers": "Account & Computers",
  "welcome.footerHint": "Pair via QR (`linkshell pair`), sign in with the same account, or connect directly over local Wi-Fi.",

  "session.new": "New Session",
  "session.untitled": "Untitled Session",
  "session.idle": "Idle",
  "session.running": "Running",
  "session.waiting": "Waiting",
  "session.waitingApproval": "Needs Approval",
  "session.waitingQuestion": "Needs Input",
  "session.error": "Error",
  "session.offline": "Offline",
  "session.completed": "Completed",
  "session.thinking": "Thinking…",
  "session.responding": "Responding…",
  "session.usingTool": "Running tool…",
  "session.archive": "Archive",
  "session.restore": "Restore",
  "session.delete": "Delete",
  "session.rename": "Rename",
  "session.stop": "Stop",
  "session.allow": "Allow",
  "session.allowAlways": "Always Allow",
  "session.reject": "Decline",
  "session.rejectAndStop": "Decline & Stop",
  "session.searchPlaceholder": "Search in session…",
  "session.outline": "Turn Outline",
  "session.outlineAll": "All",
  "session.outlinePrompts": "Prompts",
  "session.outlineApprovals": "Approvals",
  "session.outlineErrors": "Errors",
  "session.noMatches": "No matching items",
  "session.ttsReadAloud": "Audio Summary",
  "session.ttsEnabled": "Commuter audio summary enabled",
  "session.ttsDisabled": "Commuter audio summary disabled",

  "composer.placeholder": "Ask anything, type / for commands, @ to mention files…",
  "composer.send": "Send",
  "composer.mentionFiles": "Project Files",
  "composer.mentionEmpty": "No matching files",
  "composer.mentionSearching": "Searching project files…",
  "composer.quickPrompts": "Quick Prompts",
  "composer.quickRunTests": "Run tests & fix",
  "composer.quickRunTestsPrompt": "Run the project's test suite and typecheck, then diagnose and fix any failures.",
  "composer.quickSummarize": "Summarize changes",
  "composer.quickSummarizePrompt": "Briefly summarize the changes made so far, key design choices, and any remaining risks.",
  "composer.quickContinue": "Continue",
  "composer.quickContinuePrompt": "Continue with the remaining steps and verify everything passes when done.",
  "composer.quickCommitPr": "Commit & PR",
  "composer.quickCommitPrPrompt": "Review git status and diff, create a clean commit, push the branch, and open or update a pull request.",

  "changes.title": "Changes",
  "changes.sessionEdits": "Session Edits",
  "changes.gitWorkingTree": "Git Working Tree",
  "changes.empty": "No uncommitted or session file changes detected",
  "changes.truncated": "Large diff output was truncated",
  "changes.addComment": "Add line comment",
  "changes.commentPlaceholder": "Add review feedback for this line…",
  "changes.saveComment": "Save Comment",
  "changes.cancelComment": "Cancel",
  "changes.submitReview": "Submit Review ({count})",
  "changes.reviewCount": "{count} comments",
  "changes.askCommitPr": "Ask Agent to Commit & PR",
  "changes.askCommitPrPrompt": "I have reviewed the current changes. Please stage, commit with a concise message, push the branch, and open a PR.",
  "changes.askRunTests": "Run Tests & Fix",
  "changes.askRunTestsPrompt": "Please run unit tests and typechecks covering all modified files in the working tree and fix any issues.",
  "changes.revertFile": "Revert File",
  "changes.revertConfirmTitle": "Revert file changes?",
  "changes.revertConfirmBody": "This permanently discards uncommitted working-tree changes in {path}.",
  "changes.reverted": "Reverted {path}",
  "changes.statusModified": "Modified",
  "changes.statusAdded": "Added",
  "changes.statusDeleted": "Deleted",
  "changes.statusRenamed": "Renamed",
  "changes.statusUntracked": "Untracked",
  "changes.binaryFile": "Binary file (diff not shown)",

  "power.battery": "Battery {percent}%",
  "power.charging": "Charging · {percent}%",
  "power.onBattery": "On Battery · {percent}%",
  "power.pluggedIn": "Plugged In",
  "power.lowBatteryWarning": "Host battery is at {percent}% unplugged — plug in to avoid sleep interruption",
  "power.keepAwake": "Keep-Awake",
  "power.keepAwakeSmart": "Smart (Recommended)",
  "power.keepAwakeSmartDesc": "Prevent system idle sleep while sessions run, await approval, or a remote client is active",
  "power.keepAwakeAlways": "Always Awake",
  "power.keepAwakeAlwaysDesc": "Prevent system idle sleep whenever LinkShell Host is running (display may still sleep)",
  "power.keepAwakeOff": "System Default",
  "power.keepAwakeOffDesc": "Allow the operating system to sleep normally when idle",
  "power.keepAwakeActive": "Keep-awake active",
  "power.keepAwakeIdle": "Idle sleep allowed",

  "ports.readyPill": "localhost:{port} Ready",
  "ports.openPreview": "Open Preview",
  "ports.errorsCount": "{count} runtime error(s)",
  "ports.sendErrorsToAgent": "Send {count} Error(s) to Agent",
  "ports.sendErrorsPromptPrefix": "The port preview captured the following frontend runtime errors — please investigate and fix them:",
  "ports.empty": "No local HTTP servers detected right now",
  "ports.refresh": "Refresh Ports",

  "screen.title": "Remote Screen",
  "screen.display": "Display",
  "screen.quality": "Quality",
  "screen.pasteToComputer": "Paste to Computer",
  "screen.copyFromComputer": "Copy from Computer",
  "screen.clipboardSynced": "Clipboard synced",
  "screen.clipboardEmpty": "Clipboard is empty",
  "screen.clipboardFailed": "Clipboard sync failed",
  "screen.privacyCurtain": "Privacy Curtain",
  "screen.privacyCurtainOn": "Privacy curtain enabled on host",
  "screen.privacyCurtainOff": "Privacy curtain disabled",
  "screen.lockOnDisconnect": "Lock on Disconnect",
  "screen.reconnect": "Reconnect",
  "screen.fullscreen": "Fullscreen",

  "usage.title": "Usage & Value",
  "usage.estimatedApiValue": "Est. API Value",
  "usage.subscriptionReferenceNote": "Estimated at public token API rates (for reference on flat-rate plans)",
  "usage.remoteTurns": "Remote Turns",
  "usage.remoteApprovals": "Remote Approvals",
  "usage.roiSummary": "Last {days}d: {turns} remote turns · {approvals} remote approvals · ~${cost} API compute orchestrated",
  "usage.totalTokens": "Total Tokens",
  "usage.sessions": "Sessions",
  "usage.days1": "24 Hours",
  "usage.days7": "7 Days",
  "usage.days30": "30 Days",

  "lsa.title": "LSA Steward",
  "lsa.subtitle": "Locates repos, dispatches isolated worktrees, verifies acceptance checks, and tracks follow-ups",
  "lsa.yearlyBadge": "Yearly Plan · Multi-Machine Steward",
  "lsa.dispatchPlaceholder": "Describe a goal, e.g. locate the auth repo, fix login bug in a worktree, and run tests…",
  "lsa.dispatchAction": "Dispatch Goal",
  "lsa.activeTasks": "Active Tasks",
  "lsa.waitingDecision": "Needs Decision",
  "lsa.followups": "Follow-ups",
  "lsa.memories": "Memories",
  "lsa.accept": "Accept",
  "lsa.retry": "Steer & Retry",
  "lsa.cancel": "Cancel Task",
  "lsa.steerPlaceholder": "Send guidance to Steward…",
  "lsa.emptyTasks": "No tasks dispatched to LSA Steward yet",

  // STRICT App Store 3.1.1 safe mobile strings
  "mobile.membership.title": "iTool Account Access",
  "mobile.membership.loading": "Checking account status…",
  "mobile.membership.unavailable": "Account status temporarily unavailable",
  "mobile.membership.readFailed": "Unable to read status, please retry",
  "mobile.membership.refresh": "Refresh Status",
  "mobile.membership.refreshing": "Refreshing…",
  "mobile.membership.freeAccount": "Standard Account",
  "mobile.membership.freeHint": "Official cross-network relay requires active iTool account access (new verified accounts include a 7-day free trial). Manage your account from LinkShell on your computer, or connect directly over local Wi-Fi or a self-hosted gateway.",
  "mobile.membership.trialBadge": "7-day trial · {days}d left",
  "mobile.membership.validUntil": "LinkShell active until {date}",

  // Desktop & Web membership strings
  "desktop.membership.checking": "Checking membership…",
  "desktop.membership.failed": "Failed to load membership",
  "desktop.membership.refresh": "Refresh membership",
  "desktop.membership.notSubscribed": "No active plan",
  "desktop.membership.subscribeAction": "Subscribe",
  "desktop.membership.upgradeYearlyAction": "Go Yearly",
  "desktop.membership.expiresOn": "Expires {date}",
  "desktop.membership.trialBadge": "7-day free trial · {days}d left",
  "desktop.membership.trialExpiringBanner": "{days} day(s) left in your free trial — subscribe to keep official cross-network gateway access active",
  "desktop.membership.activateOfficialPlan": "Activate Membership",
  "desktop.membership.referralTitle": "Invite Friends · Both Get 14 / 30 Days",
  "desktop.membership.referralDesc": "Share your invite link — when a friend subscribes, both of you receive +14 days (Monthly) or +30 days (Yearly).",
  "desktop.membership.referralStats": "Invited {invited} · Rewarded {rewarded} · Earned +{days} days",
  "desktop.membership.copyInviteLink": "Copy Invite Link",
  "desktop.membership.copiedInviteLink": "Link Copied",

  "android.checkForUpdate": "Check for App Updates",
  "android.upToDate": "You are on the latest version",
  "android.updateAvailable": "Update {version} available",
  "android.backgroundServiceActive": "LinkShell background relay monitor active",
};

const ja: Record<I18nKey, string> = {
  "locale.label": "表示言語",
  "locale.system": "システム設定に従う",
  "locale.zh": "简体中文",
  "locale.en": "English",
  "locale.ja": "日本語",

  "common.cancel": "キャンセル",
  "common.confirm": "確認",
  "common.save": "保存",
  "common.copy": "コピー",
  "common.copied": "コピーしました",
  "common.refresh": "更新",
  "common.retry": "再試行",
  "common.close": "閉じる",
  "common.search": "検索",
  "common.loading": "読み込み中…",
  "common.signOut": "ログアウト",
  "common.signedIn": "ログイン済み",

  "nav.sessions": "セッション",
  "nav.computer": "マイコンピュータ",
  "nav.computers": "コンピュータ",
  "nav.screen": "リモート画面",
  "nav.fusion": "フュージョン",
  "nav.terminals": "ターミナル",
  "nav.files": "ファイル",
  "nav.ports": "ポートプレビュー",
  "nav.worktrees": "Worktree",
  "nav.changes": "変更差分",
  "nav.usage": "利用量と価値",
  "nav.steward": "LSA スチュワード",
  "nav.account": "アカウントとPC",
  "nav.settings": "設定",
  "nav.archived": "アーカイブ済み",
  "nav.projects": "プロジェクト",
  "nav.commandCenter": "コマンドパレット",

  "connection.online": "接続済み",
  "connection.offline": "未接続",
  "connection.connecting": "接続中",
  "connection.reconnecting": "再接続中",
  "connection.locked": "ロック中",
  "connection.lanDirect": "LAN 直接接続",
  "connection.gatewayRelay": "暗号化リレー",
  "connection.reconnect": "再接続",

  "welcome.restoringComputers": "コンピュータ一覧を復元中…",
  "welcome.checkConnection": "接続設定を確認してください",
  "welcome.cannotLoadComputers": "コンピュータ一覧を読み込めません",
  "welcome.connectionRefusedHint": "接続が拒否されました。「アカウントとPC」でログイン状態やペアリングを確認してください。",
  "welcome.offlineSavedHint": "アカウントはこの端末に保持されています。接続が回復すると自動的にコンピュータが表示されます。",
  "welcome.connectComputerTitle": "コンピュータを接続",
  "welcome.connectComputerSubtitle": "コーディング Agent は PC 上で動作し、LinkShell で外出先から確認・指示・承認できます。まずデスクトップ版または CLI をインストールしてください。",
  "welcome.desktopTitle": "デスクトップ版 · macOS / Windows",
  "welcome.desktopDesc": "インストールして LinkShell を開き、ログインまたはペアリング QR コードを表示するだけで接続できます。",
  "welcome.desktopInstallGuide": "ダウンロードと導入ガイド",
  "welcome.cliTitle": "CLI · ターミナルで導入",
  "welcome.cliTapToCopy": "タップしてコピー · Node.js 22.13 以降が必要",
  "welcome.scanQrToAdd": "QR コードで追加",
  "welcome.signInAccount": "iTool アカウントでログイン",
  "welcome.accountAndComputers": "アカウントとPC",
  "welcome.footerHint": "QR ペアリング（linkshell pair）、同一アカウントでのログイン、または同一 Wi-Fi 上の LAN 直接接続に対応しています。",

  "session.new": "新規セッション",
  "session.untitled": "新しいセッション",
  "session.idle": "待機中",
  "session.running": "実行中",
  "session.waiting": "確認待ち",
  "session.waitingApproval": "承認待ち",
  "session.waitingQuestion": "回答待ち",
  "session.error": "エラー",
  "session.offline": "オフライン",
  "session.completed": "完了",
  "session.thinking": "思考中…",
  "session.responding": "応答中…",
  "session.usingTool": "ツール実行中…",
  "session.archive": "アーカイブ",
  "session.restore": "復元",
  "session.delete": "削除",
  "session.rename": "名前を変更",
  "session.stop": "停止",
  "session.allow": "許可",
  "session.allowAlways": "常に許可",
  "session.reject": "拒否",
  "session.rejectAndStop": "拒否して停止",
  "session.searchPlaceholder": "セッション内を検索…",
  "session.outline": "ターン目次",
  "session.outlineAll": "すべて",
  "session.outlinePrompts": "質問",
  "session.outlineApprovals": "承認",
  "session.outlineErrors": "エラー",
  "session.noMatches": "一致する項目がありません",
  "session.ttsReadAloud": "音声要約読み上げ",
  "session.ttsEnabled": "音声要約オン",
  "session.ttsDisabled": "音声要約オフ",

  "composer.placeholder": "指示を入力（/ でコマンド、@ でプロジェクトファイル参照）…",
  "composer.send": "送信",
  "composer.mentionFiles": "ファイルを参照",
  "composer.mentionEmpty": "一致するファイルがありません",
  "composer.mentionSearching": "プロジェクトファイルを検索中…",
  "composer.quickPrompts": "クイック指示",
  "composer.quickRunTests": "テスト実行と修正",
  "composer.quickRunTestsPrompt": "プロジェクトのテストと型チェックを実行し、失敗があれば原因を特定して修正してください。",
  "composer.quickSummarize": "変更点を要約",
  "composer.quickSummarizePrompt": "これまでの変更範囲、主な設計判断、未検証のリスクを簡潔にまとめてください。",
  "composer.quickContinue": "続行する",
  "composer.quickContinuePrompt": "残りの作業を進め、完了後にセルフチェックを行ってください。",
  "composer.quickCommitPr": "コミットして PR 作成",
  "composer.quickCommitPrPrompt": "git status と diff を確認し、適切なコミットを作成してブランチを push し、PR を作成または更新してください。",

  "changes.title": "変更差分",
  "changes.sessionEdits": "セッション編集",
  "changes.gitWorkingTree": "Git 作業ツリー Diff",
  "changes.empty": "未コミットまたはセッション内の変更はありません",
  "changes.truncated": "大きな差分の一部は省略されています",
  "changes.addComment": "行コメントを追加",
  "changes.commentPlaceholder": "この行へのレビューコメントを入力…",
  "changes.saveComment": "コメント保存",
  "changes.cancelComment": "キャンセル",
  "changes.submitReview": "レビューを送信 ({count})",
  "changes.reviewCount": "{count} 件のコメント",
  "changes.askCommitPr": "Agent にコミット & PR を依頼",
  "changes.askCommitPrPrompt": "変更内容を確認しました。整理されたコミットメッセージでコミットし、ブランチを push して PR を作成してください。",
  "changes.askRunTests": "テストを実行",
  "changes.askRunTestsPrompt": "作業ツリー内の変更ファイルに関連するテストと型チェックを実行し、すべて通過することを確認してください。",
  "changes.revertFile": "変更を元に戻す",
  "changes.revertConfirmTitle": "ファイルの変更を破棄しますか？",
  "changes.revertConfirmBody": "{path} の未コミットの変更を破棄します。この操作は取り消せません。",
  "changes.reverted": "{path} を元に戻しました",
  "changes.statusModified": "変更",
  "changes.statusAdded": "追加",
  "changes.statusDeleted": "削除",
  "changes.statusRenamed": "名前変更",
  "changes.statusUntracked": "未追跡",
  "changes.binaryFile": "バイナリファイル（差分非表示）",

  "power.battery": "バッテリー {percent}%",
  "power.charging": "充電中 · {percent}%",
  "power.onBattery": "バッテリー駆動 · {percent}%",
  "power.pluggedIn": "電源接続済み",
  "power.lowBatteryWarning": "PC のバッテリー残量が {percent}%（未充電）です。スリープ切断にご注意ください",
  "power.keepAwake": "スリープ防止",
  "power.keepAwakeSmart": "スマート（推奨）",
  "power.keepAwakeSmartDesc": "タスク実行中・承認待ち・リモート接続中のみシステムスリープを防止し、待機時は解除します",
  "power.keepAwakeAlways": "常にスリープ防止",
  "power.keepAwakeAlwaysDesc": "Host 起動中は常にシステムのスリープを防止します（画面オフは許可）",
  "power.keepAwakeOff": "システム設定に従う",
  "power.keepAwakeOffDesc": "システムのスリープ動作を変更しません",
  "power.keepAwakeActive": "スリープ防止有効",
  "power.keepAwakeIdle": "アイドルスリープ許可",

  "ports.readyPill": "localhost:{port} 準備完了",
  "ports.openPreview": "プレビューを開く",
  "ports.errorsCount": "{count} 件の実行時エラー",
  "ports.sendErrorsToAgent": "{count} 件のエラーを Agent に送って修正",
  "ports.sendErrorsPromptPrefix": "ポートプレビューで以下のフロントエンド実行時エラーが検出されました。原因を調べて修正してください：",
  "ports.empty": "ローカルの HTTP サーバーは検出されていません",
  "ports.refresh": "ポート更新",

  "screen.title": "リモート画面",
  "screen.display": "ディスプレイ",
  "screen.quality": "画質",
  "screen.pasteToComputer": "PC へ貼り付け",
  "screen.copyFromComputer": "PC のクリップボード取得",
  "screen.clipboardSynced": "クリップボードを同期しました",
  "screen.clipboardEmpty": "クリップボードは空です",
  "screen.clipboardFailed": "クリップボード同期に失敗しました",
  "screen.privacyCurtain": "プライバシーブラインド",
  "screen.privacyCurtainOn": "PC 側の画面ブラインドを有効化しました",
  "screen.privacyCurtainOff": "PC 側の画面ブラインドを解除しました",
  "screen.lockOnDisconnect": "切断時に自動ロック",
  "screen.reconnect": "再接続",
  "screen.fullscreen": "全画面",

  "usage.title": "利用量と価値レポート",
  "usage.estimatedApiValue": "API 換算価値",
  "usage.subscriptionReferenceNote": "公開 API 単価に基づく参考換算値（定額プラン利用時の目安）",
  "usage.remoteTurns": "リモート実行ターン",
  "usage.remoteApprovals": "リモート承認回数",
  "usage.roiSummary": "直近 {days} 日間：リモート進行 {turns} ターン · 承認 {approvals} 回 · 約 ${cost} 相当の計算量を制御",
  "usage.totalTokens": "合計トークン",
  "usage.sessions": "セッション数",
  "usage.days1": "24時間",
  "usage.days7": "7日間",
  "usage.days30": "30日間",

  "lsa.title": "LSA スチュワード",
  "lsa.subtitle": "リポジトリ特定・Worktree 振り分け・ターン後の自動検収・フォローアップ管理",
  "lsa.yearlyBadge": "年額プラン特典 · マルチPC総括",
  "lsa.dispatchPlaceholder": "目標を入力（例：認証リポジトリを特定し、独立 Worktree でログイン不具合を修正してテストを通す）…",
  "lsa.dispatchAction": "タスクを委任",
  "lsa.activeTasks": "進行中タスク",
  "lsa.waitingDecision": "判断待ち",
  "lsa.followups": "リマインダー",
  "lsa.memories": "長期メモリ",
  "lsa.accept": "検収承認",
  "lsa.retry": "指示を追加して再試行",
  "lsa.cancel": "タスク中止",
  "lsa.steerPlaceholder": "スチュワードへ追加指示を送信…",
  "lsa.emptyTasks": "LSA スチュワードに委任されたタスクはまだありません",

  // STRICT App Store 3.1.1 safe mobile strings
  "mobile.membership.title": "iTool アカウント状態",
  "mobile.membership.loading": "アカウント状態を確認中…",
  "mobile.membership.unavailable": "アカウント状態を取得できません",
  "mobile.membership.readFailed": "状態の読み込みに失敗しました。再試行してください",
  "mobile.membership.refresh": "状態を更新",
  "mobile.membership.refreshing": "更新中…",
  "mobile.membership.freeAccount": "スタンダードアカウント",
  "mobile.membership.freeHint": "公式リレーゲートウェイの利用には有効な iTool アカウント権限が必要です（新規確認済みアカウントは7日間無料体験対象）。PC 版 LinkShell でアカウントを管理するとここに自動反映されます。同一 Wi-Fi 内の LAN 直接接続やセルフホストも利用可能です。",
  "mobile.membership.trialBadge": "7日間トライアル · 残り {days} 日",
  "mobile.membership.validUntil": "LinkShell 有効期限：{date}",

  // Desktop & Web membership strings
  "desktop.membership.checking": "メンバーシップを確認中…",
  "desktop.membership.failed": "メンバーシップの取得に失敗しました",
  "desktop.membership.refresh": "メンバーシップを更新",
  "desktop.membership.notSubscribed": "未契約",
  "desktop.membership.subscribeAction": "プラン登録",
  "desktop.membership.upgradeYearlyAction": "年額プランへ",
  "desktop.membership.expiresOn": "{date} まで有効",
  "desktop.membership.trialBadge": "7日間無料トライアル · 残り {days} 日",
  "desktop.membership.trialExpiringBanner": "無料トライアルは残り {days} 日です。公式リレーゲートウェイを継続利用するにはメンバーシップを有効化してください",
  "desktop.membership.activateOfficialPlan": "メンバーシップを有効化",
  "desktop.membership.referralTitle": "友だち招待 · お互いに 14 / 30 日間プレゼント",
  "desktop.membership.referralDesc": "招待リンクから友だちが初回登録すると、月額なら双方に +14 日、年額なら双方に +30 日が付与されます。",
  "desktop.membership.referralStats": "招待 {invited} 人 · 特典成立 {rewarded} 回 · 獲得 +{days} 日",
  "desktop.membership.copyInviteLink": "招待リンクをコピー",
  "desktop.membership.copiedInviteLink": "コピーしました",

  "android.checkForUpdate": "アプリの更新を確認",
  "android.upToDate": "最新バージョンをご利用中です",
  "android.updateAvailable": "新しいバージョン {version} があります",
  "android.backgroundServiceActive": "LinkShell バックグラウンド接続モニター稼働中",
};

export const I18N_DICTIONARY: Record<Locale, Record<I18nKey, string>> = {
  zh,
  en,
  ja,
};

/**
 * Translates `key` in `locale` with `{placeholder}` variable interpolation.
 */
export function t(locale: Locale, key: I18nKey, vars?: I18nVars): string {
  const table = I18N_DICTIONARY[locale] ?? I18N_DICTIONARY.en;
  const template = table[key] ?? I18N_DICTIONARY.en[key] ?? I18N_DICTIONARY.zh[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

export function createTranslator(locale: Locale) {
  return (key: I18nKey, vars?: I18nVars): string => t(locale, key, vars);
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LOCALE_STORAGE_KEY = "linkshell.locale.v1";

export type LocaleListener = (locale: Locale, preference: LocalePreference) => void;

export interface LocaleStore {
  getLocale(): Locale;
  getPreference(): LocalePreference;
  setPreference(preference: LocalePreference, systemLocale?: string): Locale;
  setSystemLocale(systemLocale?: string): Locale;
  subscribe(listener: LocaleListener): () => void;
  t(key: I18nKey, vars?: I18nVars): string;
}

export function createLocaleStore(options?: { storage?: LocaleStorage; systemLocale?: string }): LocaleStore {
  let systemLocale = options?.systemLocale;
  let preference: LocalePreference = "system";
  try {
    const raw = options?.storage?.getItem(LOCALE_STORAGE_KEY);
    if (raw && isLocalePreference(raw.trim())) {
      preference = raw.trim() as LocalePreference;
    }
  } catch {
    // Storage access errors must never break rendering.
  }
  let current: Locale = resolveLocalePreference(preference, systemLocale);
  const listeners = new Set<LocaleListener>();

  const notify = () => {
    for (const listener of listeners) listener(current, preference);
  };

  return {
    getLocale: () => current,
    getPreference: () => preference,
    setPreference(next: LocalePreference, nextSystemLocale?: string): Locale {
      if (nextSystemLocale !== undefined) systemLocale = nextSystemLocale;
      preference = isLocalePreference(next) ? next : "system";
      try {
        options?.storage?.setItem(LOCALE_STORAGE_KEY, preference);
      } catch {
        // Ignore storage write errors.
      }
      const resolved = resolveLocalePreference(preference, systemLocale);
      current = resolved;
      notify();
      return current;
    },
    setSystemLocale(nextSystemLocale?: string): Locale {
      systemLocale = nextSystemLocale;
      const resolved = resolveLocalePreference(preference, systemLocale);
      if (resolved !== current) {
        current = resolved;
        notify();
      }
      return current;
    },
    subscribe(listener: LocaleListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    t: (key: I18nKey, vars?: I18nVars) => t(current, key, vars),
  };
}

function defaultBrowserStorage(): LocaleStorage | undefined {
  try {
    const ls = (globalThis as { localStorage?: LocaleStorage }).localStorage;
    if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") return ls;
  } catch {
    // Sandbox / React Native without global localStorage.
  }
  return undefined;
}

export const defaultLocaleStore: LocaleStore = createLocaleStore({ storage: defaultBrowserStorage() });

export function getLocale(): Locale {
  return defaultLocaleStore.getLocale();
}

export function getLocalePreference(): LocalePreference {
  return defaultLocaleStore.getPreference();
}

export function setLocalePreference(preference: LocalePreference, systemLocale?: string): Locale {
  return defaultLocaleStore.setPreference(preference, systemLocale);
}

export function subscribeLocale(listener: LocaleListener): () => void {
  return defaultLocaleStore.subscribe(listener);
}
