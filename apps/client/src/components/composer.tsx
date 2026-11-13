import type { PendingPermission, QueueEntry } from "@linkshell/client-core";
import type { AgentInfo, ContentBlock, ProjectFileEntry, QuestionAnswer, SessionConfigOption, SessionDriver } from "@linkshell/wire";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import type { DraftAttachment } from "@/lib/composer-drafts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { KeyboardAwareScrollView, useKeyboardState, type KeyboardAwareScrollViewRef } from "react-native-keyboard-controller";
import { useContentHeight } from "@/lib/content-height";
import { composerCardsHeight, composerCardsKeyboardOffset, composerViewport } from "@/lib/composer-layout";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useComposerDraft } from "@/lib/use-composer-draft";
import { useIsFocused } from "expo-router/react-navigation";
import type { MenuAction } from "@react-native-menu/menu";
import { useConnection, useActions } from "@/lib/client";
import {
  applyAtMention,
  defaultQuickPrompts,
  extractAtMention,
  loadCustomQuickPrompts,
  saveCustomQuickPrompts,
  type QuickPromptItem,
} from "@/lib/coding-ux";
import { commandDetail, commandQuery, matchCommands, normalizeCommandText } from "@/lib/commands";
import { haptics } from "@/lib/haptics";
import { imageMimeType } from "@/lib/image-type";
import { isRisky, isToggle, modelChipLabel, optionLabel, valueHint, valueLabel } from "@/lib/labels";
import { useLocale, type LocalizedTriplet } from "@/lib/locale";
import { queuedSendAction } from "@/lib/queued-send-action";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";
import { AppMenu } from "./app-menu";
import { Button } from "./button";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { PermissionActions } from "./permission-actions";
import { PermissionContext, PermissionPager } from "./permission-context";
import { openAuthorization } from "@/lib/authorization";
import { mergeVoiceTranscript, useVoiceInput } from "@/lib/voice-input";
import { PlusMenu } from "./plus-menu";
import { QueuePanel } from "./queue-panel";
import { QuestionCard } from "./question-card";
import { UsageRing } from "./usage-ring";
import { VoiceInputBar } from "./voice-input-bar";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** How far the cards' glass shadow reaches past them (pt); the composer's side padding bounds `side`. */
const CARD_SHADOW = { top: 10, side: 10, bottom: 14 };

export interface ComposerProps {
  sessionId: string;
  cwd?: string;
  agent: string;
  agentInfo?: AgentInfo;
  online: boolean;
  /** Connection presentation only; sending and approval still require online. */
  connecting?: boolean;
  turnActive: boolean;
  driver?: SessionDriver;
  permission?: PendingPermission;
  permissions?: PendingPermission[];
  permissionCount: number;
  config: SessionConfigOption[];
  commands: { name: string; description: string; hint?: string }[];
  usage?: { usedTokens?: number; contextWindow?: number };
  bottomInset: number;
  accessoryHeight?: number;
  keyboardOffset?: number;
  autoFocusOnPoseEntry?: boolean;
  autoStartVoice?: boolean;
  onAutoStartVoiceConsumed?: () => void;
  leadingContent?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  onSend: (content: ContentBlock[]) => Promise<"started" | "steered" | "queued" | "duplicate" | "failed" | "handled">;
  onStop: () => Promise<void>;
  onRespond: (requestId: string, optionId: string) => Promise<void>;
  /** Answers the questions of a pending request. */
  onAnswer: (requestId: string, answers: QuestionAnswer[]) => Promise<void>;
  onTakeover: () => Promise<void>;
  /** Opens the sheet with every session setting. */
  onSettings: () => void;
  /** Messages the computer holds until the current turn ends. */
  queue?: QueueEntry[];
  onUnqueue: (clientMessageId: string) => void;
  /** Takes a queued message out of the queue; what it said goes back into the input. */
  onTakeQueued: (clientMessageId: string) => Promise<ContentBlock[] | undefined>;
  onSendQueuedNow: (clientMessageId: string) => Promise<void>;
  onReorderQueue: (clientMessageIds: string[]) => void;
  /** Opens the sheet with all of the agent's commands (what it picks comes back through `onCommandPicked`). */
  onCommands: () => void;
}

type Blocked = { title: string; detail?: string } | null;

function blockedReason(props: ComposerProps, pick: (copy: LocalizedTriplet) => string): Blocked {
  const name = agentLook(props.agent).short;
  if (!props.online) {
    return props.connecting
      ? {
          title: pick({ zh: "正在连接电脑…", en: "Connecting to computer…", ja: "PC に接続中…" }),
          detail: pick({ zh: "连接恢复后即可继续", en: "Resumes automatically when connected", ja: "接続が回復すると再開できます" }),
        }
      : {
          title: pick({ zh: "电脑离线", en: "Computer offline", ja: "PC がオフライン" }),
          detail: pick({ zh: "内容还能查看，电脑连上后才能继续", en: "History stays readable; reconnect to continue", ja: "履歴は閲覧可能です。再接続後に続行できます" }),
        };
  }
  const info = props.agentInfo;
  if (info && !info.installed) {
    return {
      title: pick({ zh: `这台电脑上没有 ${name}`, en: `${name} is not installed`, ja: `${name} がインストールされていません` }),
      detail: info.problem,
    };
  }
  if (info?.auth?.state === "missing") {
    return {
      title: pick({ zh: `${name} 还没登录`, en: `${name} is not signed in`, ja: `${name} にサインインしていません` }),
      detail: info.auth.hint,
    };
  }
  if (info?.tier === "terminal") {
    return {
      title: pick({ zh: "这个 Agent 只有终端", en: "Terminal-only agent", ja: "ターミナル専用エージェント" }),
      detail: pick({ zh: "请在终端里输入", en: "Please type inside the terminal", ja: "ターミナルで入力してください" }),
    };
  }
  return null;
}

