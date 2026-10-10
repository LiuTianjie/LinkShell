import type { PendingPermission, QueueEntry } from "@linkshell/client-core";
import type { AgentInfo, ContentBlock, QuestionAnswer, SessionConfigOption, SessionDriver } from "@linkshell/wire";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import type { DraftAttachment } from "@/lib/composer-drafts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { KeyboardAwareScrollView, useKeyboardState, type KeyboardAwareScrollViewRef } from "react-native-keyboard-controller";
import { useContentHeight } from "@/lib/content-height";
import { composerCardsHeight, composerCardsKeyboardOffset, composerViewport } from "@/lib/composer-layout";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useComposerDraft } from "@/lib/use-composer-draft";
import { useIsFocused } from "expo-router/react-navigation";
import { commandDetail, commandQuery, matchCommands, normalizeCommandText } from "@/lib/commands";
import { haptics } from "@/lib/haptics";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Button } from "./button";
import { ConfigSummary } from "./config-menu";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { PermissionActions } from "./permission-actions";
import { PermissionContext } from "./permission-context";
import { openAuthorization } from "@/lib/authorization";
import { PlusMenu } from "./plus-menu";
import { QueuePanel } from "./queue-panel";
import { QuestionCard } from "./question-card";
import { UsageRing } from "./usage-ring";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ComposerProps {
  sessionId: string;
  agent: string;
  agentInfo?: AgentInfo;
  online: boolean;
  turnActive: boolean;
  driver?: SessionDriver;
  permission?: PendingPermission;
  permissionCount: number;
  config: SessionConfigOption[];
  commands: { name: string; description: string; hint?: string }[];
  usage?: { usedTokens?: number; contextWindow?: number };
  bottomInset: number;
  accessoryHeight?: number;
  keyboardOffset?: number;
  autoFocusOnPoseEntry?: boolean;
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

function blockedReason(props: ComposerProps): Blocked {
  const name = agentLook(props.agent).short;
  if (!props.online) return { title: "电脑离线", detail: "内容还能查看，电脑连上后才能继续" };
  const info = props.agentInfo;
  if (info && !info.installed) return { title: `这台电脑上没有 ${name}`, detail: info.problem };
  if (info?.auth?.state === "missing") return { title: `${name} 还没登录`, detail: info.auth.hint };
  if (info?.tier === "terminal") return { title: "这个 Agent 只有终端", detail: "请在终端里输入" };
  return null;
}

export function Composer(props: ComposerProps) {
  const { agent, turnActive, driver, permission, permissionCount, config, bottomInset } = props;
  const height = useContentHeight();
  const keyboardHeight = useKeyboardState((state) => state.height);
  const viewport = composerViewport(height, keyboardHeight, bottomInset, props.accessoryHeight ?? 0, props.keyboardOffset ?? bottomInset);
  const { compact, textMaxHeight } = viewport;
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  const measuredInputHeight = inputHeight ?? (compact ? 56 : 100);
  const cardsHeight = composerCardsHeight(viewport.available, measuredInputHeight, bottomInset, keyboardHeight);
  const cardsScroll = useRef<KeyboardAwareScrollViewRef>(null);
  const { text, setText, attachments, setAttachments } = useComposerDraft(props.sessionId);
  const focused = useIsFocused();
  const [flash, setFlash] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const name = agentLook(agent).short;
  const blocked = blockedReason(props);
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
  // Names that start with what's typed, then names that contain it; the common built-ins lead.
  const suggestions = useMemo(() => (slashQuery === undefined ? [] : matchCommands(props.commands, slashQuery)), [props.commands, slashQuery]);
  const hasCommands = tier !== "terminal";

  const commandPicked = /^\s*\/[\S]+ $/.test(text);
  useEffect(() => {
    if (!focused || !commandPicked) return;
    // Wait for the sheet to finish dismissing before restoring the keyboard.
    const timer = setTimeout(() => input.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [focused, commandPicked]);

  const addImage = async (camera: boolean) => {
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.8, allowsMultipleSelection: !camera, selectionLimit: 4 };
    try {
      if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("没有相机权限", "可以在系统设置里允许 LinkShell 使用相机。");
          return;
        }
      }
      const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return;
      const picked = result.assets
        .filter((asset) => asset.base64 && asset.base64.length * 0.75 <= MAX_IMAGE_BYTES)
        .map((asset) => ({ uri: asset.uri, mimeType: asset.mimeType ?? "image/jpeg", data: asset.base64! }));
      if (picked.length < result.assets.length) Alert.alert("有图片太大", "单张图片不能超过 5 MB。");
      setAttachments((current) => [...current, ...picked].slice(0, 4));
      haptics.selection();
    } catch (error) {
      Alert.alert("没能添加图片", error instanceof Error ? error.message : String(error));
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
        if ((asset.size ?? file.size) > MAX_IMAGE_BYTES) throw new Error("单个附件不能超过 5 MB");
        const bytes = Buffer.from(await file.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error("单个附件不能超过 5 MB");
        const mimeType = asset.mimeType ?? "application/octet-stream";
        const decoded = bytes.toString("utf8");
        const text = !audio && (/^text\//.test(mimeType) || /\.(md|txt|json|csv|ts|tsx|js|jsx|py|swift|rs|go|yaml|yml)$/i.test(asset.name)) && Buffer.from(decoded).equals(bytes) ? decoded : undefined;
        const picked: DraftAttachment = { kind: audio ? "audio" : "resource", name: asset.name, uri: `attachment:${encodeURIComponent(asset.name)}`, mimeType, data: bytes.toString("base64"), text };
        setAttachments((current) => [...current, picked].slice(0, 4));
      } finally { if (file.uri.startsWith(Paths.cache.uri)) { try { file.delete(); } catch { /* Cache eviction is best effort. */ } } }
    } catch (error) { Alert.alert("没能添加附件", error instanceof Error ? error.message : String(error)); }
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

  const send = async () => {
    if (!hasContent || inputDisabled) return;
    haptics.light();
    const content: ContentBlock[] = [
      ...attachments.map((attachment): ContentBlock => attachment.kind === "resource"
        ? { type: "resource", resource: { uri: attachment.uri, mimeType: attachment.mimeType, ...(attachment.text === undefined ? { blob: attachment.data } : { text: attachment.text }) } }
        : { type: attachment.kind === "audio" ? "audio" : "image", mimeType: attachment.mimeType, data: attachment.data }),
      ...(trimmed ? [{ type: "text" as const, text: normalizeCommandText(trimmed) }] : []),
    ];
    setText("");
    setAttachments([]);
    try {
      const delivery = await props.onSend(content);
      if (delivery === "steered") showFlash("已插话，正在调整方向");
      else if (delivery === "failed") haptics.error();
    } catch (error) {
      setText((current) => current || text);
      setAttachments((current) => current.length ? current : attachments);
      Alert.alert("命令未执行", error instanceof Error ? error.message : String(error));
    }
  };

  // A queued message comes back to be edited: its text ahead of what's being typed, its pictures beside the others.
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
    // Stopping drops what's queued; its text comes back here, like the terminal does.
    const queued = (props.queue ?? [])
      .filter((entry) => !entry.pending)
      .map((entry) => entry.text)
      .filter(Boolean);
    if (queued.length) setText((current) => [...queued, current].filter(Boolean).join("\n\n"));
    setStopping(true);
    try {
      await props.onStop();
    } finally {
      setStopping(false);
    }
  };

  const placeholder = permission
    ? "或者直接告诉它该怎么做…"
    : turnActive
      ? `排队一条消息，${name} 忙完这一轮就发`
      : `给 ${name} 发消息`;

  const order = { model: 0, model_config: 1, effort: 2, mode: 3, other: 4 } as const;
  const configShown = config
    .filter((option) => option.values.length > 1)
    .sort((a, b) => order[a.category] - order[b.category])
    .slice(0, 4);

  const hasInputExtras = !!(flash || attachments.length || blocked?.detail || compact && configShown.length);
  const hasCards = !!(slashQuery !== undefined || props.leadingContent || permission || props.queue?.length || hasInputExtras);

  return (
    <View onLayout={props.onLayout} style={{ paddingHorizontal: 10, paddingBottom: bottomInset + 8, paddingTop: 6, gap: hasCards && cardsHeight > 0 ? 8 : 0 }}>
      {hasCards ? <KeyboardAwareScrollView
        ref={cardsScroll}
        style={{ maxHeight: cardsHeight, flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
        bottomOffset={composerCardsKeyboardOffset(measuredInputHeight)}
        // The sticky parent already sits above the keyboard; reserve only the pinned input when scrolling.
        extraKeyboardSpace={-keyboardHeight}
        onLayout={() => { if (keyboardHeight > 0) cardsScroll.current?.assureFocusedInputVisible(); }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets={false}
        nestedScrollEnabled
        bounces={false}
      >
      {slashQuery !== undefined ? <Glass style={{ borderRadius: 22, padding: 8 }}>
          {suggestions.length ? (
            // Keep a bounded list so suggestions do not take over the conversation.
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
                  accessibilityLabel={`使用命令 /${command.name}`}
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
                    borderRadius: 10,
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
          ) : null}
{!suggestions.length ? <Text style={[type.footnote, { padding: 12, color: colors.secondaryLabel }]}>{props.commands.length ? "没有匹配的命令 · 可以打开命令面板查看全部" : "Agent 尚未报告命令 · 连接或接管后会自动更新"}</Text> : null}
</Glass> : null}
      {props.leadingContent}
      {permission ? (
        <View collapsable={false} style={{ flexShrink: 0 }}>
          {permission.questions?.length ? (
            <QuestionCard
              sessionId={props.sessionId}
              contained
              key={permission.requestId}
              request={permission}
              count={permissionCount}
              agentName={name}
              disabled={!props.online}
              onAnswer={props.onAnswer}
              onChoose={props.onRespond}
            />
          ) : (
            <Glass style={{ borderRadius: 26, padding: 14, gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 9,
                    borderCurve: "continuous",
                    backgroundColor: colors.waitingSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon sf="hand.raised.fill" md="front_hand" size={13} color={colors.waiting} />
                </View>
                <Text numberOfLines={2} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
                  {permission.title}
                </Text>
                {permissionCount > 1 ? (
                  <Text style={[type.caption, { color: colors.waiting, fontWeight: "600" }]}>1/{permissionCount}</Text>
                ) : null}
              </View>
              {permission.detail ? (
                <PermissionDetail key={`detail:${permission.requestId}`} detail={permission.detail} />
              ) : null}
              <PermissionContext request={permission} />
              <PermissionActions
                key={permission.requestId}
                options={permission.options}
                disabled={!props.online}
                size="large"
                onChoose={(optionId) => { openAuthorization(permission, optionId); return props.onRespond(permission.requestId, optionId); }}
              />
              {tier === "multi_client" || tier === "handoff" ? (
                <Text style={[type.caption, { color: colors.tertiaryLabel, textAlign: "center" }]}>在哪边回答都行，另一边会同步收起</Text>
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
            onSendNow={props.onSendQueuedNow}
            onEdit={(clientMessageId) => void editQueued(clientMessageId)}
            onRemove={props.onUnqueue}
            onReorder={props.onReorderQueue}
          />
        </View>
      ) : null}

      {hasInputExtras ? (
        <Glass style={{ borderRadius: 22, paddingHorizontal: 8, paddingVertical: 8 }}>
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
                  {image.kind === "audio" || image.kind === "resource" ? <View style={{ width: 108, height: 64, borderRadius: 14, backgroundColor: colors.fill, padding: 8, justifyContent: "center", gap: 4 }}><Icon sf={image.kind === "audio" ? "waveform" : "doc"} md={image.kind === "audio" ? "graphic_eq" : "description"} size={18} color={colors.accent} /><Text numberOfLines={1} style={[type.caption, { color: colors.label }]}>{image.name ?? "附件"}</Text></View> : <Image source={{ uri: image.uri }} style={{ width: 64, height: 64, borderRadius: 14 }} contentFit="cover" />}
                  <Pressable
                    onPress={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                    accessibilityRole="button"
                    accessibilityLabel={`移除第 ${index + 1} 个附件`}
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
          {compact && configShown.length ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}><ConfigSummary options={configShown} disabled={!props.online || !!blocked} onPress={props.onSettings} /><UsageRing used={props.usage?.usedTokens} window={props.usage?.contextWindow} /></View> : null}
        </Glass>
      ) : null}
      </KeyboardAwareScrollView> : null}

      <View onLayout={(event) => setInputHeight(event.nativeEvent.layout.height)}>
      {desktopDriving && !blocked ? (
        <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)}>
          <ScrollView style={{ maxHeight: Math.max(0, viewport.available - bottomInset - 14) }} keyboardShouldPersistTaps="handled" bounces={false}>
            <TakeoverPanel onTakeover={props.onTakeover} onStop={turnActive ? stop : undefined} stopping={stopping} />
          </ScrollView>
        </Animated.View>
      ) : (
        <Glass style={{ borderRadius: 26, paddingTop: 4, paddingBottom: 8, paddingHorizontal: 8 }}>
          <View style={{ flexDirection: compact ? "row" : "column", alignItems: compact ? "center" : "stretch", gap: compact ? 4 : 0 }}>
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            editable={!inputDisabled}
            multiline
            placeholder={blocked ? blocked.title : placeholder}
            placeholderTextColor={colors.placeholder as string}
            selectionColor={colors.accent}
            style={[type.callout, { color: colors.label, maxHeight: textMaxHeight, minHeight: 44, flex: compact ? 1 : undefined, minWidth: 0, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 6 }]}
            accessibilityLabel="消息"
            submitBehavior="newline"
          />
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
            {/* (Commands: the + menu, or `/` in the input.) */}
            {!compact ? <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
              {configShown.length ? <ConfigSummary options={configShown} disabled={!props.online || !!blocked} onPress={props.onSettings} /> : null}
            </View> : null}
            {!compact ? <UsageRing used={props.usage?.usedTokens} window={props.usage?.contextWindow} /> : null}
            {/* Stop stays within reach for as long as a turn runs, whoever drives it. */}
            {turnActive ? <RoundButton label="停止" onPress={() => void stop()} busy={stopping} tone="stop" /> : null}
            {turnActive && !hasContent ? null : (
              <RoundButton label={turnActive ? "排队" : "发送"} wide={turnActive && !compact} onPress={() => void send()} disabled={!hasContent || inputDisabled} tone="send" />
            )}
          </View>
          </View>
        </Glass>
      )}
      </View>
    </View>
  );
}

function PermissionDetail({ detail }: { detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textStyle = { fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.codeText };
  return (
    <View style={{ backgroundColor: colors.code, borderRadius: 12, borderCurve: "continuous", padding: 10, overflow: "hidden" }}>
      {/* Measure the full text at the same width so wrapped lines also offer expansion. */}
      <Text
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        onTextLayout={(event) => setOverflows(event.nativeEvent.lines.length > 6)}
        style={[textStyle, { position: "absolute", top: 10, left: 10, right: 10, opacity: 0 }]}
      >
        {detail}
      </Text>
      <Text selectable numberOfLines={expanded ? undefined : 6} style={textStyle}>{detail}</Text>
      {overflows ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}
        >
          <Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>{expanded ? "收起" : "展开完整内容"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function RoundButton({
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
  const background = tone === "stop" ? colors.label : disabled ? colors.fillStrong : colors.accent;
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
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : tone === "stop" ? (
        <Icon sf="stop.fill" md="stop" size={12} color={foreground} />
      ) : (
        <Icon sf="arrow.up" md="arrow_upward" size={15} color={foreground} weight="bold" />
      )}
      {wide ? <Text style={[type.footnote, { color: foreground, fontWeight: "700" }]}>{label}</Text> : null}
    </Pressable>
  );
}

function TakeoverPanel({ onTakeover, onStop, stopping = false }: { onTakeover: () => Promise<void>; onStop?: () => Promise<void>; stopping?: boolean }) {
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
    <Glass style={{ borderRadius: 26, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 13,
            borderCurve: "continuous",
            backgroundColor: colors.fill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon sf="laptopcomputer" md="laptop_mac" size={20} color={colors.label} />
        </View>
        <View style={{ flex: 1, minWidth: 120, gap: 2 }}>
          <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>电脑正在操作这个会话</Text>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>接管后在手机上继续，电脑随时能收回</Text>
        </View>
        {/* The turn running on the computer can be stopped from here without taking over. */}
        {onStop ? <RoundButton label="停止" onPress={() => void onStop()} busy={stopping} tone="stop" /> : null}
        <Button title="接管" variant="primary" busy={busy} onPress={() => void takeover()} icon={{ sf: "iphone", md: "smartphone" }} />
      </View>
      {error ? (
        <Text selectable style={[type.footnote, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}
    </Glass>
  );
}
