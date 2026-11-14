import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  presentError,
  proposedPlan,
  toolCommand,
  toolLabel,
  toolLabelText,
  toolOutput,
  userMessageView,
  type ClientActions,
  type ClientState,
  type TimelineItem,
} from "@linkshell/client-core";
import {
  displayModelName,
  type AgentInfo,
  type ContentBlock,
  type SessionConfigOption,
} from "@linkshell/wire";
import {
  DESKTOP_LOCAL,
  engine,
  fileToBase64,
  formatOptionValueName,
  reportDesktopError,
  shrinkImage,
  useI18n,
  validateAttachmentSize,
  type Connection,
  type Locale,
} from "@/core";
import type { PastedTextBlock } from "@/core";
import type { DesktopIconName } from "@/icons";
import { openFileTabInInspector } from "../inspector/inspector-tabs-store";

/* ============================================================================
 * Connection & Client Store Hooks
 * ============================================================================ */

export function useSessionConnection(computerKey: string): Connection | undefined {
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);

  const matchedComputer = useMemo(
    () => engine.computerForKey(computerKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [computerKey, computers, localComputer],
  );
  const matchedComputerRef = useRef(matchedComputer);
  matchedComputerRef.current = matchedComputer;
  const lastSyncedRouteKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!computerKey) {
      lastSyncedRouteKeyRef.current = undefined;
      return;
    }
    if (lastSyncedRouteKeyRef.current === computerKey) return;
    const target = matchedComputerRef.current;
    if (!target) return;
    lastSyncedRouteKeyRef.current = computerKey;
    if (engine.state.getState().connection?.computer.key === target.key) return;
    try {
      engine.select(target);
    } catch {
      // Engine may not be booted in isolated component unit tests where `engine.state` holds a mock connection.
    }
  }, [computerKey, matchedComputer?.key]);

  if (activeConnection?.computer.key === computerKey) {
    return activeConnection;
  }
  if (
    activeConnection &&
    matchedComputer &&
    activeConnection.computer.key === matchedComputer.key
  ) {
    return activeConnection;
  }
  return activeConnection && !computerKey ? activeConnection : undefined;
}

const FALLBACK_STORE = createStore<Record<string, never>>(() => ({}));

export function useClientSelector<T>(
  connection: Connection | undefined,
  selector: (state: ClientState & ClientActions) => T,
  fallback: T,
): T {
  const store = connection?.store ?? FALLBACK_STORE;
  return useStore(store as never, (state) =>
    connection ? selector(state as ClientState & ClientActions) : fallback,
  );
}

/* ============================================================================
 * Shared Session UI Store (Syncs Shell Titlebar Actions <-> Session Workspace)
 * ============================================================================ */

export interface SessionUiEntry {
  searchOpen: boolean;
  searchQuery: string;
  scrollToItemId?: string;
  scrollNonce: number;
  /** Bumped when the person sends: the timeline goes back to its newest message, as the old client did on `sentId`. */
  followNonce: number;
}

interface SessionUiState {
  byKey: Record<string, SessionUiEntry>;
  setSearchOpen(key: string, open: boolean): void;
  toggleSearch(key: string): void;
  setSearchQuery(key: string, query: string): void;
  requestScrollToItem(key: string, itemId: string): void;
  requestFollow(key: string): void;
}

const DEFAULT_UI_ENTRY: SessionUiEntry = {
  searchOpen: false,
  searchQuery: "",
  scrollNonce: 0,
  followNonce: 0,
};

export function sessionKeyOf(computerKey: string, sessionId: string): string {
  return `${computerKey}\n${sessionId}`;
}

export const sessionUiStore = createStore<SessionUiState>((set) => ({
  byKey: {},
  setSearchOpen: (key, open) =>
    set((state) => {
      const current = state.byKey[key] ?? DEFAULT_UI_ENTRY;
      return {
        byKey: {
          ...state.byKey,
          [key]: {
            ...current,
            searchOpen: open,
            searchQuery: open ? current.searchQuery : "",
          },
        },
      };
    }),
  toggleSearch: (key) =>
    set((state) => {
      const current = state.byKey[key] ?? DEFAULT_UI_ENTRY;
      const nextOpen = !current.searchOpen;
      return {
        byKey: {
          ...state.byKey,
          [key]: {
            ...current,
            searchOpen: nextOpen,
            searchQuery: nextOpen ? current.searchQuery : "",
          },
        },
      };
    }),
  setSearchQuery: (key, query) =>
    set((state) => {
      const current = state.byKey[key] ?? DEFAULT_UI_ENTRY;
      return {
        byKey: {
          ...state.byKey,
          [key]: { ...current, searchOpen: true, searchQuery: query },
        },
      };
    }),
  requestScrollToItem: (key, itemId) =>
    set((state) => {
      const current = state.byKey[key] ?? DEFAULT_UI_ENTRY;
      return {
        byKey: {
          ...state.byKey,
          [key]: {
            ...current,
            scrollToItemId: itemId,
            scrollNonce: current.scrollNonce + 1,
          },
        },
      };
    }),
  requestFollow: (key) =>
    set((state) => {
      const current = state.byKey[key] ?? DEFAULT_UI_ENTRY;
      return {
        byKey: {
          ...state.byKey,
          [key]: { ...current, followNonce: (current.followNonce ?? 0) + 1 },
        },
      };
    }),
}));

/** Fire-and-forget actions still owe the person feedback when they fail. */
export function reportOnFailure(promise: Promise<unknown>): void {
  void promise.catch((error: unknown) => reportDesktopError(error));
}

const READABLE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * The host words its own errors for people (in Chinese); transport and library errors come in
 * English. Those get the caller's localized fallback instead of being shown raw.
 */
