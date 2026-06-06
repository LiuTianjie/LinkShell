import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";

import { AppSymbol } from "../../../components/AppSymbol";
import type { Theme } from "../../../theme";
import type { AgentNotice, AgentTimelineItem } from "../types";
import { agentEventBorder, agentEventSurface } from "../lib/format";
import { agentRailColor, noticeAccent, type AgentRailTone } from "../lib/timeline";
import { MessageContent, UserMessageContent } from "./content";

async function copy(value: string): Promise<boolean> {
  try {
    Clipboard.setString(value);
    const copied = typeof Clipboard.getString === "function" ? await Clipboard.getString() : value;
    Haptics.selectionAsync().catch(() => {});
    return copied === value || copied.length > 0;
  } catch {
    return false;
  }
}

export const TimelineSeparator = () => <View style={{ height: 12 }} />;

export function StreamingPill({ theme }: { theme: Theme }) {
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        borderRadius: 999,
        backgroundColor: theme.accentLight,
        paddingHorizontal: 9,
        paddingVertical: 5,
      }}
    >
      <ActivityIndicator size="small" color={theme.accent} />
      <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "800" }}>正在生成</Text>
    </View>
  );
}

export function NoticeStrip({
  notices,
  theme,
  onDismiss,
}: {
  notices: AgentNotice[];
  theme: Theme;
  onDismiss: (id: string) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <View style={{ gap: 6, paddingBottom: 6 }}>
      {notices.map((notice) => {
        const accent = noticeAccent(notice.kind, theme);
        return (
          <Pressable
            key={notice.id}
            onPress={() => onDismiss(notice.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 12,
              borderCurve: "continuous",
              backgroundColor: accent.bg,
            }}
          >
            <AppSymbol name={accent.icon} size={13} color={accent.color} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: accent.color, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
                {notice.title}
              </Text>
              {notice.detail ? (
                <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 1 }} numberOfLines={2}>
                  {notice.detail}
                </Text>
              ) : null}
            </View>
            <AppSymbol name="xmark" size={11} color={theme.textTertiary} />
          </Pressable>
        );
      })}
    </View>
  );
}

