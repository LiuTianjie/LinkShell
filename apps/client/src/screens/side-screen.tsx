import type { SideChat, SideMessage } from "@linkshell/wire";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { usePageInsets } from "@/components/adaptive-page";
import { RoundButton } from "@/components/composer";
import { Text, TextInput } from "@/components/fixed-text";
import { Glass } from "@/components/glass";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { SheetHeader } from "@/components/sheet-header";
import { LiveDot } from "@/components/status";
import { LinkBase } from "@/lib/links";
import { useActions, useClient, useSessionSubscription } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

const NO_SIDES: SideChat[] = [];
const NEW = "new";
/** Closer than this to the end counts as reading the latest: a growing answer is followed. */
const FOLLOW_WITHIN = 48;
/** Questions that make sense in any session, offered before the first one. */
const SUGGESTIONS = ["刚才这一轮做了什么？", "到现在改了哪些文件？", "接下来打算怎么做？"];

/** How the agent answers a side question, in a line. */
function howItAnswers(agent: string, name: string): string {
  if (agent === "codex") return `${name} 在只读的临时分叉里回答，可以查看文件，不会改动任何东西。`;
  return `${name} 依据会话到现在为止的内容回答，不使用工具。`;
}

/**
 * The session's side conversations (Codex's `/side`, Claude's and Grok's
 * `/btw`): ask about the session without interrupting it or adding to it.
 * They live on the computer while they are open.
 */
export function SideScreen() {
  const { id, side } = useLocalSearchParams<{ id: string; side?: string }>();
  return <SideContent sessionId={id} initialSide={side} />;
}

/**
 * A sheet on a phone; beside the conversation, as a workspace panel, where
 * the screen has room for both (an unfolded iPhone Duo, an iPad).
 */