export function describeActionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message && READABLE_SCRIPT.test(message) ? message : fallback;
}

export function useSessionUi(computerKey: string, sessionId: string): SessionUiEntry {
  const key = sessionKeyOf(computerKey, sessionId);
  return useStore(sessionUiStore, (state) => state.byKey[key] ?? DEFAULT_UI_ENTRY);
}

/* ============================================================================
 * Inspector File Navigation Bridge
 * ============================================================================ */

export const INSPECTOR_OPEN_FILE_EVENT = "linkshell-inspector-open-file";

export function openFileInInspector(
  computerKey: string,
  sessionId: string | undefined,
  path: string,
  line?: number,
  endLine?: number,
): void {
  const spec =
    typeof line === "number" && line > 0
      ? typeof endLine === "number" && endLine > line
        ? `${path}#L${line}-L${endLine}`
        : `${path}#L${line}`
      : path;
  openFileTabInInspector(computerKey, sessionId, spec, { openPanel: true });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(INSPECTOR_OPEN_FILE_EVENT, {
        detail: { computerKey, sessionId, path, line },
      }),
    );
  }
}

/* ============================================================================
 * Localized Session Copy (`zh` / `en` / `ja`)
 * ============================================================================ */

export interface SessionCopy {
  // New Session
  newSessionHeading: string;
  newSessionSubheading: string;
  taskLabel: string;
  startSessionLabel: string;
  selectModelLabel: string;
  selectDirectory: string;
  browseDirectory: string;
  recentProjects: string;
  noAgentsInstalled: string;
  agentUnavailable: string;
  worktreeHintClean: string;
  worktreeHintDirty: string;
  loadingModels: string;
  defaultModel: string;
  refreshModels: string;
  startingSession: string;
  directoryPlaceholder: string;
  newFolder: string;
  folderNamePrompt: string;
  useThisDirectory: string;
  parentDirectory: string;
  searchDirectories: string;
  emptyDirectory: string;

  // Composer
  composerPlaceholder: string;
  composerBusyPlaceholder: string;
  desktopDrivenBanner: string;
  dropFilesHint: string;
  commandsHeading: string;
  filesHeading: string;
  noMatchingFiles: string;
  retryFailed: string;
  discardFailed: string;
  cycleModeHint: string;
  clearReviews: string;

  // Timeline & Cards
  loadEarlier: string;
  loadingEarlier: string;
  beginningOfSession: string;
  emptyTimeline: string;
  youLabel: string;
  thoughtLabel: string;
  planLabel: string;
  wrapUpLabel: string;
  forkFromHere: string;
  copyMessage: string;
  pendingDelivery: string;
  acceptedDelivery: string;
  failedDelivery: string;
  expandSteps: (count: number) => string;
  collapseSteps: string;
  viewFullParams: string;
  toolParamsAria: string;
  openConsentUrl: string;
  urlConsentWarning: (url: string) => string;
  submitAnswers: string;
  otherOption: string;
  otherPlaceholder: string;
  answerPlaceholder: string;
  asyncQuestionBadge: string;
  replyAction: string;
  subagentRunning: string;
  subagentDone: string;
  subagentStopped: string;

  // Header & Outline
  turnOutlineLabel: string;
  findInSession: string;
  closeFind: string;
  matchesCount: (count: number) => string;
  openInEditor: string;
  openInCursor: string;
  openInVsCode: string;
  openInZed: string;
  openInTerminal: string;
  moreSessionActions: string;
  sessionNotFound: string;
  connectingComputer: string;

  // Diff review
  reviewPlaceholder: string;
  saveComment: string;
  cancelAction: string;
  deleteComment: string;

  // Floating Context Status Pills (Paseo / T3 Code)
  tasksPillLabel: (done: number, total: number) => string;
  subagentsPillLabel: (count: number, running: number) => string;
  viewChangesLabel: string;
  viewErrorDetails: string;
  hideErrorDetails: string;
  copyBranch: string;
  branchCopied: string;

  // Delivery, loading and recovery states
  loadingHistory: string;
  turnElapsed: string;
  sendingPrompt: string;
  startingTurn: string;
  sendFailedKept: string;
  offlineSendBlocked: string;
  firstMessageNotSent: (detail: string) => string;
  actionFailed: string;
  wrapUpAppHint: string;
  wrapUpSendFailed: string;
  imageLabel: string;
  attachedImage: string;
  subagentFallback: string;
  dismissNotice: string;
  sessionCardStates: Record<"starting" | "started" | "proposed" | "failed", string>;
  openSessionTitle: (title: string) => string;
  findPrevious: string;
  findNext: string;
  noMatches: string;
  matchPosition: (index: number, total: number) => string;
  retryModels: string;
  loadingDirectory: string;
  directoryLoadFailed: string;
}