export function Composer(props: ComposerProps) {
  const { agent, turnActive, driver, permission: firstPermission, permissions: permissionList, permissionCount, config, bottomInset } = props;
  const { locale, t, pick, speechLocale } = useLocale();
  const { link } = useConnection();
  const { setConfig } = useActions();
  const allPermissions = useMemo(
    () => (permissionList?.length ? permissionList : firstPermission ? [firstPermission] : []),
    [permissionList, firstPermission],
  );
  const [permIndex, setPermIndex] = useState(0);
  useEffect(() => {
    setPermIndex(0);
  }, [props.sessionId]);
  useEffect(() => {
    setPermIndex((current) => (allPermissions.length ? Math.min(current, allPermissions.length - 1) : 0));
  }, [allPermissions.length]);
  const safePermIndex = allPermissions.length ? Math.min(permIndex, allPermissions.length - 1) : 0;
  const permission = allPermissions[safePermIndex];
  const totalPermissions = Math.max(permissionCount, allPermissions.length);
  const height = useContentHeight();
  const keyboardHeight = useKeyboardState((state) => state.height);
  const viewport = composerViewport(height, keyboardHeight, bottomInset, props.accessoryHeight ?? 0, props.keyboardOffset ?? bottomInset);
  const { compact, textMaxHeight } = viewport;
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  const measuredInputHeight = inputHeight ?? (compact ? 56 : 100);
  const cardsHeight = composerCardsHeight(viewport.available, measuredInputHeight, bottomInset, keyboardHeight);
  const cardsScroll = useRef<KeyboardAwareScrollViewRef>(null);
  const { text, setText, attachments, setAttachments } = useComposerDraft(props.sessionId);
  const [selectionEnd, setSelectionEnd] = useState<number | undefined>(undefined);
  const focused = useIsFocused();
  const [flash, setFlash] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const name = agentLook(agent).short;
  const blocked = blockedReason(props, pick);
  const tier = props.agentInfo?.tier;
  const desktopDriving = tier === "handoff" && driver === "desktop";
  const trimmed = text.trim();
  const canAttachImages = props.agentInfo?.capabilities.images ?? false;
  const canAttachAudio = props.agentInfo?.capabilities.audio ?? false;
  const canAttachFiles = props.agentInfo?.capabilities.embeddedContext ?? false;
  const hasContent = trimmed.length > 0 || attachments.length > 0;
  const input = useRef<TextInput>(null);
  const poseFocused = useRef(false);
  const slashQuery = commandQuery(text);
  const suggestions = useMemo(() => (slashQuery === undefined ? [] : matchCommands(props.commands, slashQuery)), [props.commands, slashQuery]);
  const hasCommands = tier !== "terminal";

  // `@file` fuzzy project autocomplete
  const atMention = useMemo(() => (slashQuery === undefined ? extractAtMention(text, selectionEnd) : undefined), [slashQuery, text, selectionEnd]);
  const hasAtMention = Boolean(atMention);
  const atMentionQuery = atMention?.query;
  const cwd = props.cwd;
  const online = props.online;
  const [fileMatches, setFileMatches] = useState<ProjectFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  useEffect(() => {
    if (!hasAtMention || !cwd || !online) {
      setFileMatches([]);
      setFilesLoading(false);
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await link.call("fs.projectFiles", {
          cwd,
          query: atMentionQuery || undefined,
          limit: 30,
        });
        if (!cancelled) setFileMatches(res.files ?? []);
      } catch {
        if (!cancelled) setFileMatches([]);
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [atMentionQuery, cwd, hasAtMention, link, online]);

  // Customizable Quick Prompt chips
  const [customChips, setCustomChips] = useState<QuickPromptItem[]>(() => loadCustomQuickPrompts());
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [draftChipLabel, setDraftChipLabel] = useState("");
  const [draftChipPrompt, setDraftChipPrompt] = useState("");
  const quickPrompts = useMemo(() => [...defaultQuickPrompts(locale), ...customChips], [customChips, locale]);

  const addCustomQuickPrompt = () => {
    const label = draftChipLabel.trim();
    const prompt = draftChipPrompt.trim();
    if (!label || !prompt) return;
    const next = [...customChips, { id: `custom-${Date.now()}`, label, prompt, custom: true }];
    setCustomChips(next);
    saveCustomQuickPrompts(next);
    setDraftChipLabel("");
    setDraftChipPrompt("");
    setCustomModalOpen(false);
    haptics.success();
  };

  const removeCustomQuickPrompt = (id: string) => {
    const next = customChips.filter((item) => item.id !== id);
    setCustomChips(next);
    saveCustomQuickPrompts(next);
    haptics.selection();
  };

  const commandPicked = /^\s*\/[\S]+ $/.test(text);
  useEffect(() => {
    if (!focused || !commandPicked) return;
    const timer = setTimeout(() => input.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [focused, commandPicked]);

  const addImage = async (camera: boolean) => {
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.75, allowsMultipleSelection: !camera, selectionLimit: 4 };
    try {
      if (camera) {
        const permissionRes = await ImagePicker.requestCameraPermissionsAsync();
        if (!permissionRes.granted) {
          Alert.alert(
            pick({ zh: "没有相机权限", en: "Camera permission required", ja: "カメラの権限が必要です" }),
            pick({ zh: "可以在系统设置里允许 LinkShell 使用相机。", en: "Allow camera access in Settings.", ja: "システム設定でカメラを許可してください。" }),
          );
          return;
        }
      }
      const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return;
      const picked = result.assets
        .filter((asset) => asset.base64 && asset.base64.length * 0.75 <= MAX_IMAGE_BYTES)
        .map((asset) => ({ uri: asset.uri, mimeType: imageMimeType(asset.base64!, asset.mimeType), data: asset.base64! }));
      if (picked.length < result.assets.length) {
        Alert.alert(
          pick({ zh: "图片超过 5 MB 上限", en: "Image exceeds 5 MB limit", ja: "画像が 5 MB の上限を超えています" }),
          pick({
            zh: "单张图片不能超过 5 MB，已跳过过大的图片，请压缩或换一张更小的图片。",
            en: "Each image must be 5 MB or smaller. Oversized images were skipped.",
            ja: "1枚あたり 5 MB 以下にしてください。",
          }),
        );
      }
      if (picked.length) {
        setAttachments((current) => [...current, ...picked].slice(0, 4));
        haptics.selection();
      }
    } catch (error) {
      Alert.alert(pick({ zh: "没能添加图片", en: "Could not add image", ja: "画像を追加できませんでした" }), error instanceof Error ? error.message : String(error));
    }
  };
  const inputDisabled = !!blocked || desktopDriving;
  const addDocument = async (audio: boolean) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: audio ? "audio/*" : "*/*", copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const asset = result.assets[0]!;
      const file = new File(asset.uri);
      try {
        if ((asset.size ?? file.size) > MAX_IMAGE_BYTES) throw new Error(pick({ zh: "单个附件不能超过 5 MB", en: "Attachment must be <= 5 MB", ja: "添付ファイルは 5 MB 以下にしてください" }));
        const bytes = Buffer.from(await file.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error(pick({ zh: "单个附件不能超过 5 MB", en: "Attachment must be <= 5 MB", ja: "添付ファイルは 5 MB 以下にしてください" }));
        const mimeType = asset.mimeType ?? "application/octet-stream";
        const decoded = bytes.toString("utf8");
        const docText = !audio && (/^text\//.test(mimeType) || /\.(md|txt|json|csv|ts|tsx|js|jsx|py|swift|rs|go|yaml|yml)$/i.test(asset.name)) && Buffer.from(decoded).equals(bytes) ? decoded : undefined;
        const picked: DraftAttachment = { kind: audio ? "audio" : "resource", name: asset.name, uri: `attachment:${encodeURIComponent(asset.name)}`, mimeType, data: bytes.toString("base64"), text: docText };
        setAttachments((current) => [...current, picked].slice(0, 4));
      } finally {
        if (file.uri.startsWith(Paths.cache.uri)) {
          try { file.delete(); } catch { /* Cache eviction is best effort. */ }
        }
      }
    } catch (error) {
      Alert.alert(pick({ zh: "没能添加附件", en: "Could not add attachment", ja: "添付ファイルを追加できませんでした" }), error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    if (!props.autoFocusOnPoseEntry) { poseFocused.current = false; return; }
    if (!focused || inputDisabled || poseFocused.current) return;
    const frame = requestAnimationFrame(() => {
      if (!input.current) return;
      poseFocused.current = true;
      input.current.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.autoFocusOnPoseEntry, focused, inputDisabled]);

  const showFlash = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash((current) => (current === message ? null : current)), 2600);
  };

  const sendWithText = async (overrideText?: string) => {
    const body = (overrideText ?? text).trim();
    const canSend = body.length > 0 || attachments.length > 0;
    if (!canSend || inputDisabled) return;
    haptics.light();
    const content: ContentBlock[] = [
      ...attachments.map((attachment): ContentBlock => attachment.kind === "resource"
        ? { type: "resource", resource: { uri: attachment.uri, mimeType: attachment.mimeType, ...(attachment.text === undefined ? { blob: attachment.data } : { text: attachment.text }) } }
        : { type: attachment.kind === "audio" ? "audio" : "image", mimeType: attachment.mimeType, data: attachment.data }),
      ...(body ? [{ type: "text" as const, text: normalizeCommandText(body) }] : []),
    ];
    if (overrideText === undefined) {
      setText("");
      setAttachments([]);
    }
    try {
      const delivery = await props.onSend(content);
      if (delivery === "steered") showFlash(pick({ zh: "已插话，正在调整方向", en: "Steered into current turn", ja: "現在のターンに指示を反映しました" }));
      else if (delivery === "failed") haptics.error();
    } catch (error) {
      if (overrideText === undefined) {
        setText((current) => current || text);
        setAttachments((current) => current.length ? current : attachments);
      }
      Alert.alert(pick({ zh: "命令未执行", en: "Command failed", ja: "送信できませんでした" }), error instanceof Error ? error.message : String(error));
    }
  };

  const send = () => sendWithText();
  const holdModeRef = useRef(false);
  const voice = useVoiceInput({
    currentText: text,
    localeId: speechLocale,
    onChangeText: setText,
    onSendAfterStop: (finalText) => void sendWithText(finalText),
    onError: (message) => showFlash(message),
  });
  const cancelVoice = voice.cancel;
  const startVoice = voice.start;
  useEffect(() => {
    if (!focused) void cancelVoice();
  }, [cancelVoice, focused]);

  // Siri / Action Button `linkshell:///quick-voice` trigger
  const { autoStartVoice, onAutoStartVoiceConsumed } = props;
  useEffect(() => {
    if (!autoStartVoice || !focused || inputDisabled) return;
    onAutoStartVoiceConsumed?.();
    const timer = setTimeout(() => {
      void startVoice();
    }, 180);
    return () => clearTimeout(timer);
  }, [autoStartVoice, focused, inputDisabled, onAutoStartVoiceConsumed, startVoice]);

  const editQueued = async (clientMessageId: string) => {
    const content = await props.onTakeQueued(clientMessageId).catch(() => undefined);
    if (!content) return;
    const words = content.map((block) => (block.type === "text" ? block.text : "")).join("").trim();
    const images = content.flatMap((block): DraftAttachment[] =>
      (block.type === "image" || block.type === "audio") && block.data
        ? [{ kind: block.type, uri: `data:${block.mimeType};base64,${block.data}`, mimeType: block.mimeType, data: block.data }]
        : block.type === "resource" ? [{ kind: "resource", uri: block.resource.uri, name: block.resource.uri, mimeType: block.resource.mimeType ?? "application/octet-stream", data: block.resource.blob ?? "", text: block.resource.text }] : [],
    );
    if (words) setText((current) => [words, current.trim()].filter(Boolean).join("\n\n"));
    if (images.length) setAttachments((current) => [...images, ...current].slice(0, 4));
  };

  const stop = async () => {
    haptics.medium();
    setStopping(true);
    try {
      await props.onStop();
    } finally {
      setStopping(false);
    }
  };

  const placeholder = permission
    ? pick({ zh: "或者直接告诉它该怎么做…", en: "Or type instructions directly…", ja: "または直接指示を入力…" })
    : turnActive
      ? pick({ zh: `排队一条消息，${name} 忙完这一轮就发`, en: `Queue a message for ${name}…`, ja: `${name} の次のターンに予約送信…` })
      : t("composer.placeholder");

  const order = { model: 0, model_config: 1, effort: 2, mode: 3, other: 4 } as const;
  const configShown = config
    .filter((option) => option.values.length > 1)
    .sort((a, b) => order[a.category] - order[b.category])
    .slice(0, 4);

  const showAtAutocomplete = Boolean(atMention && props.cwd && props.online);
  const showQuickPrompts = !hasContent && !voice.recording && !inputDisabled && !permission && slashQuery === undefined && !showAtAutocomplete;
  const hasInputExtras = !!(flash || attachments.length || blocked?.detail || (compact && configShown.length));
  const hasCards = !!(slashQuery !== undefined || showAtAutocomplete || props.leadingContent || permission || props.queue?.length || hasInputExtras);

  return (
    <View onLayout={props.onLayout} style={{ paddingHorizontal: 10, paddingBottom: bottomInset + 8, paddingTop: 6, gap: (hasCards && cardsHeight > 0) || showQuickPrompts ? 8 : 0 }}>
      {hasCards ? (
        <KeyboardAwareScrollView
          ref={cardsScroll}
          style={{ maxHeight: cardsHeight + CARD_SHADOW.top + CARD_SHADOW.bottom, flexGrow: 0, marginHorizontal: -CARD_SHADOW.side, marginTop: -CARD_SHADOW.top, marginBottom: -CARD_SHADOW.bottom }}
          contentContainerStyle={{ gap: 8, paddingHorizontal: CARD_SHADOW.side, paddingTop: CARD_SHADOW.top, paddingBottom: 12 + CARD_SHADOW.bottom }}
          bottomOffset={composerCardsKeyboardOffset(measuredInputHeight)}
          extraKeyboardSpace={-keyboardHeight}
          onLayout={() => { if (keyboardHeight > 0) cardsScroll.current?.assureFocusedInputVisible(); }}
          contentInsetAdjustmentBehavior="never"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets={false}
          nestedScrollEnabled
          bounces={false}
        >
          {slashQuery !== undefined ? (
            <Glass style={{ borderRadius: radius.panel, padding: 8 }}>
              {suggestions.length ? (
                <ScrollView
                  style={{ maxHeight: 220, marginTop: 6 }}
                  contentContainerStyle={{ paddingHorizontal: 4 }}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={suggestions.length > 5}
                >
                  {suggestions.map((command) => (
                    <Pressable
                      key={command.name}
                      accessibilityRole="button"
                      accessibilityLabel={`/${command.name}`}
                      onPress={() => {
                        haptics.selection();
                        setText(`/${command.name} `);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        minHeight: 44,
                        paddingVertical: 8,
                        paddingHorizontal: 8,
                        borderRadius: radius.control,
                        borderCurve: "continuous",
                        backgroundColor: pressed ? colors.fill : "transparent",
                      })}
                    >
                      <Text numberOfLines={1} style={{ flexShrink: 1, maxWidth: "55%", fontFamily: mono, fontSize: 14, color: colors.accent, fontWeight: "600" }}>/{command.name}</Text>
                      <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
                        {commandDetail(command)}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <Text style={[type.footnote, { padding: 12, color: colors.secondaryLabel }]}>
                  {props.commands.length
                    ? pick({ zh: "没有匹配的命令 · 可以打开命令面板查看全部", en: "No matching command · Open Command Palette for all", ja: "一致するコマンドがありません" })
                    : pick({ zh: "Agent 尚未报告命令 · 连接或接管后会自动更新", en: "Agent has not reported slash commands yet", ja: "スラッシュコマンドがまだ読み込まれていません" })}
                </Text>
              )}
            </Glass>
          ) : null}

          {showAtAutocomplete ? (
            <Glass style={{ borderRadius: radius.panel, padding: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingTop: 2, paddingBottom: 4 }}>
                <Text style={[type.caption, { color: colors.secondaryLabel, fontWeight: "600" }]}>{t("composer.mentionFiles")}</Text>
                {filesLoading ? <ActivityIndicator size="small" color={colors.secondaryLabel} /> : null}
              </View>
              {fileMatches.length > 0 ? (
                <ScrollView
                  style={{ maxHeight: 200 }}
                  contentContainerStyle={{ paddingHorizontal: 4 }}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={fileMatches.length > 5}
                >
                  {fileMatches.map((entry) => (
                    <Pressable
                      key={entry.relativePath}
                      accessibilityRole="button"
                      accessibilityLabel={`@${entry.relativePath}`}
                      onPress={() => {
                        haptics.selection();
                        setText(applyAtMention(text, entry.relativePath, selectionEnd));
                      }}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        minHeight: 40,
                        paddingVertical: 6,
                        paddingHorizontal: 8,
                        borderRadius: radius.control,
                        borderCurve: "continuous",
                        backgroundColor: pressed ? colors.fill : "transparent",
                      })}
                    >
                      <Icon sf={entry.isDir ? "folder" : "doc.text"} md={entry.isDir ? "folder" : "description"} size={15} color={colors.accent} />
                      <Text numberOfLines={1} style={{ flex: 1, fontFamily: mono, fontSize: 13, color: colors.label }}>
                        {entry.relativePath}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <Text style={[type.footnote, { padding: 10, color: colors.secondaryLabel }]}>
                  {filesLoading ? t("composer.mentionSearching") : t("composer.mentionEmpty")}
                </Text>
              )}
            </Glass>
          ) : null}

          {props.leadingContent}
          {permission ? (
            <View collapsable={false} style={{ flexShrink: 0, gap: 6 }}>
              {permission.questions?.length ? (
                <>
                  {totalPermissions > 1 ? (
                    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 4 }}>
                      <PermissionPager
                        index={safePermIndex}
                        total={totalPermissions}
                        onPrev={() => setPermIndex((i) => Math.max(0, i - 1))}
                        onNext={() => setPermIndex((i) => Math.min(allPermissions.length - 1, i + 1))}
                      />
                    </View>
                  ) : null}
                  <QuestionCard
                    sessionId={props.sessionId}
                    contained
                    key={permission.requestId}
                    request={permission}
                    count={totalPermissions}
                    agentName={name}
                    disabled={!props.online}
                    onAnswer={props.onAnswer}
                    onChoose={props.onRespond}
                  />
                </>
              ) : (
                <Glass style={{ borderRadius: radius.panel, padding: 14, gap: 10 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Icon sf="hand.raised.fill" md="front_hand" size={15} color={colors.waiting} />
                    <Text numberOfLines={2} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
                      {permission.title}
                    </Text>
                    <PermissionPager
                      index={safePermIndex}
                      total={totalPermissions}
                      onPrev={() => setPermIndex((i) => Math.max(0, i - 1))}
                      onNext={() => setPermIndex((i) => Math.min(allPermissions.length - 1, i + 1))}
                    />
                  </View>
                  <PermissionContext request={permission} />
                  <PermissionActions
                    key={permission.requestId}
                    options={permission.options}
                    disabled={!props.online}
                    size="large"
                    onChoose={(optionId) => {
                      openAuthorization(permission, optionId);
                      return props.onRespond(permission.requestId, optionId);
                    }}
                  />
                  {tier === "multi_client" || tier === "handoff" ? (
                    <Text style={[type.caption, { color: colors.tertiaryLabel, textAlign: "center" }]}>
                      {pick({ zh: "在哪边回答都行，另一边会同步收起", en: "Answer on either device; the other syncs immediately", ja: "どちらの端末で応答しても同期されます" })}
                    </Text>
                  ) : null}
                </Glass>
              )}
            </View>
          ) : null}

          {props.queue?.length ? (
            <View collapsable={false} style={{ flexShrink: 0 }}>
              <QueuePanel
                contained
                queue={props.queue}
                disabled={inputDisabled}
                sendAction={queuedSendAction(props.agentInfo, turnActive, driver)}
                status={
                  blocked?.title ??
                  (desktopDriving
                    ? pick({ zh: "接管后可调整队列", en: "Take over to manage queue", ja: "引き継ぐとキューを編集できます" })
                    : turnActive
                      ? pick({ zh: "完成当前回合后依次发送", en: "Sends after current turn", ja: "現在のターン終了後に順次送信" })
                      : pick({ zh: "等待电脑接收", en: "Waiting for computer", ja: "PC の受信待ち" }))
                }
                onSendNow={props.onSendQueuedNow}
                onEdit={(clientMessageId) => void editQueued(clientMessageId)}
                onRemove={props.onUnqueue}
                onReorder={props.onReorderQueue}
              />
            </View>
          ) : null}

          {hasInputExtras ? (
            <Glass style={{ borderRadius: radius.panel, paddingHorizontal: 8, paddingVertical: 8 }}>
              {flash ? (
                <Animated.Text
                  allowFontScaling={false}
                  maxFontSizeMultiplier={1}
                  entering={FadeIn.duration(180)}
                  exiting={FadeOut.duration(180)}
                  style={[type.caption, { color: colors.accent, paddingHorizontal: 8, paddingTop: 6, fontWeight: "600" }]}
                >
                  {flash}
                </Animated.Text>
              ) : null}
              {attachments.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 6, paddingTop: 8 }}>
                  {attachments.map((image, index) => (
                    <View key={`${image.uri}-${index}`}>
                      {image.kind === "audio" || image.kind === "resource" ? (
                        <View style={{ width: 108, height: 64, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.fill, padding: 8, justifyContent: "center", gap: 4 }}>
                          <Icon sf={image.kind === "audio" ? "waveform" : "doc"} md={image.kind === "audio" ? "graphic_eq" : "description"} size={18} color={colors.accent} />
                          <Text numberOfLines={1} style={[type.caption, { color: colors.label }]}>{image.name ?? "File"}</Text>
                        </View>
                      ) : (
                        <Image source={{ uri: image.uri }} style={{ width: 64, height: 64, borderRadius: radius.control }} contentFit="cover" />
                      )}
                      <Pressable
                        onPress={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                        accessibilityRole="button"
                        style={{
                          position: "absolute",
                          top: 0,
                          right: 0,
                          width: 44,
                          height: 44,
                          alignItems: "flex-end",
                          justifyContent: "flex-start",
                        }}
                      >
                        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.65)", alignItems: "center", justifyContent: "center" }}>
                          <Icon sf="xmark" md="close" size={9} color="#ffffff" weight="bold" />
                        </View>
                      </Pressable>
                    </View>
                  ))}
                </ScrollView>
              ) : null}
              {blocked?.detail ? (
                <Text numberOfLines={2} style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 8, paddingBottom: 4 }]}>
                  {blocked.detail}
                </Text>
              ) : null}
              {compact && configShown.length ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
                  <ConfigPillMenu
                    options={configShown}
                    allOptions={config}
                    disabled={!props.online || !!blocked}
                    onSelectConfig={(optionId, value) =>
                      void setConfig(props.sessionId, optionId, value).catch((error: unknown) =>
                        Alert.alert("切换失败", error instanceof Error ? error.message : String(error)),
                      )
                    }
                    onMoreSettings={props.onSettings}
                  />
                  <UsageRing used={props.usage?.usedTokens} window={props.usage?.contextWindow} />
                </View>
              ) : null}
            </Glass>
          ) : null}
        </KeyboardAwareScrollView>
      ) : null}

      {showQuickPrompts ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 6, paddingHorizontal: 2 }}
        >
          {quickPrompts.map((chip) => (
            <Pressable
              key={chip.id}
              accessibilityRole="button"
              accessibilityLabel={chip.label}
              onPress={() => {
                haptics.selection();
                setText(chip.prompt);
                input.current?.focus();
              }}
              onLongPress={() => {
                haptics.selection();
                if (chip.custom) {
                  Alert.alert(
                    chip.label,
                    chip.prompt,
                    [
                      { text: t("common.cancel"), style: "cancel" },
                      {
                        text: pick({ zh: "填入输入框", en: "Insert into input", ja: "入力欄に挿入" }),
                        onPress: () => {
                          setText(chip.prompt);
                          input.current?.focus();
                        },
                      },
                      {
                        text: pick({ zh: "删除", en: "Delete", ja: "削除" }),
                        style: "destructive",
                        onPress: () => removeCustomQuickPrompt(chip.id),
                      },
                    ],
                  );
                } else {
                  setText(chip.prompt);
                  input.current?.focus();
                }
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: colors.card,
                opacity: pressed ? 0.65 : 1,
              })}
            >
              <Icon sf="bolt.fill" md="bolt" size={11} color={colors.accent} />
              <Text numberOfLines={1} style={[type.caption, { color: colors.label, fontWeight: "500" }]}>
                {chip.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("composer.quickPrompts")}
            onPress={() => {
              haptics.selection();
              setCustomModalOpen(true);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 999,
              borderCurve: "continuous",
              backgroundColor: colors.fill,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Icon sf="plus" md="add" size={12} color={colors.secondaryLabel} />
          </Pressable>
        </ScrollView>
      ) : null}

      <View onLayout={(event) => setInputHeight(event.nativeEvent.layout.height)}>
        {desktopDriving && !blocked ? (
          <View>
            <ScrollView
              style={{ maxHeight: Math.max(0, viewport.available - bottomInset - 14) + CARD_SHADOW.top + CARD_SHADOW.bottom, marginHorizontal: -CARD_SHADOW.side, marginTop: -CARD_SHADOW.top, marginBottom: -CARD_SHADOW.bottom }}
              contentContainerStyle={{ paddingHorizontal: CARD_SHADOW.side, paddingTop: CARD_SHADOW.top, paddingBottom: CARD_SHADOW.bottom }}
              keyboardShouldPersistTaps="handled"
              bounces={false}
            >
              <TakeoverPanel onTakeover={props.onTakeover} onStop={turnActive ? stop : undefined} stopping={stopping} />
            </ScrollView>
          </View>
        ) : (
          <Glass style={{ borderRadius: radius.panel, paddingTop: 4, paddingBottom: 8, paddingHorizontal: 8 }}>
            <View style={{ flexDirection: compact && !voice.recording ? "row" : "column", alignItems: compact && !voice.recording ? "center" : "stretch", gap: compact && !voice.recording ? 4 : 0 }}>
              <TextInput
                ref={input}
                value={text}
                onChangeText={setText}
                onSelectionChange={(e) => setSelectionEnd(e.nativeEvent.selection.end)}
                editable={!inputDisabled}
                multiline
                placeholder={
                  blocked
                    ? blocked.title
                    : voice.recording
                      ? pick({ zh: "正在聆听…（说话会自动转为文字）", en: "Listening… (speech converts to text)", ja: "聞き取り中…（音声がテキストに変換されます）" })
                      : placeholder
                }
                placeholderTextColor={colors.placeholder as string}
                selectionColor={colors.accent}
                style={[type.callout, { color: colors.label, maxHeight: textMaxHeight, minHeight: 44, flex: compact && !voice.recording ? 1 : undefined, minWidth: 0, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 6 }]}
                accessibilityLabel={t("composer.send")}
                submitBehavior="newline"
              />
              {voice.recording ? (
                <VoiceInputBar
                  elapsedSeconds={voice.elapsedSeconds}
                  levels={voice.levels}
                  canceling={voice.canceling}
                  processing={voice.processing}
                  hasText={hasContent}
                  onCancel={() => void voice.cancel()}
                  onFinish={() => void voice.stop(false)}
                  onSendNow={() => void voice.stop(true)}
                  onInjectPhrase={(phrase) => {
                    haptics.selection();
                    setText((current) => mergeVoiceTranscript(current, phrase));
                  }}
                />
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 4 : 6, minHeight: 44, paddingLeft: 2 }}>
                  <PlusMenu
                    canAttachImages={canAttachImages}
                    canAttachAudio={canAttachAudio}
                    canAttachFiles={canAttachFiles}
                    hasCommands={hasCommands}
                    disabled={inputDisabled || (!canAttachImages && !canAttachAudio && !canAttachFiles && !hasCommands)}
                    onPickPhoto={() => void addImage(false)}
                    onTakePhoto={() => void addImage(true)}
                    onPickAudio={() => void addDocument(true)}
                    onPickFile={() => void addDocument(false)}
                    onCommands={props.onCommands}
                  />
                  {!compact ? (
                    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
                      {configShown.length ? (
                        <ConfigPillMenu
                          options={configShown}
                          allOptions={config}
                          disabled={!props.online || !!blocked}
                          onSelectConfig={(optionId, value) =>
                            void setConfig(props.sessionId, optionId, value).catch((error: unknown) =>
                              Alert.alert("切换失败", error instanceof Error ? error.message : String(error)),
                            )
                          }
                          onMoreSettings={props.onSettings}
                        />
                      ) : null}
                    </View>
                  ) : null}
                  {!compact ? <UsageRing used={props.usage?.usedTokens} window={props.usage?.contextWindow} /> : null}
                  <Pressable
                    disabled={inputDisabled}
                    accessibilityRole="button"
                    accessibilityLabel={pick({ zh: "语音输入", en: "Voice input", ja: "音声入力" })}
                    hitSlop={6}
                    onPress={() => {
                      holdModeRef.current = false;
                      void voice.start();
                    }}
                    onLongPress={() => {
                      holdModeRef.current = true;
                      void voice.start();
                    }}
                    onTouchMove={(event) => {
                      if (!holdModeRef.current || !voice.recording) return;
                      const y = event.nativeEvent.locationY;
                      voice.setCanceling(y < -30);
                    }}
                    onPressOut={() => {
                      if (!holdModeRef.current || !voice.recording) return;
                      holdModeRef.current = false;
                      if (voice.canceling) void voice.cancel();
                      else void voice.stop(false);
                    }}
                    style={({ pressed }) => ({
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      backgroundColor: colors.fill,
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: inputDisabled ? 0.45 : pressed ? 0.6 : 1,
                    })}
                  >
                    <Icon sf="mic.fill" md="mic" size={22} color={colors.label} />
                  </Pressable>
                  {turnActive ? <RoundButton label={t("session.stop")} onPress={() => void stop()} busy={stopping} tone="stop" /> : null}
                  {turnActive && !hasContent ? null : (
                    <RoundButton
                      label={turnActive ? pick({ zh: "排队", en: "Queue", ja: "予約" }) : t("composer.send")}
                      wide={turnActive && !compact}
                      onPress={() => void send()}
                      disabled={!hasContent || inputDisabled}
                      tone="send"
                    />
                  )}
                </View>
              )}
            </View>
          </Glass>
        )}
      </View>

      <Modal visible={customModalOpen} transparent animationType="fade" onRequestClose={() => setCustomModalOpen(false)}>
        <Pressable
          onPress={() => setCustomModalOpen(false)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <Pressable
            onPress={() => {}}
            style={{ width: "100%", maxWidth: 380, backgroundColor: colors.card, borderRadius: radius.panel, padding: 18, gap: 12 }}
          >
            <Text style={[type.headline, { color: colors.label }]}>{t("composer.quickPrompts")}</Text>
            <TextInput
              value={draftChipLabel}
              onChangeText={setDraftChipLabel}
              placeholder={pick({ zh: "快捷指令名称（如：代码审查）", en: "Chip label (e.g. Code Review)", ja: "ボタン名（例: コードレビュー）" })}
              placeholderTextColor={colors.placeholder as string}
              style={{ fontSize: 15, color: colors.label, backgroundColor: colors.fill, borderRadius: radius.control, paddingHorizontal: 12, paddingVertical: 10 }}
            />
            <TextInput
              value={draftChipPrompt}
              onChangeText={setDraftChipPrompt}
              placeholder={pick({ zh: "点击后发送给 Agent 的完整指令…", en: "Full prompt sent to Agent when tapped…", ja: "タップ時に送信するプロンプト…" })}
              placeholderTextColor={colors.placeholder as string}
              multiline
              style={{ fontSize: 15, color: colors.label, backgroundColor: colors.fill, borderRadius: radius.control, paddingHorizontal: 12, paddingVertical: 10, minHeight: 72 }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Button title={t("common.cancel")} variant="tonal" size="small" onPress={() => setCustomModalOpen(false)} />
              <Button title={t("common.save")} variant="primary" size="small" onPress={addCustomQuickPrompt} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

export function RoundButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  wide = false,
  tone,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  wide?: boolean;
  tone: "send" | "stop";
}) {
  const background = tone === "stop" ? colors.label : disabled ? colors.fillStrong : colors.accentFill;
  const foreground = tone === "stop" ? colors.plain : disabled ? colors.tertiaryLabel : colors.onAccent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        paddingVertical: 6,
        paddingHorizontal: wide ? 12 : 0,
        borderRadius: 22,
        backgroundColor: background,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : tone === "stop" ? (
        <View style={{ width: 18, height: 18, borderRadius: 4, backgroundColor: foreground }} />
      ) : (
        <Icon sf="arrow.up" md="arrow_upward" size={22} color={foreground} weight="bold" />
      )}
      {wide ? <Text style={[type.footnote, { color: foreground, fontWeight: "700" }]}>{label}</Text> : null}
    </Pressable>
  );
}

