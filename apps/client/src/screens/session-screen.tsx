import type { AsyncQuestion } from "@linkshell/wire";
import { ComputerPreviewVisible, setComputerPreviewMode, useComputerPreview } from "@/lib/use-computer-preview";
import { answeredQuestions, cardsAtTurnEnd, openWrapUp, shownQueue, workflowIsLive, type TimelineItem } from "@linkshell/client-core";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { confirmDelete, renameSession, toggleArchived } from "@/lib/session-actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, type NativeScrollEvent, type NativeSyntheticEvent, Platform, Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useHeaderHeight, useIsFocused } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { speakNativeText, stopNativeSpeaking } from "../../modules/link-layout";
import { AgentTile } from "@/components/agent-tile";
import { AsyncQuestionCard } from "@/components/async-question-card";
import { Composer } from "@/components/composer";
import { ConnectionBanner } from "@/components/connection-banner";
import { SessionNotices } from "@/components/session-notices";
import { SessionOutlineSheet } from "@/components/session-outline-sheet";
import { AgentInteractions } from "./acp-screen";
import { Glass } from "@/components/glass";
import { Icon } from "@/components/icon";
import { StatusDot } from "@/components/status";
import { ScrollableState } from "@/components/scrollable-state";
import { EmptyState, LoadingState } from "@/components/state-views";
import { TimelineSkeleton } from "@/components/timeline/skeleton";
import { Timeline, type TimelineRef } from "@/components/timeline/timeline";
import { TimelineFork, TimelineQuestions, TimelineSession, TimelineSide, TimelineWaiting, TimelineWrapUp } from "@/components/timeline/context";
import {
  isCommuterTtsEnabled,
  setCommuterTtsEnabled,
  summarizeTurnForSpeech,
} from "@/lib/coding-ux";
import { quoteForSide } from "@/lib/side-quote";
import { LinkBase } from "@/lib/links";
import { useLocale } from "@/lib/locale";
import { useActions, useClient, useConnection, useConnectionStatus, useSessionSubscription } from "@/lib/client";
import { fileChanges, sessionTitle } from "@/lib/describe";
import { baseName } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { BranchTag } from "@/components/branch-tag";
import { branchOf, useGitInfo } from "@/lib/worktree";
import { agentLook, tierCopy } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { HeaderActions, useHeaderTitleWidth, type HeaderAction } from "@/components/header-actions";
import { LiveWorkflowsBar } from "@/components/workflow";
import { sessionTimelineItems } from "@/lib/workflows";
import { SessionWorkspace, useSessionWorkspace, type Panel } from "@/components/session-workspace";
import { AdaptivePage, usePageInsets } from "@/components/adaptive-page";
import { useSessionFoldLayout } from "@/lib/session-fold-layout";
import { useIPadKeyboard } from "@/lib/use-ipad-keyboard";
import { ContentHeight } from "@/lib/content-height";
import { useHasComposerDraft } from "@/lib/use-composer-draft";
import { useSessionCommands } from "@/lib/use-session-commands";
import { GoalCard } from "@/components/goal-card";
import { turnActivity } from "@/lib/turn-activity";

const NO_ITEMS: TimelineItem[] = [];

function ComputerPreviewProbe({
  sessionId,
  onState,
}: {
  sessionId: string;
  onState: (active: boolean, mode: "shown" | "collapsed" | "hidden") => void;
}) {
  const { frame, mode } = useComputerPreview(sessionId);
  onState(!!frame, mode);
  return null;
}

function HeaderTitle({
  agent,
  title,
  subtitle,
  branch,
  ownBranch,
  live,
  actions,
}: {
  agent: string;
  title: string;
  subtitle: string;
  branch?: string;
  ownBranch?: boolean;
  live: boolean;
  actions: number;
}) {
  const maxWidth = useHeaderTitleWidth(actions);
  const content = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <AgentTile agent={agent} size={28} />
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 19, fontWeight: "600", color: colors.label }}>
          {title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {live ? <StatusDot /> : null}
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, lineHeight: 15, fontWeight: "500", color: colors.secondaryLabel }}>
            {subtitle}
          </Text>
          {branch ? (
            <View style={{ flexShrink: 0 }}>
              <BranchTag branch={branch} max={18} own={ownBranch} />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
  if (Platform.OS !== "ios") return <View style={{ maxWidth }}>{content}</View>;
  return <Glass style={{ borderRadius: 22, paddingLeft: 6, paddingRight: 14, paddingVertical: 5, maxWidth }}>{content}</Glass>;
}

function countChanges(items: TimelineItem[]): number {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || item.status === "failed") continue;
    for (const change of fileChanges(item.content)) paths.add(change.path);
  }
  return paths.size;
}