const COPY_BY_LOCALE: Record<Locale, SessionCopy> = {
  zh: {
    newSessionHeading: "新建会话",
    newSessionSubheading: "选好智能体和工作目录，写下任务就开始；留空则直接进入会话。",
    taskLabel: "任务描述",
    startSessionLabel: "开始会话",
    selectModelLabel: "选择模型",
    selectDirectory: "选择工作目录",
    browseDirectory: "浏览目录",
    recentProjects: "最近项目",
    noAgentsInstalled: "当前电脑尚未检测到可用的编码智能体（Claude Code / Codex / ACP）。",
    agentUnavailable: "未安装或未登录",
    worktreeHintClean: "将在独立 Git Worktree 分支中隔离运行，不改动当前工作区。",
    worktreeHintDirty: "注意：新 Worktree 从最近一次提交检出，不包含当前未提交修改。",
    loadingModels: "加载模型",
    defaultModel: "默认模型",
    refreshModels: "刷新模型列表",
    startingSession: "正在启动",
    directoryPlaceholder: "输入或选择项目路径",
    newFolder: "新建文件夹",
    folderNamePrompt: "新文件夹名称",
    useThisDirectory: "使用此目录",
    parentDirectory: "上一级",
    searchDirectories: "筛选子目录",
    emptyDirectory: "此目录下没有子文件夹",

    composerPlaceholder: "输入任务、@引用文件、粘贴图片，或输入 / 执行命令",
    composerBusyPlaceholder: "继续补充说明：回车加入发送队列，或点击「插话」立即送达",
    desktopDrivenBanner: "此会话当前在电脑终端中操作，接管后即可在此继续对话。",
    dropFilesHint: "松开以添加附件（单文件上限 20 MB）",
    commandsHeading: "斜杠命令",
    filesHeading: "引用项目文件",
    noMatchingFiles: "未找到匹配文件",
    retryFailed: "重试发送",
    discardFailed: "放弃",
    cycleModeHint: "Shift+Tab 切换模式",
    clearReviews: "清空批注",

    loadEarlier: "加载更早记录",
    loadingEarlier: "正在加载历史记录",
    beginningOfSession: "已显示会话起点",
    emptyTimeline: "会话已就绪，在下方输入框发送第一条指令。",
    youLabel: "你",
    thoughtLabel: "思考过程",
    planLabel: "执行计划",
    wrapUpLabel: "阶段总结",
    forkFromHere: "从此处分叉会话",
    copyMessage: "复制内容",
    pendingDelivery: "发送中",
    acceptedDelivery: "已送达",
    failedDelivery: "发送失败",
    expandSteps: (count) => `展开 ${count} 步详情`,
    collapseSteps: "收起步骤",
    viewFullParams: "查看完整参数",
    toolParamsAria: "待批准的工具参数",
    openConsentUrl: "在浏览器中打开授权链接",
    urlConsentWarning: (url) => `即将使用系统默认浏览器打开外部链接：\n${url}`,
    submitAnswers: "提交回答",
    otherOption: "其他（自定义输入）",
    otherPlaceholder: "填写自定义内容",
    answerPlaceholder: "输入你的回答",
    asyncQuestionBadge: "可稍后回答",
    replyAction: "发送回答",
    subagentRunning: "子智能体运行中",
    subagentDone: "子智能体已完成",
    subagentStopped: "已停止",

    turnOutlineLabel: "对话大纲与跳转",
    findInSession: "会话内查找",
    closeFind: "关闭查找",
    matchesCount: (count) => `${count} 处匹配`,
    openInEditor: "打开项目",
    openInCursor: "在 Cursor 中打开",
    openInVsCode: "在 VS Code 中打开",
    openInZed: "在 Zed 中打开",
    openInTerminal: "在系统终端中打开",
    moreSessionActions: "更多会话操作",
    sessionNotFound: "正在同步会话状态",
    connectingComputer: "正在连接电脑",

    reviewPlaceholder: "输入对这几行代码的修改意见",
    saveComment: "添加批注",
    cancelAction: "取消",
    deleteComment: "删除",

    tasksPillLabel: (done, total) => `${done}/${total} 任务`,
    subagentsPillLabel: (count, running) =>
      running > 0 ? `${count} 子代理 · ${running} 运行中` : `${count} 子代理`,
    viewChangesLabel: "查看代码变更",
    viewErrorDetails: "查看详情",
    hideErrorDetails: "收起详情",
    copyBranch: "复制分支名",
    branchCopied: "已复制分支名",
    loadingHistory: "正在加载会话记录",
    turnElapsed: "本轮已进行",
    sendingPrompt: "正在发送",
    startingTurn: "正在启动智能体",
    sendFailedKept: "发送失败，输入和附件已保留，可修改后重新发送",
    offlineSendBlocked: "会话连接正在恢复，输入和附件已保留，请同步完成后重试",
    firstMessageNotSent: (detail) => `会话已创建，但第一条消息没有发出：${detail}。内容已放回该会话的输入框。`,
    actionFailed: "操作没有送达电脑，请重试",
    wrapUpAppHint: "在 Claude App 里操作",
    wrapUpSendFailed: "消息发送失败，请重试",
    imageLabel: "图片",
    attachedImage: "附加的图片",
    subagentFallback: "子智能体",
    dismissNotice: "关闭提示",
    sessionCardStates: { starting: "正在启动", started: "已启动", proposed: "已提议，等你开始", failed: "启动失败" },
    openSessionTitle: (title) => `打开「${title}」`,
    findPrevious: "上一个匹配",
    findNext: "下一个匹配",
    noMatches: "无匹配",
    matchPosition: (index, total) => `${index} / ${total}`,
    retryModels: "重新加载模型",
    loadingDirectory: "正在读取目录",
    directoryLoadFailed: "无法读取此目录",
  },
  en: {
    newSessionHeading: "New session",
    newSessionSubheading: "Pick an agent and a folder, then describe the task — or leave it empty to open the session.",
    taskLabel: "任务描述",
    startSessionLabel: "开始会话",
    selectModelLabel: "选择模型",
    selectDirectory: "Select Working Directory",
    browseDirectory: "Browse",
    recentProjects: "Recent Projects",
    noAgentsInstalled: "No coding agents detected on this computer yet (Claude Code / Codex / ACP).",
    agentUnavailable: "Unavailable",
    worktreeHintClean: "Runs in an isolated Git worktree branch without touching your working tree.",
    worktreeHintDirty: "Note: New worktrees check out HEAD and omit uncommitted local changes.",
    loadingModels: "Loading models",
    defaultModel: "Default Model",
    refreshModels: "Refresh models",
    startingSession: "Starting",
    directoryPlaceholder: "Enter or browse directory path",
    newFolder: "New Folder",
    folderNamePrompt: "Folder name",
    useThisDirectory: "Select Directory",
    parentDirectory: "Up",
    searchDirectories: "Filter folders",
    emptyDirectory: "No subdirectories here",

    composerPlaceholder: "Ask anything, @mention files, paste images, or type / for commands",
    composerBusyPlaceholder: "Add follow-up instructions: Enter queues, or click Steer to interrupt",
    desktopDrivenBanner: "This session is currently controlled in the local terminal. Take over to reply here.",
    dropFilesHint: "Drop files to attach (up to 20 MB each)",
    commandsHeading: "Slash Commands",
    filesHeading: "Project Files",
    noMatchingFiles: "No matching files",
    retryFailed: "Retry",
    discardFailed: "Discard",
    cycleModeHint: "Shift+Tab cycles mode",
    clearReviews: "Clear",

    loadEarlier: "Load earlier history",
    loadingEarlier: "Loading earlier history",
    beginningOfSession: "Beginning of session",
    emptyTimeline: "Session ready. Send a message below to get started.",
    youLabel: "You",
    thoughtLabel: "Reasoning",
    planLabel: "Execution Plan",
    wrapUpLabel: "Summary",
    forkFromHere: "Fork from this turn",
    copyMessage: "Copy message",
    pendingDelivery: "Sending",
    acceptedDelivery: "Delivered",
    failedDelivery: "Delivery failed",
    expandSteps: (count) => `Show ${count} steps`,
    collapseSteps: "Collapse steps",
    viewFullParams: "Inspect full parameters",
    toolParamsAria: "Pending tool parameters",
    openConsentUrl: "Open authorization link",
    urlConsentWarning: (url) => `Open external URL in your default browser?\n${url}`,
    submitAnswers: "Submit Answers",
    otherOption: "Other (custom)",
    otherPlaceholder: "Specify your answer",
    answerPlaceholder: "Type your answer",
    asyncQuestionBadge: "Answer anytime",
    replyAction: "Send Reply",
    subagentRunning: "Subagent running",
    subagentDone: "Subagent completed",
    subagentStopped: "Stopped",

    turnOutlineLabel: "Turn Outline",
    findInSession: "Find in session",
    closeFind: "Close find",
    matchesCount: (count) => `${count} matches`,
    openInEditor: "Open In",
    openInCursor: "Open in Cursor",
    openInVsCode: "Open in VS Code",
    openInZed: "Open in Zed",
    openInTerminal: "Open in System Terminal",
    moreSessionActions: "Session actions",
    sessionNotFound: "Syncing session",
    connectingComputer: "Connecting to computer",

    reviewPlaceholder: "Write review feedback for this line",
    saveComment: "Add Comment",
    cancelAction: "Cancel",
    deleteComment: "Remove",

    tasksPillLabel: (done, total) => `${done}/${total} tasks`,
    subagentsPillLabel: (count, running) =>
      running > 0 ? `${count} subagents · ${running} working` : `${count} subagents`,
    viewChangesLabel: "View code changes",
    viewErrorDetails: "Show details",
    hideErrorDetails: "Hide details",
    copyBranch: "Copy branch name",
    branchCopied: "Branch copied",
    loadingHistory: "Loading conversation",
    turnElapsed: "This turn",
    sendingPrompt: "Sending",
    startingTurn: "Starting the agent",
    sendFailedKept: "Couldn't send. Your text and attachments are kept; edit and send again.",
    offlineSendBlocked: "Reconnecting to the session. Your text and attachments are kept; send again once it syncs.",
    firstMessageNotSent: (detail) => `The session was created but its first message wasn't sent: ${detail}. The text is back in that session's composer.`,
    actionFailed: "The computer didn't receive this. Try again.",
    wrapUpAppHint: "Done in the Claude app",
    wrapUpSendFailed: "Couldn't send the message. Try again.",
    imageLabel: "Image",
    attachedImage: "Attached image",
    subagentFallback: "Subagent",
    dismissNotice: "Dismiss",
    sessionCardStates: { starting: "Starting", started: "Started", proposed: "Proposed, waiting for you", failed: "Failed to start" },
    openSessionTitle: (title) => `Open "${title}"`,
    findPrevious: "Previous match",
    findNext: "Next match",
    noMatches: "No matches",
    matchPosition: (index, total) => `${index} / ${total}`,
    retryModels: "Reload models",
    loadingDirectory: "Reading folder",
    directoryLoadFailed: "Couldn't read this folder",
  },
  ja: {
    newSessionHeading: "新しいセッション",
    newSessionSubheading: "エージェントと作業フォルダを選び、タスクを書いて開始します。空のままでもセッションを開けます。",
    taskLabel: "任务描述",
    startSessionLabel: "开始会话",
    selectModelLabel: "选择模型",
    selectDirectory: "作業ディレクトリを選択",
    browseDirectory: "フォルダを参照",
    recentProjects: "最近のプロジェクト",
    noAgentsInstalled: "利用可能なエージェント（Claude Code / Codex / ACP）が見つかりません。",
    agentUnavailable: "未インストール",
    worktreeHintClean: "独立した Git Worktree ブランチで実行し、現在の作業ツリーを汚しません。",
    worktreeHintDirty: "注意：新しい Worktree は最新コミットから作成され、未コミットの変更は含まれません。",
    loadingModels: "モデル読込中",
    defaultModel: "デフォルトモデル",
    refreshModels: "モデルを再取得",
    startingSession: "起動中",
    directoryPlaceholder: "パスを入力または選択",
    newFolder: "新規フォルダ",
    folderNamePrompt: "新しいフォルダ名",
    useThisDirectory: "このフォルダを使用",
    parentDirectory: "上へ",
    searchDirectories: "サブフォルダを絞り込み",
    emptyDirectory: "サブフォルダがありません",

    composerPlaceholder: "指示を入力、@でファイル参照、画像貼付、または / でコマンド",
    composerBusyPlaceholder: "追記を入力：Enter でキュー追加、「割り込み送信」で即時送信",
    desktopDrivenBanner: "現在ターミナル側で操作中です。引き継ぐとここから返信できます。",
    dropFilesHint: "ドロップして添付（1ファイル上限 20 MB）",
    commandsHeading: "スラッシュコマンド",
    filesHeading: "プロジェクトファイル",
    noMatchingFiles: "一致するファイルがありません",
    retryFailed: "再試行",
    discardFailed: "破棄",
    cycleModeHint: "Shift+Tab でモード切替",
    clearReviews: "クリア",

    loadEarlier: "以前の履歴を読み込む",
    loadingEarlier: "履歴を読み込み中",
    beginningOfSession: "セッションの先頭です",
    emptyTimeline: "準備完了です。下の入力欄からメッセージを送信してください。",
    youLabel: "あなた",
    thoughtLabel: "思考プロセス",
    planLabel: "実行プラン",
    wrapUpLabel: "完了サマリー",
    forkFromHere: "ここからフォーク",
    copyMessage: "コピー",
    pendingDelivery: "送信中",
    acceptedDelivery: "送信済み",
    failedDelivery: "送信失敗",
    expandSteps: (count) => `${count} 件のステップを表示`,
    collapseSteps: "折りたたむ",
    viewFullParams: "すべての引数を表示",
    toolParamsAria: "承認待ちのツール引数",
    openConsentUrl: "ブラウザで認証リンクを開く",
    urlConsentWarning: (url) => `既定のブラウザで外部リンクを開きますか？\n${url}`,
    submitAnswers: "回答を送信",
    otherOption: "その他（自由入力）",
    otherPlaceholder: "内容を入力",
    answerPlaceholder: "回答を入力",
    asyncQuestionBadge: "あとで回答可",
    replyAction: "回答する",
    subagentRunning: "サブエージェント実行中",
    subagentDone: "サブエージェント完了",
    subagentStopped: "停止済み",

    turnOutlineLabel: "アウトライン移動",
    findInSession: "セッション内検索",
    closeFind: "検索を閉じる",
    matchesCount: (count) => `${count} 件一致`,
    openInEditor: "外部で開く",
    openInCursor: "Cursor で開く",
    openInVsCode: "VS Code で開く",
    openInZed: "Zed で開く",
    openInTerminal: "システムターミナルで開く",
    moreSessionActions: "その他の操作",
    sessionNotFound: "セッションを同期中",
    connectingComputer: "コンピュータに接続中",

    reviewPlaceholder: "この行へのレビューコメントを入力",
    saveComment: "コメント追加",
    cancelAction: "キャンセル",
    deleteComment: "削除",

    tasksPillLabel: (done, total) => `${done}/${total} タスク`,
    subagentsPillLabel: (count, running) =>
      running > 0 ? `${count} サブ · ${running} 実行中` : `${count} サブエージェント`,
    viewChangesLabel: "変更を表示",
    viewErrorDetails: "詳細を表示",
    hideErrorDetails: "詳細を隠す",
    copyBranch: "ブランチ名をコピー",
    branchCopied: "ブランチ名をコピーしました",
    loadingHistory: "会話を読み込み中",
    turnElapsed: "このターン",
    sendingPrompt: "送信中",
    startingTurn: "エージェントを起動中",
    sendFailedKept: "送信できませんでした。入力と添付は残しています。修正して再送信してください。",
    offlineSendBlocked: "セッションに再接続中です。入力と添付は残しています。同期後に再送信してください。",
    firstMessageNotSent: (detail) => `セッションは作成されましたが、最初のメッセージは送信されませんでした：${detail}。内容はそのセッションの入力欄に戻しました。`,
    actionFailed: "コンピュータに届きませんでした。再試行してください。",
    wrapUpAppHint: "Claude アプリで操作",
    wrapUpSendFailed: "メッセージを送信できませんでした。再試行してください。",
    imageLabel: "画像",
    attachedImage: "添付画像",
    subagentFallback: "サブエージェント",
    dismissNotice: "閉じる",
    sessionCardStates: { starting: "起動中", started: "起動済み", proposed: "提案済み（開始待ち）", failed: "起動失敗" },
    openSessionTitle: (title) => `「${title}」を開く`,
    findPrevious: "前の一致",
    findNext: "次の一致",
    noMatches: "一致なし",
    matchPosition: (index, total) => `${index} / ${total}`,
    retryModels: "モデルを再読込",
    loadingDirectory: "フォルダを読み込み中",
    directoryLoadFailed: "このフォルダを読み込めません",
  },
};

