import type { AgentInboxMessage } from "@linkshell/client-core";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { Markdown } from "@/components/markdown";
import { useClient } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { useTimelineSession } from "./context";

export function AgentInbox({ message }: { message: AgentInboxMessage }) {
  const [expanded, setExpanded] = useState(false);
  const sessionId = useTimelineSession();
  const agents = useClient((state) => sessionId ? state.subagents[sessionId] : undefined);
  const matches = agents?.filter((agent) => agent.name === message.sender) ?? [];
  const call = matches.length === 1 ? matches[0]!.toolCallId : undefined;
  const label = message.notice === "idle" ? `@${message.sender} · 本轮已结束` : `来自 @${message.sender}`;
  const tint = message.color === "green" ? colors.ok : message.color === "red" ? colors.danger
    : message.color === "yellow" || message.color === "orange" ? colors.waiting : colors.accent;
  return (
    <View style={{ backgroundColor: colors.inset, borderRadius: 16, borderCurve: "continuous", padding: 14, gap: 10 }}>
      <Pressable
        onPress={() => { haptics.selection(); setExpanded((value) => !value); }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${label}${message.summary ? `：${message.summary}` : ""}`}
        style={{ gap: 8, minHeight: 44, justifyContent: "center" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon sf="bubble.left.fill" md="chat_bubble" size={14} color={tint} />
          <Text style={[type.footnote, { flex: 1, color: colors.secondaryLabel, fontWeight: "600" }]}>{label}</Text>
          <Icon sf={expanded ? "chevron.up" : "chevron.down"} md={expanded ? "expand_less" : "expand_more"} size={12} color={colors.tertiaryLabel} />
        </View>
        {message.summary ? <Text numberOfLines={expanded ? undefined : 3} style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>{message.summary}</Text> : null}
      </Pressable>
      {expanded && message.body ? <Markdown text={message.body} /> : <Text numberOfLines={3} style={[type.subhead, { color: colors.secondaryLabel }]}>{message.body || "当前空闲，等待后续任务。"}</Text>}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        {message.body ? <Pressable onPress={() => { haptics.selection(); setExpanded((value) => !value); }} accessibilityRole="button" accessibilityState={{ expanded }} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>{expanded ? "收起" : "展开全文"}</Text>
        </Pressable> : null}
        {sessionId && call ? <Pressable
          onPress={() => router.push({ pathname: "/session/[id]/agent/[call]", params: { id: sessionId, call } })}
          accessibilityRole="button" accessibilityLabel={`查看 @${message.sender} 的过程`} style={{ minHeight: 44, justifyContent: "center" }}
        ><Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>查看过程</Text></Pressable> : null}
      </View>
    </View>
  );
}
