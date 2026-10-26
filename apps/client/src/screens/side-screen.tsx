import type { SideChat, SideMessage } from "@linkshell/wire";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from "react-native-keyboard-controller";
import { Button } from "@/components/button";
import { Text, TextInput } from "@/components/fixed-text";
import { Markdown } from "@/components/markdown";
import { SheetHeader } from "@/components/sheet-header";
import { LinkBase } from "@/lib/links";
import { useActions, useClient, useSessionSubscription } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const NO_SIDES: SideChat[] = [];

/** How the agent answers a side question, in a line. */
function howItAnswers(agent: string, name: string): string {
  if (agent === "codex") return `${name} 在会话的只读临时分叉里回答：可以查看文件、运行不改动任何东西的命令，问答不进入会话。`;
  return `${name} 依据会话到现在为止的内容回答，不使用工具，问答不进入会话。`;
}

/**
 * The session's side conversations (Codex's `/side`, Claude's and Grok's
 * `/btw`): ask about the session without interrupting it or adding to it.
 * They live on the computer while they are open.
 */
export function SideScreen() {
  const { id, side: initial } = useLocalSearchParams<{ id: string; side?: string }>();
  useSessionSubscription(id);
  const session = useClient((state) => state.sessions[id]);
  const sides = useClient((state) => state.sides[id] ?? NO_SIDES);
  const online = useClient((state) => state.status === "online");
  const actions = useActions();
  const [sideId, setSideId] = useState<string | undefined>(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scroll = useRef<KeyboardAwareScrollViewRef>(null);
  const look = agentLook(session?.agent ?? "");
  const current = sides.find((entry) => entry.sideId === sideId);

  // What the computer has open, on arrival and after every reconnect.
  useEffect(() => {
    if (online) void actions.loadSides(id).catch(() => {});
  }, [online, actions, id]);
  // The one picked is gone (closed elsewhere): show another, or a new one.
  useEffect(() => {
    if (sideId && !current && sides.length > 0) setSideId(sides[sides.length - 1]!.sideId);
  }, [sideId, current, sides]);
  const last = current?.messages[current.messages.length - 1];
  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(timer);
  }, [current?.messages.length, last?.text.length]);

  const ask = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const asked = await actions.askSide(id, text, current?.sideId);
      setSideId(asked.sideId);
      setDraft("");
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
    setSideId(undefined);
    void actions.closeSide(id, closing).catch((error: unknown) => Alert.alert("没能结束", error instanceof Error ? error.message : String(error)));
  };

  return (
    <>
      <SheetHeader
        title="旁支对话"
        actions={[
          { key: "new", label: "新的旁支", icon: { sf: "plus.bubble", md: "add_comment" }, onPress: () => setSideId(undefined), disabled: !current },
          { key: "close", label: "结束这个旁支", icon: { sf: "xmark.bin", md: "delete" }, onPress: close, disabled: !current },
        ]}
      />
      <LinkBase value={session?.cwd ?? ""}>
        <KeyboardAwareScrollView
          ref={scroll}
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          bottomOffset={16}
        >
          {sides.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {sides.map((entry, index) => {
                const picked = entry.sideId === current?.sideId;
                return (
                  <Pressable
                    key={entry.sideId}
                    onPress={() => { haptics.selection(); setSideId(entry.sideId); }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: picked }}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: picked ? colors.accentSoft : colors.fill }}
                  >
                    <Text numberOfLines={1} style={[type.footnote, { color: picked ? colors.accent : colors.label, fontWeight: "600", maxWidth: 160 }]}>
                      {entry.messages[0]?.text ?? `旁支 ${index + 1}`}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
          {!current ? (
            <Text style={[type.subhead, { color: colors.secondaryLabel }]}>
              问一个关于这个会话的问题，不打断正在进行的一轮。{howItAnswers(session?.agent ?? "", look.name)}
            </Text>
          ) : (
            current.messages.map((message, index) => (
              <SideMessageView key={message.id} message={message} answering={current.running && index === current.messages.length - 1} />
            ))
          )}
          <View style={{ gap: 10 }}>
            <TextInput
              accessibilityLabel="旁支问题"
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={20_000}
              editable={online}
              placeholder={current ? "接着问…" : `问 ${look.name}…`}
              placeholderTextColor={colors.placeholder as string}
              style={[type.body, { minHeight: 80, maxHeight: 200, padding: 14, borderRadius: 16, backgroundColor: colors.sheetCard, color: colors.label, textAlignVertical: "top" }]}
            />
            {current?.running ? (
              <Button title="停止回答" onPress={() => void actions.cancelSide(id, current.sideId).catch(() => {})} />
            ) : (
              <Button variant="primary" title={busy ? "正在提问…" : current ? "接着问" : "提问"} onPress={() => void ask()} disabled={!online || busy || !draft.trim()} />
            )}
            {!online ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>电脑离线，连上后才能提问。</Text> : null}
          </View>
        </KeyboardAwareScrollView>
      </LinkBase>
    </>
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
    <View style={{ gap: 6 }}>
      {message.activity?.length ? (
        <View style={{ gap: 2 }}>
          {message.activity.map((line, index) => (
            <Text key={index} numberOfLines={1} style={[type.footnote, { color: colors.tertiaryLabel }]}>· {line}</Text>
          ))}
        </View>
      ) : null}
      {message.text ? <Markdown text={message.text} streaming={answering} /> : null}
      {answering && !message.text ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={colors.secondaryLabel} />
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>正在回答…</Text>
        </View>
      ) : null}
      {message.error ? <Text style={[type.footnote, { color: message.error === "已停止" ? colors.secondaryLabel : colors.danger }]}>{message.error}</Text> : null}
    </View>
  );
}