/**
 * Note: Mandatory E2E accessibility labels (`选择模型`, `任务描述`, `开始会话`) stay invariant
 * across locales in `aria-label` so `apps/windows/scripts/model-ui-e2e.mjs` always finds them.
 */
export function useSessionCopy(): SessionCopy {
  const { locale } = useI18n();
  return COPY_BY_LOCALE[locale] ?? COPY_BY_LOCALE.zh;
}

/* ============================================================================
 * Slash Commands & `@file` Mention Parsing
 * ============================================================================ */

export interface SlashCommandItem {
  name: string;
  description: string;
  hint?: string;
  aliases?: readonly string[];
  source: "local" | "agent" | "session";
}

export const NEW_SESSION_COMMANDS: readonly SlashCommandItem[] = [
  {
    name: "clear",
    aliases: ["reset", "new"],
    description: "清空当前已输入的草稿",
    source: "local",
  },
];

const SESSION_LOCAL_COMMANDS: readonly SlashCommandItem[] = [
  {
    name: "new",
    aliases: ["reset", "clear"],
    description: "在同一项目目录开启新会话",
    source: "local",
  },
  {
    name: "stop",
    aliases: ["cancel"],
    description: "停止当前正在运行的回合",
    source: "local",
  },
  {
    name: "model",
    description: "查看或切换模型",
    hint: "[模型名]",
    source: "local",
  },
  {
    name: "mode",
    aliases: ["permissions"],
    description: "查看或切换权限模式",
    hint: "[模式]",
    source: "local",
  },
  {
    name: "status",
    description: "查看会话目录、模型与上下文状态",
    source: "local",
  },
];