export function SessionScreen() {
  const { id, panel, quickVoice } = useLocalSearchParams<{ id: string; panel?: string; quickVoice?: string }>();
  return (
    <AdaptivePage surface="plain">
      <SessionWorkspace
        key={id}
        sessionId={id}
        initialPanel={panel === "preview" || panel === "changes" || panel === "side" ? panel : undefined}
      >
        <SessionContent sessionId={id} initialQuickVoice={quickVoice === "1"} />
      </SessionWorkspace>
    </AdaptivePage>
  );
}

export function SessionContent({
  sessionId: id,
  embedded = false,
  navigation = !embedded,
  toolbarActions = [],
  onOpenPanel,
  panelsBeside = false,
  navigationTitle,
  consumedBottomInset = 0,
  initialQuickVoice = false,
}: {
  sessionId: string;
  embedded?: boolean;
  navigation?: boolean;
  navigationTitle?: string;
  consumedBottomInset?: number;
  toolbarActions?: HeaderAction[];
  onOpenPanel?: (panel: Panel) => void;
  panelsBeside?: boolean;
  initialQuickVoice?: boolean;
}) {
  const workspace = useSessionWorkspace();
  const folded = useSessionFoldLayout();
  const { locale, speechLocale, t, pick } = useLocale();
  const summary = useClient((state) => state.sessions[id]);
  const view = useClient((state) => state.views[id]);
  const loaded = useClient((state) => state.sessionsLoaded);
  const ready = useClient((state) => !!state.ready[id]);
  const online = useClient((state) => state.status === "online");
  const connecting = useConnectionStatus() === "connecting";
  const loadingEarlier = useClient((state) => !!state.loadingEarlier[id]);
  const queueing = useClient((state) => state.queueing[id]);
  const promptProgress = useClient((state) => state.promptProgress[id]);
  const subagents = useClient((state) => state.subagents[id]);
  const workflows = useClient((state) => state.workflows[id]);
  const tasks = useClient((state) => state.tasks[id]);
  const taskCount = Object.keys(tasks ?? {}).length;
  const tasksRunning = Object.values(tasks ?? {}).filter((task) => task.state === "running").length;
  const subagentsListed = subagents?.length ?? 0;
  const hasWorkflows = Object.keys(workflows ?? {}).length > 0;
  const subagentsTotal = summary?.subagents?.total ?? 0;
  const subagentsRunning = summary?.subagents?.running ?? 0;
  const hasSubagents = taskCount > 0 || (summary?.tasks?.total ?? 0) > 0 || hasWorkflows || subagentsTotal > 0 || subagentsListed > 0;
  const agentInfo = useClient((state) => state.machine?.agents.find((agent) => agent.id === summary?.agent));
  const sideCount = useClient((state) => state.sides[id]?.length ?? 0);
  const actions = useActions();
  const sideBeside = onOpenPanel ? panelsBeside : workspace?.split === true;
  const openSide = (sideId?: string) => {
    if (sideBeside && onOpenPanel) onOpenPanel("side");
    else if (sideBeside) workspace?.show("side");
    else router.push({ pathname: "/session/[id]/side", params: sideId ? { id, side: sideId } : { id } });
  };
  const permissions = view?.permissions;
  const waitingCalls = useMemo(() => new Set((permissions ?? []).flatMap((request) => (request.toolCallId ? [request.toolCallId] : []))), [permissions]);
  const askAboutQuote = agentInfo?.capabilities.side && online ? (quote: string) => { quoteForSide(id, quote); openSide(); } : undefined;
  const commandControls = useSessionCommands(id, openSide);
  const hasDraft = useHasComposerDraft(id);
  const { computer, link } = useConnection();
  const hasComputerPreviewRef = useRef(false);
  const previewModeRef = useRef<"shown" | "collapsed" | "hidden">("shown");
  const insets = usePageInsets();
  const systemInsets = useSafeAreaInsets();
  const focused = useIsFocused();
  const ipadKeyboard = useIPadKeyboard(focused);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const reservedBottom = folded?.bottomReserved ?? consumedBottomInset;
  const bottomInset = ipadKeyboard.enabled && ipadKeyboard.overlap > 0 ? 0 : Math.max(0, Math.max(insets.bottom, systemInsets.bottom) - reservedBottom);
  const keyboardOffset = ipadKeyboard.enabled ? keyboardHeight : reservedBottom + bottomInset;
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const { height: keyboardTranslation, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const stickyEnabled = !ipadKeyboard.enabled;
  const composerKeyboardStyle = useAnimatedStyle(() => {
    const height = keyboardTranslation.get();
    const progress = height < 0 ? keyboardProgress.get() : 0;
    return { transform: [{ translateY: stickyEnabled ? height + progress * keyboardOffset : 0 }] };
  }, [keyboardTranslation, keyboardProgress, keyboardOffset, stickyEnabled]);
  const composerInset = useSharedValue(0);
  const headerHeight = useHeaderHeight();
  const headerConsumed = embedded || workspace?.headerConsumed === true;
  const introFrame = useAnimatedStyle(() => ({ bottom: composerInset.get(), paddingTop: headerConsumed ? 0 : headerHeight }));
  const listRef = useRef<TimelineRef>(null);
  const [atEnd, setAtEnd] = useState(true);

  const [quickVoicePending, setQuickVoicePending] = useState(initialQuickVoice);
  useEffect(() => {
    if (initialQuickVoice) setQuickVoicePending(true);
  }, [initialQuickVoice]);

  const [outlineOpen, setOutlineOpen] = useState(false);
  const [ttsEnabled, setTtsState] = useState(() => isCommuterTtsEnabled());

  useSessionSubscription(id);
  useEffect(() => {
    if (ready && focused) void actions.loadSubagents(id).catch(() => {});
  }, [actions, id, ready, focused, subagentsTotal, subagentsRunning]);

  const items = view?.items ?? NO_ITEMS;
  const turnBreaks = view?.turnBreaks;
  const timelineItems = useMemo(() => sessionTimelineItems(cardsAtTurnEnd(items, turnBreaks), workflows, subagents), [items, turnBreaks, workflows, subagents]);
  const questions = useMemo(() => {
    const answered = new Map(items.flatMap((item) => (item.kind === "user" && !item.failed && !item.pending ? item.blocks.flatMap((block) => (block.type === "text" ? answeredQuestions(block.text) : [])) : [])));
    return {
      answered,
      pending: summary?.asyncQuestions ? new Set(summary.asyncQuestions.map((question) => question.id)) : undefined,
      answer: (question: AsyncQuestion, answer: string) => actions.answerAsync(id, question, answer),
    };
  }, [items, actions, id, summary?.asyncQuestions]);
  const openBox = useMemo(() => openWrapUp(items), [items]);
  const wrapUp = useMemo(() => ({
    open: openBox,
    reply: async (message: string) => {
      if ((await actions.send(id, [{ type: "text", text: message }])) === "failed") {
        throw new Error(pick({ zh: "消息发送失败，请重试", en: "Failed to send message, please retry", ja: "送信に失敗しました。再試行してください" }));
      }
    },
  }), [openBox, actions, id, pick]);

  const hasEarlier = (view?.startSeq ?? 0) > 0;
  const earlier = useMemo(
    () => (hasEarlier ? { loading: loadingEarlier, load: () => actions.loadEarlier(id) } : undefined),
    [hasEarlier, loadingEarlier, actions, id],
  );
  const [cachedAtOpen] = useState(() => items.length > 0);
  const wasReady = useRef(ready);
  if (ready) wasReady.current = true;

  const changeCount = useMemo(() => countChanges(items), [items]);
  const turnActive = summary ? summary.state === "running" || summary.state === "waiting" : false;
  const driver = view?.driver ?? summary?.driver;
  const look = agentLook(summary?.agent ?? "", agentInfo?.label);

  // Commuter Audio Summary: speak a concise summary when an active turn completes.
  const prevTurnActive = useRef<boolean | null>(null);
  useEffect(() => {
    const wasActive = prevTurnActive.current;
    prevTurnActive.current = turnActive;
    if (
      wasActive === true &&
      !turnActive &&
      ttsEnabled &&
      summary &&
      (summary.state === "idle" || summary.state === "error")
    ) {
      const currentTitle = sessionTitle(view?.title ? { title: view.title } : summary);
      const summarySpeech = summarizeTurnForSpeech(timelineItems, locale, currentTitle);
      void speakNativeText(summarySpeech, speechLocale);
    }
  }, [turnActive, ttsEnabled, summary, view?.title, timelineItems, locale, speechLocale]);

  const toggleCommuterTts = useCallback(() => {
    const next = !ttsEnabled;
    setTtsState(next);
    setCommuterTtsEnabled(next);
    if (!next) void stopNativeSpeaking();
    haptics.selection();
  }, [ttsEnabled]);

  const onFailedMessage = useCallback(
    (item: Extract<TimelineItem, { kind: "user" }>) => {
      const clientMessageId = item.id.replace(/^local-/, "");
      Alert.alert(
        pick({ zh: "消息没发出去", en: "Message not sent", ja: "メッセージを送信できませんでした" }),
        pick({ zh: "要重新发送吗？", en: "Would you like to retry?", ja: "再送信しますか？" }),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("session.delete"), style: "destructive", onPress: () => actions.discard(clientMessageId) },
          { text: t("common.retry"), onPress: () => void actions.retry(clientMessageId) },
        ],
      );
    },
    [actions, pick, t],
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = event.nativeEvent;
    const distance = contentSize.height + (contentInset?.bottom ?? 0) - (contentOffset.y + layoutMeasurement.height);
    const next = distance < 120 || contentSize.height <= layoutMeasurement.height + 1;
    setAtEnd((current) => (current === next ? current : next));
  }, []);

  const scrollToEnd = () => {
    haptics.selection();
    void listRef.current?.scrollToEnd({ animated: true });
  };

  const [gitRefresh, setGitRefresh] = useState(0);
  const turnRunning = summary ? summary.state === "running" || summary.state === "waiting" : false;
  useEffect(() => {
    if (!turnRunning) setGitRefresh((value) => value + 1);
  }, [turnRunning]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setGitRefresh((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);
  const git = useGitInfo(summary?.cwd, gitRefresh);
  const [forking, setForking] = useState(false);
  const fork = (itemId: string | undefined, worktree: boolean) => {
    if (forking) return;
    setForking(true);
    actions
      .forkSession(id, { itemId, worktree })
      .then((session) => {
        haptics.success();
        router.push({ pathname: "/session/[id]", params: { id: session.id } });
      })
      .catch((reason: unknown) => {
        haptics.error();
        Alert.alert(
          pick({ zh: "分叉失败", en: "Fork failed", ja: "フォークに失敗しました" }),
          reason instanceof Error ? reason.message : String(reason),
        );
      })
      .finally(() => setForking(false));
  };
  const askFork = (itemId?: string) => {
    Alert.alert(
      itemId
        ? pick({ zh: "从这里分叉", en: "Fork from here", ja: "ここからフォーク" })
        : pick({ zh: "分叉会话", en: "Fork Session", ja: "セッションをフォーク" }),
      itemId
        ? pick({
            zh: "新会话带着到这条回复为止的对话，这个会话不受影响。",
            en: "Starts a new session with history up to this turn; the current session stays untouched.",
            ja: "この返信までの履歴を引き継ぐ新しいセッションを作成します。",
          })
        : pick({
            zh: "新会话带着到现在为止的对话，这个会话不受影响。",
            en: "Starts a new session with the conversation so far; the current session stays untouched.",
            ja: "ここまでの履歴を引き継ぐ新しいセッションを作成します。",
          }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: pick({ zh: "在当前目录继续", en: "Continue in current directory", ja: "現在のディレクトリで続行" }),
          onPress: () => fork(itemId, false),
        },
        ...(git
          ? [
              {
                text: pick({ zh: "在新的 worktree 里继续", en: "Continue in new Git worktree", ja: "新しい Worktree で続行" }),
                onPress: () => fork(itemId, true),
              },
            ]
          : []),
      ],
    );
  };

  const guard = async (work: () => Promise<unknown>, failure: string) => {
    try {
      await work();
    } catch (error) {
      haptics.error();
      Alert.alert(failure, error instanceof Error ? error.message : String(error));
    }
  };

  if (!summary) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.plain }}>
        {navigation ? <Stack.Screen options={{ title: "" }} /> : null}
        <View style={{ paddingHorizontal: 16, paddingTop: headerConsumed ? 4 : headerHeight + 4 }}>
          <ConnectionBanner />
        </View>
        <ScrollableState>
          {loaded ? (
            <EmptyState
              icon={{ sf: "questionmark.bubble", md: "help" }}
              title={pick({ zh: "找不到这个会话", en: "Session not found", ja: "セッションが見つかりません" })}
              message={pick({
                zh: "它可能已经在电脑上被删除了。",
                en: "It may have been removed on your computer.",
                ja: "PC 上で削除された可能性があります。",
              })}
              action={{ title: pick({ zh: "返回", en: "Back", ja: "戻る" }), onPress: () => router.back() }}
            />
          ) : (
            <LoadingState label={t("connection.connecting")} />
          )}
        </ScrollableState>
      </View>
    );
  }

  const tier = agentInfo?.tier;
  const branch = branchOf(git) ?? summary.worktree?.branch;
  const subtitle = branch
    ? baseName(summary.worktree?.source ?? summary.cwd)
    : [baseName(summary.cwd), look.short, tier ? tierCopy[tier].label : null].filter(Boolean).join(" · ");
  const canFork = tier !== "terminal" && online;

  const hasHistory = summary.lastSeq > 0 || !!summary.preview || !!summary.title;
  const loading = !ready && !wasReady.current && !cachedAtOpen && online && hasHistory;
  const started =
    hasEarlier ||
    items.some(
      (item) =>
        item.kind === "user" ||
        item.kind === "agent" ||
        item.kind === "tool" ||
        item.kind === "thought" ||
        item.kind === "plan" ||
        item.kind === "error" ||
        item.kind === "turn-end" ||
        item.kind === "permission-result",
    );
  const openChanges = () => {
    haptics.selection();
    if (onOpenPanel) onOpenPanel("changes");
    else if (workspace) workspace.show("changes");
    else router.push({ pathname: "/session/[id]/changes", params: { id } });
  };
  const starterPrompts = [
    { label: t("composer.quickSummarize"), prompt: t("composer.quickSummarizePrompt") },
    { label: t("composer.quickRunTests"), prompt: t("composer.quickRunTestsPrompt") },
    {
      label: pick({ zh: "梳理当前项目结构", en: "Map project architecture", ja: "プロジェクト構成を整理" }),
      prompt: pick({
        zh: "请简要梳理当前项目的目录结构、核心模块和构建测试方式。",
        en: "Summarize this project's directory structure, core modules, and build/test commands.",
        ja: "このプロジェクトのディレクトリ構成、主要モジュール、ビルド・テスト方法を整理してください。",
      }),
    },
  ];

  const intro =
    loading || started || hasDraft || view?.goal ? null : (
      <View style={{ alignItems: "center", gap: 12, paddingHorizontal: 28 }}>
        <AgentTile agent={summary.agent} size={56} />
        <View style={{ alignItems: "center", gap: 4 }}>
          <Text style={[type.headline, { color: colors.label }]}>{look.name}</Text>
          <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
            {tier
              ? tierCopy[tier].detail
              : pick({
                  zh: `在 ${baseName(summary.cwd)} 里开始对话`,
                  en: `Start a session in ${baseName(summary.cwd)}`,
                  ja: `${baseName(summary.cwd)} で会話を開始`,
                })}
          </Text>
        </View>
        {online && tier !== "terminal" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 4 }}>
            {starterPrompts.map((starter) => (
              <Pressable
                key={starter.label}
                onPress={() => {
                  haptics.selection();
                  void commandControls.send([{ type: "text", text: starter.prompt }]);
                }}
                accessibilityRole="button"
                accessibilityLabel={starter.label}
                style={({ pressed }) => ({
                  paddingHorizontal: 13,
                  paddingVertical: 7,
                  borderRadius: radius.card,
                  borderCurve: "continuous",
                  backgroundColor: pressed ? colors.fillStrong : colors.fill,
                })}
              >
                <Text style={[type.footnote, { color: colors.label, fontWeight: "500" }]}>{starter.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    );

  return (
    <View ref={ipadKeyboard.ref} onLayout={ipadKeyboard.measure} style={{ flex: 1, paddingBottom: ipadKeyboard.overlap }}>
      <ContentHeight value={contentHeight}>
        <View onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)} style={{ flex: 1, backgroundColor: colors.plain }}>
          <ComputerPreviewVisible value={false}>
            <ComputerPreviewProbe
              sessionId={id}
              onState={(active, mode) => {
                hasComputerPreviewRef.current = active;
                previewModeRef.current = mode;
              }}
            />
          </ComputerPreviewVisible>
          {!navigation ? null : (
            <>
              <Stack.Screen
                options={{
                  scrollEdgeEffects: { top: "soft" },
                  ...(Platform.OS === "ios"
                    ? {}
                    : { headerTransparent: false, headerStyle: { backgroundColor: colors.plain as string }, headerShadowVisible: false }),
                  title: navigationTitle ?? sessionTitle(view?.title ? { title: view.title } : summary),
                  headerTitle:
                    Platform.OS === "ios"
                      ? undefined
                      : () => (
                          <HeaderTitle
                            agent={summary.agent}
                            title={sessionTitle(view?.title ? { title: view.title } : summary)}
                            subtitle={subtitle}
                            branch={branch}
                            ownBranch={!!summary.worktree}
                            live={turnActive}
                            actions={(started ? 1 : 0) + (hasSubagents ? 1 : 0) + (changeCount > 0 ? 1 : 0) + 1}
                          />
                        ),
                }}
              />
              <HeaderActions
                actions={[
                  ...toolbarActions,
                  ...(started && !toolbarActions.some((action) => action.key === "outline")
                    ? [
                        {
                          kind: "button" as const,
                          key: "outline",
                          icon: { sf: "magnifyingglass", md: "search" } as const,
                          label: t("session.outline"),
                          onPress: () => {
                            haptics.selection();
                            setOutlineOpen(true);
                          },
                        },
                      ]
                    : []),
                  ...(changeCount > 0 && !toolbarActions.some((action) => action.key === "changes")
                    ? [
                        {
                          kind: "button" as const,
                          key: "changes",
                          icon: { sf: "plus.forwardslash.minus", md: "difference" } as const,
                          label: `${t("nav.changes")} (${changeCount})`,
                          onPress: openChanges,
                        },
                      ]
                    : []),
                  ...(hasSubagents
                    ? [
                        {
                          kind: "button" as const,
                          key: "subagents",
                          icon: { sf: "square.stack.3d.up", md: "layers" } as const,
                          label: taskCount
                            ? pick({ zh: `后台任务（${tasksRunning}）`, en: `Tasks (${tasksRunning})`, ja: `タスク (${tasksRunning})` })
                            : hasWorkflows
                              ? pick({ zh: "Agent 与工作流", en: "Agents & Workflows", ja: "Agent とワークフロー" })
                              : subagentsRunning
                                ? pick({ zh: `子代理（${subagentsRunning}）`, en: `Subagents (${subagentsRunning})`, ja: `サブエージェント (${subagentsRunning})` })
                                : pick({ zh: "子代理", en: "Subagents", ja: "サブエージェント" }),
                          live: subagentsRunning > 0 || tasksRunning > 0,
                          onPress: () => router.push({ pathname: "/session/[id]/agents", params: { id } }),
                        },
                      ]
                    : []),
                  {
                    kind: "menu",
                    key: "more",
                    icon: { sf: "ellipsis", md: "more_vert" },
                    label: pick({ zh: "更多", en: "More", ja: "その他" }),
                    items: [
                      ...(agentInfo?.capabilities.side && online
                        ? [
                            {
                              section: "ask",
                              title: sideCount
                                ? pick({ zh: `旁支对话（${sideCount}）`, en: `Side Chat (${sideCount})`, ja: `サイド会話 (${sideCount})` })
                                : pick({ zh: "旁支对话", en: "Side Chat", ja: "サイド会話" }),
                              subtitle: pick({ zh: "问一句，不打断这一轮", en: "Ask without interrupting", ja: "現在のターンを止めずに質問" }),
                              icon: { sf: "bubble.left.and.text.bubble.right", md: "forum" } as const,
                              onPress: () => openSide(),
                            },
                          ]
                        : []),
                      ...(commandControls.commands.some((command) => command.name === "goal") || view?.goal
                        ? [
                            {
                              section: "ask",
                              title: pick({ zh: "持续目标", en: "Session Goal", ja: "継続ゴール" }),
                              icon: { sf: "target", md: "flag" } as const,
                              onPress: () => router.push({ pathname: "/session/[id]/goal", params: { id } }),
                            },
                          ]
                        : []),
                      {
                        section: "steer",
                        title: t("session.ttsReadAloud"),
                        subtitle: ttsEnabled ? t("session.ttsEnabled") : t("session.ttsDisabled"),
                        icon: ttsEnabled
                          ? ({ sf: "speaker.wave.2.fill", md: "volume_up" } as const)
                          : ({ sf: "speaker.slash", md: "volume_off" } as const),
                        onPress: toggleCommuterTts,
                      },
                      {
                        section: "steer",
                        title: t("nav.settings"),
                        icon: { sf: "slider.horizontal.3", md: "tune" },
                        onPress: () => router.push({ pathname: "/session/[id]/settings", params: { id } }),
                      },
                      ...(canFork
                        ? [
                            {
                              section: "steer",
                              title: pick({ zh: "分叉会话", en: "Fork Session", ja: "セッションをフォーク" }),
                              icon: { sf: "arrow.triangle.branch", md: "fork_right" } as const,
                              onPress: () => askFork(),
                            },
                          ]
                        : []),
                      ...(tier === "handoff" && driver === "remote"
                        ? [
                            {
                              section: "steer",
                              title: pick({ zh: "交还电脑", en: "Hand back to computer", ja: "PC へ操作を戻す" }),
                              icon: { sf: "laptopcomputer", md: "laptop_mac" } as const,
                              onPress: () =>
                                void guard(
                                  () => actions.release(id),
                                  pick({ zh: "交还失败", en: "Release failed", ja: "切り替えに失敗しました" }),
                                ),
                            },
                          ]
                        : []),
                      {
                        section: "look",
                        title: t("session.outline"),
                        icon: { sf: "magnifyingglass", md: "search" },
                        onPress: () => setOutlineOpen(true),
                      },
                      {
                        section: "look",
                        title: t("nav.changes"),
                        icon: { sf: "plus.forwardslash.minus", md: "difference" },
                        onPress: openChanges,
                      },
                      {
                        section: "look",
                        title: t("nav.screen"),
                        icon: { sf: "desktopcomputer", md: "desktop_windows" },
                        onPress: () => {
                          if (hasComputerPreviewRef.current && previewModeRef.current !== "shown") {
                            setComputerPreviewMode(JSON.stringify([computer.key, id]), "shown");
                          } else {
                            router.push("/screen");
                          }
                        },
                      },
                      {
                        section: "look",
                        title: pick({ zh: "打开终端", en: "Open Terminal", ja: "ターミナルを開く" }),
                        icon: { sf: "terminal", md: "terminal" },
                        onPress: () => {
                          void link
                            .call("terminals.create", { cwd: summary.cwd })
                            .then(({ terminal: created }) => {
                              router.push({ pathname: "/terminal/[id]", params: { id: created.id } });
                            })
                            .catch((error: unknown) => {
                              Alert.alert(
                                pick({ zh: "打开终端失败", en: "Failed to open terminal", ja: "ターミナルを開けませんでした" }),
                                error instanceof Error ? error.message : String(error),
                              );
                            });
                        },
                      },
                      {
                        section: "look",
                        title: t("nav.ports"),
                        icon: { sf: "globe", md: "language" },
                        onPress: () =>
                          onOpenPanel
                            ? onOpenPanel("preview")
                            : workspace
                              ? workspace.show("preview")
                              : router.push({ pathname: "/ports", params: { cwd: summary.cwd } }),
                      },
                      {
                        section: "look",
                        title: t("nav.files"),
                        icon: { sf: "folder", md: "folder_open" },
                        onPress: () => router.push({ pathname: "/files", params: { path: summary.cwd } }),
                      },
                      {
                        section: "keep",
                        title: t("session.rename"),
                        icon: { sf: "pencil", md: "edit" },
                        onPress: () => renameSession(summary),
                      },
                      {
                        section: "keep",
                        title: summary.archived ? t("session.restore") : t("session.archive"),
                        icon: summary.archived
                          ? { sf: "tray.and.arrow.up", md: "unarchive" }
                          : { sf: "archivebox", md: "archive" },
                        onPress: () => {
                          void toggleArchived(summary, actions).then((done) => {
                            if (done && !summary.archived) router.back();
                          });
                        },
                      },
                      {
                        section: "keep",
                        title: t("common.copy"),
                        icon: { sf: "doc.on.doc", md: "content_copy" },
                        children: [
                          {
                            title: "Session ID",
                            icon: { sf: "number", md: "tag" },
                            onPress: () => {
                              void Clipboard.setStringAsync(summary.nativeId);
                              haptics.success();
                            },
                          },
                          {
                            title: pick({ zh: "项目路径", en: "Project Path", ja: "プロジェクトパス" }),
                            icon: { sf: "folder", md: "folder" },
                            onPress: () => {
                              void Clipboard.setStringAsync(summary.cwd);
                              haptics.success();
                            },
                          },
                        ],
                      },
                      {
                        section: "keep",
                        title: t("session.delete"),
                        icon: { sf: "trash", md: "delete" },
                        destructive: true,
                        onPress: () => confirmDelete(summary, actions, () => router.back()),
                      },
                    ],
                  },
                ]}
              />
            </>
          )}

          {loading ? null : (
            <LinkBase value={summary.cwd}>
              <TimelineSession.Provider value={id}>
                <TimelineFork.Provider value={canFork ? askFork : undefined}>
                  <TimelineQuestions.Provider value={questions}>
                    <TimelineSide.Provider value={askAboutQuote}>
                      <TimelineWaiting.Provider value={waitingCalls}>
                        <TimelineWrapUp.Provider value={wrapUp}>
                          <Timeline
                            computerPreview
                            previewHeaderConsumed={headerConsumed}
                            ref={listRef}
                            items={timelineItems}
                            planId={view?.planId}
                            turnActive={turnActive}
                            activity={turnActivity({
                              session: summary,
                              progress: promptProgress,
                              online,
                              connecting,
                              ready,
                              hasPermission: !!view?.permissions.length,
                              queued: shownQueue(summary.queue, queueing).length,
                              view,
                            })}
                            composerInset={composerInset}
                            keyboardOffset={keyboardOffset}
                            onFailedMessage={onFailedMessage}
                            onScroll={onScroll}
                            earlier={earlier}
                          />
                        </TimelineWrapUp.Provider>
                      </TimelineWaiting.Provider>
                    </TimelineSide.Provider>
                  </TimelineQuestions.Provider>
                </TimelineFork.Provider>
              </TimelineSession.Provider>
            </LinkBase>
          )}

          {intro ? (
            <Animated.View pointerEvents="box-none" style={[{ position: "absolute", left: 0, right: 0, top: 0, justifyContent: "center" }, introFrame]}>
              {intro}
            </Animated.View>
          ) : null}
          {loading ? <TimelineSkeleton label={t("common.loading")} top={headerConsumed ? 16 : headerHeight + 16} /> : null}
          <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, top: headerConsumed ? 4 : headerHeight + 4, zIndex: 10 }}>
            <ConnectionBanner />
          </View>
          {forking ? (
            <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }} accessibilityViewIsModal>
              <Glass style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 13, borderRadius: 22 }}>
                <ActivityIndicator color={colors.secondaryLabel} />
                <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>
                  {pick({ zh: "正在分叉…", en: "Forking session…", ja: "フォーク中…" })}
                </Text>
              </Glass>
            </View>
          ) : null}

          <Animated.View pointerEvents="box-none" style={[{ position: "absolute", left: 0, right: 0, bottom: 0 }, composerKeyboardStyle]}>
            {!atEnd && items.length > 0 ? (
              <View pointerEvents="box-none" style={{ alignItems: "center", paddingBottom: 2 }}>
                <Pressable
                  onPress={scrollToEnd}
                  accessibilityRole="button"
                  accessibilityLabel={pick({ zh: "回到最新", en: "Jump to latest", ja: "最新へ移動" })}
                  hitSlop={8}
                >
                  <Glass interactive style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
                    <Icon sf="arrow.down" md="arrow_downward" size={16} color={colors.label} weight="semibold" />
                  </Glass>
                </Pressable>
              </View>
            ) : null}
            <View onLayout={(event) => composerInset.set(event.nativeEvent.layout.height)}>
              <Composer
                sessionId={id}
                cwd={summary.cwd}
                agent={summary.agent}
                agentInfo={agentInfo}
                online={online}
                connecting={connecting}
                turnActive={turnActive || summary.state === "unknown"}
                driver={driver}
                permission={view?.permissions[0]}
                permissions={view?.permissions}
                permissionCount={view?.permissions.length ?? 0}
                config={view?.config ?? []}
                commands={commandControls.commands}
                usage={view?.usage}
                bottomInset={bottomInset}
                keyboardOffset={keyboardOffset}
                autoFocusOnPoseEntry={folded !== null}
                autoStartVoice={quickVoicePending}
                onAutoStartVoiceConsumed={() => setQuickVoicePending(false)}
                accessoryHeight={(!atEnd && items.length > 0 ? 42 : 0) + (embedded ? 0 : insets.top)}
                leadingContent={
                  <>
                    <SessionNotices sessionId={id} />
                    <AgentInteractions agent={summary.agent} />
                    {summary.asyncQuestions?.length ? (
                      <AsyncQuestionCard sessionId={id} questions={summary.asyncQuestions} agentName={look.name} disabled={!online} />
                    ) : null}
                    {view?.goal ? <GoalCard sessionId={id} goal={view.goal} /> : null}
                    {tasksRunning > 0 || subagentsRunning > 0 || Object.values(workflows ?? {}).some((record) => workflowIsLive(record.workflow)) ? (
                      <LiveWorkflowsBar sessionId={id} subagentsRunning={subagentsRunning} />
                    ) : null}
                  </>
                }
                onSend={commandControls.send}
                onStop={() => guard(() => actions.cancel(id), pick({ zh: "停止失败", en: "Stop failed", ja: "停止に失敗しました" }))}
                queue={shownQueue(summary.queue, queueing)}
                onUnqueue={(clientMessageId) =>
                  void guard(
                    () => actions.unqueue(id, clientMessageId).then(() => {}),
                    pick({ zh: "取消失败", en: "Unqueue failed", ja: "取り消しに失敗しました" }),
                  )
                }
                onTakeQueued={(clientMessageId) => actions.takeQueued(id, clientMessageId)}
                onSendQueuedNow={(clientMessageId) =>
                  guard(
                    () => actions.sendQueuedNow(id, clientMessageId),
                    pick({ zh: "发送失败", en: "Send failed", ja: "送信失敗" }),
                  )
                }
                onReorderQueue={(clientMessageIds) =>
                  void guard(
                    () => actions.reorderQueue(id, clientMessageIds),
                    pick({ zh: "调整顺序失败", en: "Reorder failed", ja: "並び替えに失敗しました" }),
                  )
                }
                onCommands={() => router.push({ pathname: "/session/[id]/commands", params: { id } })}
                onRespond={(requestId, optionId) => actions.respond(id, requestId, optionId)}
                onAnswer={(requestId, answers) => actions.answer(id, requestId, answers)}
                onTakeover={() => actions.takeover(id)}
                onSettings={() => router.push({ pathname: "/session/[id]/settings", params: { id } })}
              />
            </View>
          </Animated.View>

          <SessionOutlineSheet
            visible={outlineOpen}
            items={timelineItems}
            onClose={() => setOutlineOpen(false)}
            onSelectIndex={(timelineIndex) => {
              const targetId = timelineItems[timelineIndex]?.id;
              if (targetId) listRef.current?.scrollToItemId(targetId, true);
            }}
          />
        </View>
      </ContentHeight>
    </View>
  );
}