export function SideContent({ sessionId: id, initialSide: initial, embedded = false }: { sessionId: string; initialSide?: string; embedded?: boolean }) {
  useSessionSubscription(id);
  const session = useClient((state) => state.sessions[id]);
  const sides = useClient((state) => state.sides[id] ?? NO_SIDES);
  const online = useClient((state) => state.status === "online");
  const actions = useActions();
  const insets = usePageInsets();
  const keyboardHeight = useKeyboardState((state) => state.height);
  // Nothing picked shows the latest one: coming back after closing the sheet
  // mid-answer lands on that conversation. A new one is asked for (NEW).
  const [sideId, setSideId] = useState<string | undefined>(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const scroll = useRef<ScrollView>(null);
  const chips = useRef<ScrollView>(null);
  const look = agentLook(session?.agent ?? "");
  const current = sideId === NEW ? undefined : (sides.find((entry) => entry.sideId === sideId) ?? sides[sides.length - 1]);

  // What the computer has open, on arrival and after every reconnect.
  useEffect(() => {
    if (online) void actions.loadSides(id).catch(() => {});
  }, [online, actions, id]);
  // A new conversation joins the chips at the end: keep it in view, once it is laid out.
  const chipCount = useRef(0);
  const chipsGrew = () => {
    if (sides.length > chipCount.current) chips.current?.scrollToEnd({ animated: true });
    chipCount.current = sides.length;
  };
  // Another conversation opens at its end.
  useEffect(() => {
    following.current = true;
    setAtEnd(true);
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 0);
    return () => clearTimeout(timer);
  }, [current?.sideId]);

  const onScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    const near = contentSize.height - contentOffset.y - layoutMeasurement.height < FOLLOW_WITHIN;
    following.current = near;
    if (near !== atEnd) setAtEnd(near);
  };
  const toEnd = () => {
    following.current = true;
    setAtEnd(true);
    scroll.current?.scrollToEnd({ animated: true });
  };

  const ask = async (text: string, fromDraft: boolean) => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    try {
      const asked = await actions.askSide(id, question, current?.sideId);
      setSideId(asked.sideId);
      if (fromDraft) setDraft("");
      following.current = true;
      haptics.selection();
    } catch (error) {
      haptics.error();
      Alert.alert("没能提问", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!current) return;
    const closing = current.sideId;
    Alert.alert("结束这个旁支？", "旁支对话只在电脑的内存里，结束后这些问答就没有了。", [
      { text: "取消", style: "cancel" },
      {
        text: "结束",
        style: "destructive",
        onPress: () => {
          haptics.selection();
          setSideId(undefined);
          void actions.closeSide(id, closing).catch((error: unknown) => Alert.alert("没能结束", error instanceof Error ? error.message : String(error)));
        },
      },
    ]);
  };

  const running = !!current?.running;
  return (
    <>
      {embedded ? null : <SheetHeader title="旁支对话" actions={[{ key: "close", label: "结束这个旁支", icon: { sf: "xmark.bin", md: "delete" }, onPress: close, disabled: !current }]} />}
      <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
        {/* Shown with even one open, so a new question never hides the one there is; above the scroll, so switching needs no scrolling back. */}
        {sides.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", paddingTop: 4, paddingBottom: 10 }}>
            {/* Pinned ahead of the conversations, so it never scrolls out of reach. */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16 }}>
              <SideChip label="＋ 新的" accessibilityLabel="新的旁支" picked={!current} onPress={() => setSideId(NEW)} />
              {/* Where the scrolling chips start: a cut chip reads as scrolled, not broken. */}
              <View style={{ width: 1, height: 18, backgroundColor: colors.separator }} />
            </View>
            <ScrollView ref={chips} horizontal showsHorizontalScrollIndicator={false} onContentSizeChange={chipsGrew} style={{ flex: 1 }} contentContainerStyle={{ gap: 8, paddingLeft: 8, paddingRight: 16 }}>
              {sides.map((entry, index) => (
                <SideChip
                  key={entry.sideId}
                  label={entry.messages[0]?.text || `旁支 ${index + 1}`}
                  picked={entry.sideId === current?.sideId}
                  running={entry.running}
                  onPress={() => setSideId(entry.sideId)}
                />
              ))}
            </ScrollView>
            {/* A panel has no sheet bar to hold this. Always there, so the chips don't shift when it can't be used. */}
            {embedded ? (
              <Pressable onPress={close} disabled={!current} accessibilityRole="button" accessibilityLabel="结束这个旁支" accessibilityState={{ disabled: !current }} hitSlop={4} style={({ pressed }) => ({ width: 44, height: 44, marginRight: 8, marginVertical: -7, alignItems: "center", justifyContent: "center", opacity: !current ? 0.3 : pressed ? 0.6 : 1 })}>
                <Icon sf="xmark.bin" md="delete" size={17} color={colors.secondaryLabel} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          <LinkBase value={session?.cwd ?? ""}>
            <ScrollView
              ref={scroll}
              style={{ flex: 1 }}
              contentContainerStyle={{ flexGrow: 1, padding: 16, paddingTop: sides.length > 0 ? 6 : 16, gap: 14 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              scrollEventThrottle={32}
              onScroll={onScroll}
              onContentSizeChange={() => {
                if (following.current) scroll.current?.scrollToEnd({ animated: true });
              }}
            >
              {!current ? (
                <Intro agentName={look.name} how={howItAnswers(session?.agent ?? "", look.name)} disabled={!online || busy} onAsk={(question) => void ask(question, false)} />
              ) : (
                current.messages.map((message, index) => (
                  <SideMessageView key={message.id} message={message} answering={current.running && index === current.messages.length - 1} />
                ))
              )}
            </ScrollView>
          </LinkBase>
          {!atEnd && current ? (
            <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 8, alignItems: "center" }}>
              <Pressable onPress={toEnd} accessibilityRole="button" accessibilityLabel="回到最新" hitSlop={8}>
                <Glass interactive style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
                  <Icon sf="arrow.down" md="arrow_downward" size={16} color={colors.label} weight="semibold" />
                </Glass>
              </Pressable>
            </Animated.View>
          ) : null}
        </View>
        {/* The keyboard covers the home indicator; a hardware keyboard (no height) does not. A panel stops above the screen's edge; its send button lines up with the conversation's. */}
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: embedded ? 18 : keyboardHeight > insets.bottom ? 8 : Math.max(insets.bottom, 8) + 4, gap: 6 }}>
          {!online ? <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 8 }]}>电脑离线，连上后才能提问。</Text> : null}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 6, paddingLeft: 4, borderRadius: 26, borderCurve: "continuous", backgroundColor: colors.sheetCard }}>
            <TextInput
              accessibilityLabel="旁支问题"
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={20_000}
              editable={online}
              placeholder={current ? "接着问…" : `问 ${look.name}…`}
              placeholderTextColor={colors.placeholder as string}
              selectionColor={colors.accent}
              submitBehavior="newline"
              style={[type.callout, { flex: 1, minWidth: 0, minHeight: 44, maxHeight: 160, paddingHorizontal: 10, paddingTop: 11, paddingBottom: 9, color: colors.label }]}
            />
            {running && current ? (
              <RoundButton label="停止回答" tone="stop" onPress={() => void actions.cancelSide(id, current.sideId).catch(() => {})} />
            ) : (
              <RoundButton label={current ? "接着问" : "提问"} tone="send" busy={busy} disabled={!online || !draft.trim()} onPress={() => void ask(draft, true)} />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

/** Before the first question: what a side conversation is, and a few to start with. */
function Intro({ agentName, how, disabled, onAsk }: { agentName: string; how: string; disabled: boolean; onAsk: (question: string) => void }) {
  return (
    <View style={{ flex: 1, justifyContent: "flex-end", gap: 14, paddingBottom: 4 }}>
      <View style={{ gap: 4 }}>
        <Text style={[type.headline, { color: colors.label }]}>问 {agentName} 一句，不打断会话</Text>
        <Text style={[type.subhead, { color: colors.secondaryLabel }]}>问答不进入会话。{how}</Text>
      </View>
      <View style={{ alignItems: "flex-start", gap: 8 }}>
        {SUGGESTIONS.map((question) => (
          <Pressable
            key={question}
            onPress={() => { haptics.selection(); onAsk(question); }}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`问：${question}`}
            accessibilityState={{ disabled }}
            style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18, borderCurve: "continuous", backgroundColor: colors.fill, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}
          >
            <Text style={[type.subhead, { color: colors.label }]}>{question}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function SideChip({ label, accessibilityLabel, picked, running, onPress }: { label: string; accessibilityLabel?: string; picked: boolean; running?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => { haptics.selection(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: picked, busy: running }}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: picked ? colors.accentSoft : colors.fill }}
    >
      {running ? <LiveDot size={6} color={colors.running} /> : null}
      <Text numberOfLines={1} style={[type.footnote, { color: picked ? colors.accent : colors.label, fontWeight: "600", maxWidth: 160 }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * What the agent did on the way to an answer, in one line: the step it is on
 * while it answers, how many it took after. Every step is a tap away.
 */
function SideActivity({ lines, live }: { lines: string[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = live ? lines[lines.length - 1]! : `执行了 ${lines.length} 步`;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        onPress={() => { haptics.selection(); setOpen((value) => !value); }}
        accessibilityRole="button"
        accessibilityLabel={open ? "收起步骤" : `${summary}，展开全部步骤`}
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%" }}
      >
        {live ? <LiveDot size={6} color={colors.running} /> : null}
        <Text numberOfLines={1} style={[type.footnote, { flexShrink: 1, color: colors.secondaryLabel }]}>{summary}</Text>
        <Icon sf={open ? "chevron.up" : "chevron.down"} md={open ? "expand_less" : "expand_more"} size={11} color={colors.tertiaryLabel} weight="semibold" />
      </Pressable>
      {open ? (
        <View style={{ gap: 3, paddingLeft: 2, borderLeftWidth: 2, borderLeftColor: colors.fill, marginLeft: 2 }}>
          {lines.map((line, index) => (
            <Text key={index} numberOfLines={2} style={[type.caption, { fontFamily: mono, color: colors.secondaryLabel, paddingLeft: 8 }]}>{line}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SideMessageView({ message, answering }: { message: SideMessage; answering: boolean }) {
  if (message.role === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "88%", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18, backgroundColor: colors.userBubble }}>
        <Text selectable style={[type.body, { color: colors.label }]}>{message.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {message.activity?.length ? <SideActivity lines={message.activity} live={answering} /> : null}
      {message.text ? <Markdown text={message.text} streaming={answering} /> : null}
      {answering && !message.text && !message.activity?.length ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={colors.secondaryLabel} />
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>正在回答…</Text>
        </View>
      ) : null}
      {message.error ? <Text style={[type.footnote, { color: message.error === "已停止" ? colors.secondaryLabel : colors.danger }]}>{message.error}</Text> : null}
    </View>
  );
}