const AGENT_BUILTIN_COMMANDS: Record<string, readonly SlashCommandItem[]> = {
  claude: [
    { name: "compact", description: "压缩上下文历史以释放窗口空间", hint: "[保留重点]", source: "agent" },
    { name: "init", description: "分析代码库并生成 CLAUDE.md", source: "agent" },
    { name: "review", description: "审查当前代码改动", source: "agent" },
    { name: "pr-comments", description: "读取并处理当前 PR 评论", source: "agent" },
  ],
  codex: [
    { name: "compact", description: "压缩当前对话上下文", source: "agent" },
    { name: "review", description: "对当前分支或未提交改动执行代码审查", source: "agent" },
  ],
};

export function buildSessionCommands(
  agent: string,
  advertised: readonly { name: string; description: string; hint?: string }[] = [],
): SlashCommandItem[] {
  const byName = new Map<string, SlashCommandItem>();
  for (const item of SESSION_LOCAL_COMMANDS) {
    byName.set(item.name, item);
  }
  const agentKey = agent.toLowerCase();
  for (const [prefix, list] of Object.entries(AGENT_BUILTIN_COMMANDS)) {
    if (agentKey.includes(prefix)) {
      for (const item of list) {
        if (!byName.has(item.name)) byName.set(item.name, item);
      }
    }
  }
  for (const item of advertised) {
    const clean = item.name.replace(/^\/+/, "").trim();
    if (!clean) continue;
    byName.set(clean, {
      name: clean,
      description: item.description,
      hint: item.hint,
      source: "session",
    });
  }
  return [...byName.values()];
}