export function AssistantMessage({
  item,
  text,
  theme,
}: {
  item: AgentTimelineItem;
  text: string;
  theme: Theme;
}) {
  const [copied, setCopied] = useState(false);
  const hasBody = Boolean(text || item.content?.length);
  const copyText = (text || (item.content ?? [])
    .map((block) => block.type === "text" ? block.text ?? "" : "")
    .filter(Boolean)
    .join("\n"))
    .trim();
  const canCopy = copyText.length > 0;
  const copyAssistantMessage = useCallback(() => {
    if (!canCopy) return;
    copy(copyText).then((ok) => {
      if (!ok) {
        Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
        return;
      }
      Haptics.selectionAsync().catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {
      Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
    });
  }, [canCopy, copyText]);

  return (
    <View style={{ gap: 7, paddingVertical: 3 }}>
      {hasBody ? (
        <View
          style={{
            borderRadius: 10,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: agentEventBorder(theme),
            backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.045)",
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <MessageContent blocks={item.content} fallbackText={text} theme={theme} monospace={false} />
        </View>
      ) : null}
      {item.isStreaming ? <StreamingPill theme={theme} /> : null}
      {canCopy ? (
        <Pressable
          onPress={copyAssistantMessage}
          hitSlop={8}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            borderRadius: 999,
            paddingHorizontal: 8,
            paddingVertical: 4,
            backgroundColor: pressed ? theme.bgInput : "transparent",
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <AppSymbol name={copied ? "checkmark" : "doc.on.doc"} size={12} color={copied ? theme.success : theme.textTertiary} />
          <Text style={{ color: copied ? theme.success : theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
            {copied ? "已复制" : "复制回复"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function AgentTimelineBlock({
  children,
  theme,
  tone = "default",
}: {
  children: React.ReactNode;
  theme: Theme;
  tone?: AgentRailTone;
}) {
  const railColor = agentRailColor(tone, theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "stretch", gap: 9 }}>
      <View style={{ width: 28, alignItems: "center" }}>
        <View style={{ width: StyleSheet.hairlineWidth, height: 8, backgroundColor: theme.separator }} />
        <View
          style={{
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: railColor,
            opacity: tone === "default" ? 0.55 : 1,
          }}
        />
        <View style={{ width: StyleSheet.hairlineWidth, flex: 1, minHeight: 8, backgroundColor: theme.separator }} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {children}
      </View>
    </View>
  );
}

export function SystemMessageCard({ text, theme }: { text: string; theme: Theme }) {
  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        paddingHorizontal: 10,
        paddingVertical: 9,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: theme.bgInput }}>
        <AppSymbol name="info.circle" size={13} color={theme.textTertiary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "900" }}>
          系统
        </Text>
        <Text selectable style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
          {text}
        </Text>
      </View>
    </View>
  );
}

export function UserMessageCard({
  item,
  text,
  theme,
  deliveryLabel,
  onEdit,
}: {
  item: AgentTimelineItem;
  text: string;
  theme: Theme;
  deliveryLabel: { text: string; pending: boolean } | null;
  onEdit?: (text: string) => void;
}) {
  const isSteer = item.metadata?.delivery === "steer";
  const canEdit = Boolean(onEdit) && text.trim().length > 0 && !item.isStreaming;
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "82%", gap: 4, alignItems: "flex-end" }}>
    <View
      style={{
        maxWidth: "100%",
        minWidth: text.length < 10 ? 108 : undefined,
        borderRadius: 13,
        borderCurve: "continuous",
        backgroundColor: theme.mode === "light" ? "#ffffff" : "rgba(255,255,255,0.08)",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: isSteer
          ? theme.mode === "light" ? "rgba(58,95,200,0.22)" : "rgba(173,198,255,0.24)"
          : theme.mode === "light"
            ? "rgba(60,60,67,0.12)"
            : "rgba(255,255,255,0.10)",
        paddingVertical: 9,
        paddingHorizontal: 12,
        gap: 5,
      }}
    >
      {text || item.content?.length ? (
        <UserMessageContent blocks={item.content} fallbackText={text} theme={theme} />
      ) : item.isStreaming ? (
        <StreamingPill theme={theme} />
      ) : null}
      {deliveryLabel ? (
        <View
          style={{
            alignSelf: "flex-end",
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingTop: 1,
          }}
        >
          {deliveryLabel.pending ? <ActivityIndicator size="small" color={theme.textTertiary} /> : null}
          {isSteer ? <AppSymbol name="arrow.up" size={10} color={theme.accent} /> : null}
          <Text style={{ color: isSteer ? theme.accent : theme.textTertiary, fontSize: 10, fontWeight: "800" }}>
            {isSteer ? "已引导" : deliveryLabel.text}
          </Text>
        </View>
      ) : null}
    </View>
      {canEdit ? (
        <Pressable
          onPress={() => onEdit!(text)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="编辑并重新发送"
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            borderRadius: 999,
            paddingHorizontal: 8,
            paddingVertical: 3,
            backgroundColor: pressed ? theme.bgInput : "transparent",
            opacity: pressed ? 0.72 : 1,
          })}
        >
          <AppSymbol name="pencil" size={11} color={theme.textTertiary} />
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>编辑</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ErrorCard({ text, theme }: { text: string; theme: Theme }) {
  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: theme.errorLight,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.error,
        padding: 12,
        flexDirection: "row",
        gap: 9,
        alignItems: "flex-start",
      }}
    >
      <AppSymbol name="exclamationmark.triangle.fill" size={16} color={theme.error} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: theme.error, fontSize: 13, fontWeight: "900" }}>
          Agent 出错了
        </Text>
        <Text selectable style={{ color: theme.error, fontSize: 13, lineHeight: 18 }}>
          {text}
        </Text>
      </View>
    </View>
  );
}

export function AgentConversationSkeleton({ theme }: { theme: Theme }) {
  const rows = [0, 1, 2, 3];
  return (
    <View style={{ paddingVertical: 18, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "center", paddingVertical: 6 }}>
        <ActivityIndicator size="small" color={theme.accent} />
        <Text style={{ color: theme.textTertiary, fontSize: 13, fontWeight: "800" }}>正在获取消息…</Text>
      </View>
      {rows.map((row) => {
        const isUser = row === 1;
        return (
          <View
            key={row}
            style={{
              alignSelf: isUser ? "flex-end" : "stretch",
              width: isUser ? "62%" : "100%",
              borderRadius: 10,
              borderCurve: "continuous",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.mode === "light" ? "rgba(60,60,67,0.08)" : "rgba(255,255,255,0.07)",
              backgroundColor: theme.mode === "light" ? "rgba(255,255,255,0.68)" : "rgba(255,255,255,0.045)",
              paddingHorizontal: 12,
              paddingVertical: 12,
              gap: 8,
            }}
          >
            <View style={{ width: isUser ? "74%" : "92%", height: 10, borderRadius: 5, backgroundColor: theme.bgInput }} />
            <View style={{ width: isUser ? "48%" : "78%", height: 10, borderRadius: 5, backgroundColor: theme.bgInput }} />
            {!isUser ? (
              <View style={{ width: "56%", height: 10, borderRadius: 5, backgroundColor: theme.bgInput }} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