function TakeoverPanel({ onTakeover, onStop, stopping = false }: { onTakeover: () => Promise<void>; onStop?: () => Promise<void>; stopping?: boolean }) {
  const { t, pick } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takeover = async () => {
    haptics.medium();
    setBusy(true);
    setError(null);
    try {
      await onTakeover();
      haptics.success();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Glass style={{ borderRadius: radius.panel, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.control,
            borderCurve: "continuous",
            backgroundColor: colors.fill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon sf="laptopcomputer" md="laptop_mac" size={20} color={colors.label} />
        </View>
        <View style={{ flex: 1, minWidth: 120, gap: 2 }}>
          <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>
            {pick({ zh: "电脑正在操作这个会话", en: "Computer is driving this session", ja: "PC がこのセッションを操作中" })}
          </Text>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
            {pick({ zh: "在手机上继续，电脑随时能收回", en: "Take over on mobile; desktop can reclaim anytime", ja: "スマホで引き継いでも PC からいつでも戻せます" })}
          </Text>
        </View>
        {onStop ? <RoundButton label={t("session.stop")} onPress={() => void onStop()} busy={stopping} tone="stop" /> : null}
        <Button title={pick({ zh: "接管", en: "Take over", ja: "引き継ぐ" })} variant="primary" busy={busy} onPress={() => void takeover()} icon={{ sf: "iphone", md: "smartphone" }} />
      </View>
      {error ? (
        <Text selectable style={[type.footnote, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}
    </Glass>
  );
}

const MENU_CATEGORY_ORDER = { model: 0, mode: 1, effort: 2, model_config: 3, other: 4 } as const;

function ConfigPillMenu({
  options,
  allOptions,
  disabled = false,
  onSelectConfig,
  onMoreSettings,
}: {
  options: SessionConfigOption[];
  allOptions: SessionConfigOption[];
  disabled?: boolean;
  onSelectConfig: (optionId: string, value: string) => void;
  onMoreSettings: () => void;
}) {
  const model = options.find((option) => option.category === "model");
  const effort = options.find((option) => option.category === "effort");
  const mode = options.find((option) => option.category === "mode" && !isToggle(option));
  const risky = !!mode && isRisky(mode.current);
  const on = options.filter((option) => isToggle(option) && option.current === "on");
  const words = [
    model ? modelChipLabel(model) : mode ? valueLabel(mode, mode.current) : undefined,
    effort ? valueLabel(effort, effort.current) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const label = options.map((option) => `${optionLabel(option)}：${valueLabel(option, option.current)}`).join("，");

  const { menuActions, handlers } = useMemo(() => {
    const map = new Map<string, () => void>();
    const configurable = allOptions
      .filter((option) => option.values.length > 1)
      .sort((a, b) => MENU_CATEGORY_ORDER[a.category] - MENU_CATEGORY_ORDER[b.category]);
    const actions: MenuAction[] = configurable.map((option) => ({
      id: `opt:${option.id}`,
      title: optionLabel(option),
      subtitle: valueLabel(option, option.current),
      image:
        option.category === "model"
          ? "cpu"
          : option.category === "mode"
            ? isRisky(option.current)
              ? "exclamationmark.shield"
              : "lock.shield"
            : option.category === "effort"
              ? "gauge.medium"
              : undefined,
      subactions: option.values.map((entry, idx) => {
        const actionId = `set:${option.id}:${idx}`;
        map.set(actionId, () => {
          if (entry.value !== option.current) onSelectConfig(option.id, entry.value);
        });
        return {
          id: actionId,
          title: entry.group ? `${entry.group} · ${valueLabel(option, entry.value)}` : valueLabel(option, entry.value),
          subtitle: entry.description ?? valueHint(option, entry.value),
          state: entry.value === option.current ? ("on" as const) : ("off" as const),
          attributes: { disabled },
        };
      }),
    }));
    map.set("__more_settings__", onMoreSettings);
    actions.push({
      id: "__more_settings__",
      title: "更多设置…",
      image: "slider.horizontal.3",
    });
    return { menuActions: actions, handlers: map };
  }, [allOptions, disabled, onMoreSettings, onSelectConfig]);

  const chip = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={`会话设置，${label}`}
      style={{ minHeight: 44, minWidth: 0, flexShrink: 1, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 5, opacity: disabled ? 0.5 : 1 }}
    >
      {risky ? <Icon sf="exclamationmark.shield.fill" md="gpp_maybe" size={14} color={colors.waiting} /> : null}
      {on.map((option) => (
        <Icon key={option.id} sf={option.id === "plan" ? "list.bullet.clipboard" : "bolt.fill"} md={option.id === "plan" ? "checklist" : "bolt"} size={13} color={colors.accent} />
      ))}
      <Text numberOfLines={1} style={[type.footnote, { flexShrink: 1, color: colors.label, fontWeight: "600" }]}>{words || "会话设置"}</Text>
      <Icon sf="chevron.down" md="expand_more" size={8} color={colors.tertiaryLabel} weight="bold" />
    </View>
  );

  if (disabled) return chip;

  return (
    <AppMenu
      title="会话设置"
      actions={menuActions}
      shouldOpenOnLongPress={false}
      onOpenMenu={() => haptics.selection()}
      onPressAction={({ nativeEvent }) => {
        haptics.selection();
        handlers.get(nativeEvent.event)?.();
      }}
    >
      {chip}
    </AppMenu>
  );
}