export function extractCommandQuery(text: string): string | null {
  const normalized = text.replace(/^／/, "/");
  if (!normalized.startsWith("/") || normalized.includes("\n")) return null;
  const body = normalized.slice(1);
  if (/\s/.test(body)) return null;
  return body.toLowerCase();
}

export function filterSlashCommands(
  commands: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(needle) ||
      cmd.aliases?.some((alias) => alias.toLowerCase().includes(needle)) ||
      cmd.description.toLowerCase().includes(needle),
  );
}

export function parseSlashCommandInput(
  text: string,
): { name: string; rest: string; normalized: string } | null {
  const normalized = text.trim().replace(/^／/, "/");
  const match = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(normalized);
  if (!match) return null;
  return {
    name: match[1]!.toLowerCase(),
    rest: (match[2] ?? "").trim(),
    normalized,
  };
}

export interface AtMentionMatch {
  start: number;
  end: number;
  query: string;
}

export function detectAtFileMention(text: string, caretOffset: number): AtMentionMatch | null {
  const safeCaret = Math.max(0, Math.min(caretOffset, text.length));
  const before = text.slice(0, safeCaret);
  const match = /(^|[\s([{'"`])@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  if (query.includes("\n")) return null;
  const start = safeCaret - query.length - 1;
  return { start, end: safeCaret, query };
}

/* ============================================================================
 * Attachments & Outgoing Content Blocks
 * ============================================================================ */

export interface ComposerAttachment {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  previewUrl?: string;
}

export async function prepareComposerAttachment(rawFile: File): Promise<ComposerAttachment> {
  const processed = await shrinkImage(rawFile);
  validateAttachmentSize(processed);
  const mimeType = processed.type || "application/octet-stream";
  const isImage = /^image\//i.test(mimeType);
  const previewUrl =
    isImage && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(processed)
      : undefined;
  return {
    id: crypto.randomUUID(),
    file: processed,
    name: processed.name || "attachment",
    mimeType,
    size: processed.size,
    isImage,
    previewUrl,
  };
}

export function revokeAttachmentPreviews(attachments: readonly ComposerAttachment[]): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const item of attachments) {
    if (item.previewUrl) {
      try {
        URL.revokeObjectURL(item.previewUrl);
      } catch {
        // Ignore already-revoked object URLs.
      }
    }
  }
}

/** Relay round trips for a 20 MB file take far longer than the default 30 s RPC timeout. */
export const UPLOAD_TIMEOUT_MS = 180_000;

const EMBEDDED_LIMIT_BYTES = 5 * 1024 * 1024;
const NATIVE_IMAGE = /^image\/(png|jpe?g|webp|gif)$/;

type AgentCapabilities = AgentInfo["capabilities"] | undefined;

/** How the agent takes a file, by what it says it can read (ported from the web client). */
function attachmentRoute(item: ComposerAttachment, capabilities: AgentCapabilities): "image" | "audio" | "resource" | "upload" {
  if (NATIVE_IMAGE.test(item.mimeType) && capabilities?.images) return "image";
  if (/^audio\//.test(item.mimeType) && capabilities?.audio && item.size <= EMBEDDED_LIMIT_BYTES) return "audio";
  if (capabilities?.embeddedContext && item.size <= EMBEDDED_LIMIT_BYTES) return "resource";
  return "upload";
}

export function attachmentsNeedUpload(
  attachments: readonly ComposerAttachment[],
  capabilities?: AgentCapabilities,
): boolean {
  return attachments.some((item) => attachmentRoute(item, capabilities) === "upload");
}

/**
 * Builds the `ContentBlock[]` for `sessions.prompt` / `createSession`. Files the agent can't take
 * inline are uploaded into `uploadDir` (the session's own directory, which always exists) and
 * referenced as `resource_link`s; `uploadCache` keeps a retry from writing the same file twice.
 */
export async function buildPromptContentBlocks(options: {
  text: string;
  pastedBlocks: readonly PastedTextBlock[];
  attachments: readonly ComposerAttachment[];
  capabilities?: AgentCapabilities;
  uploadDir?: string;
  uploadCache?: WeakMap<File, string>;
  callUpload?: (dir: string, name: string, data: string) => Promise<{ path: string }>;
}): Promise<ContentBlock[]> {
  const { text, pastedBlocks, attachments, capabilities, uploadDir, uploadCache, callUpload } = options;
  const content: ContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed) content.push({ type: "text", text: trimmed });
  for (const block of pastedBlocks) {
    if (block.text.trim()) content.push({ type: "text", text: block.text });
  }
  for (const item of attachments) {
    const route = attachmentRoute(item, capabilities);
    if (route === "upload") {
      const cached = uploadCache?.get(item.file);
      let path = cached;
      if (!path) {
        if (!callUpload || !uploadDir) throw new Error(`无法上传「${item.name}」：缺少会话目录`);
        path = (await callUpload(uploadDir, item.name, await fileToBase64(item.file))).path;
        uploadCache?.set(item.file, path);
      }
      content.push({ type: "resource_link", uri: path, name: item.name });
      continue;
    }
    const data = await fileToBase64(item.file);
    if (route === "image") {
      content.push({ type: "image", mimeType: item.mimeType, data });
    } else if (route === "audio") {
      content.push({ type: "audio", mimeType: item.mimeType, data });
    } else {
      const textual = /^text\//.test(item.mimeType) || item.mimeType === "application/json";
      content.push({
        type: "resource",
        resource: {
          uri: `attachment:${encodeURIComponent(item.name)}`,
          mimeType: item.mimeType || "application/octet-stream",
          ...(textual ? { text: await item.file.text() } : { blob: data }),
        },
      });
    }
  }
  return content;
}

/**
 * Turns content taken back from the queue into composer attachments again, so editing a queued
 * message doesn't drop its pictures.
 */
export function attachmentsFromBlocks(blocks: readonly ContentBlock[]): ComposerAttachment[] {
  const restored: ComposerAttachment[] = [];
  blocks.forEach((block, index) => {
    if (block.type !== "image" || !block.data) return;
    const binary = atob(block.data);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    const mimeType = block.mimeType || "image/png";
    const extension = mimeType.split("/")[1] ?? "png";
    const file = new File([bytes], `image-${index + 1}.${extension}`, { type: mimeType });
    restored.push({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      mimeType,
      size: file.size,
      isImage: true,
      previewUrl:
        typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined,
    });
  });
  return restored;
}

/** Everything a person could be looking for in an item, folded tool output included (ported from the web client). */
export function timelineItemSearchText(item: TimelineItem): string {
  switch (item.kind) {
    case "user":
      return [
        userMessageView(item.blocks).text,
        ...(item.agentMessages?.flatMap((mail) => [mail.sender, mail.summary, mail.body]) ?? []),
      ]
        .filter(Boolean)
        .join("\n");
    case "agent":
    case "thought":
      return item.text;
    case "error": {
      const shown = presentError(item);
      return [item.message, shown.title, shown.hint, shown.detail].filter(Boolean).join("\n");
    }
    case "notice":
      return [item.title, item.detail].filter(Boolean).join("\n");
    case "plan":
      return [item.title, item.markdown, ...item.entries.map((entry) => entry.content)]
        .filter(Boolean)
        .join("\n");
    case "permission-result":
      return [item.title, item.optionName].filter(Boolean).join("\n");
    case "tool": {
      const label = toolLabel(item);
      const changes = item.content.flatMap((entry) => {
        if (entry.type === "diff") return [entry.path, entry.oldText ?? "", entry.newText];
        if (entry.type === "patch") return [entry.path, entry.movePath ?? "", entry.diff];
        if (entry.type === "content" && entry.content.type === "text") return [entry.content.text];
        return [];
      });
      return [
        item.title,
        toolLabelText(label, { note: true }),
        label.action === "command" ? toolCommand(item) : undefined,
        label.action === "plan" ? proposedPlan(item) : undefined,
        toolOutput(item),
        ...changes,
      ]
        .filter(Boolean)
        .join("\n");
    }
    default:
      return "";
  }
}

/* ============================================================================
 * Path & Config Formatting Helpers
 * ============================================================================ */

export function shortenHomePath(path: string, home?: string): string {
  if (!path) return "";
  if (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))) {
    const rest = path.slice(home.length);
    return rest ? `~${rest}` : "~";
  }
  return path;
}

export function basenameOfPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? (path || "/");
}

export function parentOfPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === "/" || /^[A-Za-z]:$/.test(trimmed)) return trimmed || "/";
  const sep = trimmed.includes("\\") ? "\\" : "/";
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return sep === "\\" ? `${trimmed.slice(0, 2)}\\` : "/";
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

export function resolveFileHrefTarget(
  href: string,
  cwd?: string,
): { path: string; line?: number; endLine?: number } | null {
  const clean = href.trim();
  if (
    !clean ||
    /^(?:https?:|mailto:|tel:|data:|javascript:|vbscript:|blob:|about:|#)/i.test(
      clean,
    )
  ) {
    return null;
  }

  let rawPath = clean;
  const editorUriMatch =
    /^(?:vscode|vscode-insiders|cursor|zed|windsurf):\/\/file(\/.*)$/i.exec(
      rawPath,
    );
  if (editorUriMatch) {
    rawPath = editorUriMatch[1]!;
    try {
      rawPath = decodeURIComponent(rawPath);
    } catch {
      // Preserve rawPath when literal `%` appears.
    }
    if (/^\/+[A-Za-z]:[\\/]/.test(rawPath)) {
      rawPath = rawPath.replace(/^\/+/, "");
    }
  } else if (/^file:\/\//i.test(rawPath)) {
    let hashSuffix = "";
    const hashIdx = rawPath.indexOf("#");
    const urlPart = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;
    if (hashIdx >= 0) {
      hashSuffix = rawPath.slice(hashIdx);
    }
    const afterScheme = urlPart.replace(/^file:\/\//i, "");
    let extractedPath: string;
    if (/^(?:localhost)?\/+[A-Za-z]:[\\/]/i.test(afterScheme)) {
      extractedPath = afterScheme.replace(/^(?:localhost)?\/+/i, "");
    } else if (/^[A-Za-z]:[\\/]/.test(afterScheme)) {
      extractedPath = afterScheme;
    } else if (/^localhost\//i.test(afterScheme)) {
      extractedPath = afterScheme.slice("localhost".length);
    } else if (afterScheme.startsWith("/")) {
      extractedPath = afterScheme;
    } else if (/^[A-Za-z0-9._-]+[\\/].+/.test(afterScheme)) {
      extractedPath = `\\\\${afterScheme.replace(/\//g, "\\")}`;
    } else {
      extractedPath = afterScheme;
    }
    try {
      extractedPath = decodeURIComponent(extractedPath);
    } catch {
      // Preserve literal `%` if not valid percent-encoding.
    }
    if (/^\/+[A-Za-z]:[\\/]/.test(extractedPath)) {
      extractedPath = extractedPath.replace(/^\/+/, "");
    }
    rawPath = extractedPath + hashSuffix;
  }

  let line: number | undefined;
  let endLine: number | undefined;
  const hashMatch = /^(.*)#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(
    rawPath,
  );
  if (hashMatch) {
    rawPath = hashMatch[1]!;
    line = Number(hashMatch[2]);
    if (hashMatch[3]) {
      endLine = Number(hashMatch[3]);
    }
  } else {
    const colonMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(rawPath);
    if (colonMatch && !/^[A-Za-z]$/.test(colonMatch[1]!)) {
      rawPath = colonMatch[1]!;
      line = Number(colonMatch[2]);
    }
  }

  try {
    rawPath = decodeURIComponent(rawPath);
  } catch {
    // Keep rawPath if it contains literal `%` characters.
  }

  if (/^\/+[A-Za-z]:[\\/]/.test(rawPath)) {
    rawPath = rawPath.replace(/^\/+/, "");
  }

  if (!rawPath) return null;
  const isAbsolute =
    rawPath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(rawPath) ||
    rawPath.startsWith("\\\\");
  if (!isAbsolute && cwd) {
    const sep = cwd.includes("\\") ? "\\" : "/";
    const base = cwd.replace(/[\\/]+$/, "");
    const strippedRel = rawPath.replace(/^\.[\\/]/, "");
    const rel =
      sep === "\\" ? strippedRel.replace(/\//g, "\\") : strippedRel;
    return { path: `${base}${sep}${rel}`, line, endLine };
  }
  if (
    isAbsolute ||
    /\.[a-z0-9]{1,8}$/i.test(rawPath) ||
    rawPath.includes("/") ||
    rawPath.includes("\\")
  ) {
    return { path: rawPath, line, endLine };
  }
  return null;
}

const VALUE_NAME_MAP: Record<string, string> = {
  default: "默认",
  "default (recommended)": "默认（推荐）",
  "bypass permissions": "免确认",
  bypasspermissions: "免确认",
  "accept edits": "自动接受编辑",
  acceptedits: "自动接受编辑",
  plan: "计划模式",
  "plan mode": "计划模式",
  "read only": "只读",
  "read-only": "只读",
  auto: "自动",
  "full access": "完全访问",
  "full-access": "完全访问",
  ask: "每次询问",
  manual: "每次询问",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极高",
  none: "关闭",
  on: "开",
  off: "关",
  custom: "自定义",
  "auto edit": "自动编辑",
  yolo: "全部自动批准",
};

export function localizedValueName(raw: string): string {
  return VALUE_NAME_MAP[raw.trim().toLowerCase()] ?? formatOptionValueName(displayModelName(raw));
}

export function formatModelOptionLabel(entry: { name: string; group?: string }): string {
  const base = localizedValueName(entry.name);
  return entry.group ? `${entry.group} · ${base}` : base;
}

export function configOptionDisplayLabel(option: SessionConfigOption): string {
  const currentOption = option.values.find((entry) => entry.value === option.current);
  const rawName = currentOption?.name ?? option.current;
  return localizedValueName(rawName);
}

export function configValueDisplayName(
  _option: Pick<SessionConfigOption, "category">,
  entry: { value: string; name: string; group?: string },
): string {
  return formatModelOptionLabel(entry);
}

export function configCategoryIcon(
  category: SessionConfigOption["category"],
  currentValue?: string,
): DesktopIconName {
  switch (category) {
    case "model":
      return "sparkles";
    case "mode":
      return currentValue && /(auto|bypass|full|yolo|accept)/i.test(currentValue)
        ? "unlock"
        : "shield";
    case "effort":
      return "sliders";
    default:
      return "settings";
  }
}

export function isLocalDesktopConnection(connection: Connection | undefined): boolean {
  return Boolean(connection && connection.computer.key === DESKTOP_LOCAL);
}
