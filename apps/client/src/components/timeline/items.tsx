import type { TimelineItem } from "@linkshell/client-core";
import * as Clipboard from "expo-clipboard";
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { cubicBezier } from "react-native-reanimated";
import { duration } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { Markdown } from "../markdown";
import { Attachments, LinkChip } from "./attachments";
import { useTimelineFork } from "./context";
import { userMessageText } from "@/lib/user-message";

type Of<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

const EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);

const LONG_MESSAGE_LINES = 8;

export const UserMessage = memo(function UserMessage({
  item,
  onFailedPress,
}: {
  item: Of<"user">;
  onFailedPress?: (item: Of<"user">) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = userMessageText(item.blocks);
  const images = item.blocks.filter((block) => block.type === "image");
  const links = item.blocks.filter((block) => block.type === "resource_link");
  // A slash command or skill the user ran: `/review src`, `/pdf`.
  const command = /^\/[\w:.-]+/.exec(text);
  const long = text.length > 900 || text.split("\n").length > LONG_MESSAGE_LINES;
  return (
    <View style={{ alignItems: "flex-end", gap: 4 }}>
      {images.length ? <Attachments blocks={images} align="end" thumb={116} /> : null}
      {text || links.length ? (
        <Pressable
          disabled={!item.failed && !long}
          onPress={() => {
            if (item.failed) onFailedPress?.(item);
            else {
              haptics.selection();
              setExpanded((value) => !value);
            }
          }}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "86%" }}
        >
          {item.failed ? <Icon sf="exclamationmark.circle.fill" md="error" size={20} color={colors.danger} /> : null}
          <View
            style={{
              flexShrink: 1,
              backgroundColor: colors.userBubble,
              borderRadius: 22,
              borderBottomRightRadius: 8,
              borderCurve: "continuous",
              paddingHorizontal: 14,
              paddingVertical: 9,
              opacity: item.pending && !item.accepted ? 0.65 : 1,
              gap: 6,
            }}
          >
            {links.map((link, index) => (link.type === "resource_link" ? <LinkChip key={index} block={link} onBubble /> : null))}
            {text ? (
              <Text selectable={!long || expanded} numberOfLines={long && !expanded ? LONG_MESSAGE_LINES : undefined} style={[type.chat, { color: colors.label }]}>
                {command ? (
                  <Text style={{ fontWeight: "700" }}>{command[0]}</Text>
                ) : null}
                {command ? text.slice(command[0].length) : text}
              </Text>
            ) : null}
            {long ? (
              <Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>{expanded ? "收起" : "展开全部"}</Text>
            ) : null}
          </View>
        </Pressable>
      ) : null}
      {item.failed ? (
        <Text style={[type.caption, { color: colors.danger }]}>发送失败 · 轻点重试</Text>
      ) : item.pending && !item.accepted ? (
        <Text style={[type.caption, { color: colors.tertiaryLabel }]}>发送中…</Text>
      ) : null}
    </View>
  );
});

export const AgentMessage = memo(function AgentMessage({ item, last = false }: { item: Of<"agent">; last?: boolean }) {
  const hasText = item.text.trim().length > 0;
  if (!hasText && !item.attachments?.length) return null;
  return (
    <View style={{ gap: 8 }}>
      {hasText ? <Markdown text={item.text} streaming={item.streaming} /> : null}
      {item.attachments?.length ? <Attachments blocks={item.attachments} /> : null}
      {last && hasText && !item.streaming ? <ReplyActions item={item} /> : null}
    </View>
  );
});

/** Under the reply that ends a turn: copy it, or fork the session from here. */
function ReplyActions({ item }: { item: Of<"agent"> }) {
  const fork = useTimelineFork();
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginLeft: -7, marginTop: -4 }}>
      <Pressable
        onPress={() => {
          void Clipboard.setStringAsync(item.text.trim());
          haptics.success();
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        accessibilityRole="button"
        accessibilityLabel="复制这条回复"
        hitSlop={4}
        style={({ pressed }) => ({ width: 32, height: 30, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
      >
        <Icon sf={copied ? "checkmark" : "doc.on.doc"} md={copied ? "check" : "content_copy"} size={14} color={copied ? colors.ok : colors.tertiaryLabel} />
      </Pressable>
      {fork ? (
        <Pressable
          onPress={() => {
            haptics.selection();
            fork(item.id);
          }}
          accessibilityRole="button"
          accessibilityLabel="从这里分叉"
          hitSlop={4}
          style={({ pressed }) => ({ width: 32, height: 30, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
        >
          <Icon sf="arrow.triangle.branch" md="fork_right" size={14} color={colors.tertiaryLabel} />
        </Pressable>
      ) : null}
    </View>
  );
}

export const Thought = memo(function Thought({ item }: { item: Of<"thought"> }) {
  const [open, setOpen] = useState(false);
  const label = item.streaming
    ? "思考中…"
    : item.endedTs
      ? `思考了 ${duration(item.endedTs - item.ts)}`
      : "思考过程";
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={() => {
          haptics.selection();
          setOpen((value) => !value);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: 28 }}
      >
        {/* One glyph: a spinner while it thinks, the sparkle once it's done. */}
        {item.streaming ? (
          <ActivityIndicator size="small" color={colors.tertiaryLabel} style={{ transform: [{ scale: 0.75 }], width: 13, height: 13 }} />
        ) : (
          <Icon sf="sparkles" md="auto_awesome" size={13} color={colors.tertiaryLabel} />
        )}
        <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{label}</Text>
        {item.streaming ? null : (
          <Animated.View
            style={{
              transform: [{ rotate: open ? "90deg" : "0deg" }],
              transitionProperty: "transform",
              transitionDuration: "180ms",
              transitionTimingFunction: EASE_OUT,
            }}
          >
            <Icon sf="chevron.right" md="chevron_right" size={10} color={colors.tertiaryLabel} weight="semibold" />
          </Animated.View>
        )}
      </Pressable>
      {open ? (
        <View style={{ borderLeftWidth: 2, borderLeftColor: colors.separator, paddingLeft: 12, marginLeft: 5 }}>
          <Markdown text={item.text.trim()} variant="thought" />
        </View>
      ) : null}
    </View>
  );
});

export const PlanCard = memo(function PlanCard({ item, active }: { item: Of<"plan">; active: boolean }) {
  const done = item.entries.filter((entry) => entry.status === "completed").length;
  const total = item.entries.length;
  return (
    <View style={{ backgroundColor: colors.inset, borderRadius: 18, borderCurve: "continuous", padding: 14, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon sf="checklist" md="checklist" size={15} color={colors.accent} />
        <Text style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>计划</Text>
        <Text style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
          {done}/{total}
        </Text>
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.fill, overflow: "hidden" }}>
        <View
          style={{
            width: `${total ? (done / total) * 100 : 0}%`,
            height: 4,
            borderRadius: 2,
            backgroundColor: done === total ? colors.ok : colors.accent,
          }}
        />
      </View>
      <View style={{ gap: 7 }}>
        {item.entries.map((entry, index) => {
          const complete = entry.status === "completed";
          const current = entry.status === "in_progress";
          return (
            <View key={index} style={{ flexDirection: "row", gap: 9, alignItems: "flex-start" }}>
              <View style={{ width: 18, height: 20, alignItems: "center", justifyContent: "center" }}>
                {complete ? (
                  <Icon sf="checkmark.circle.fill" md="check_circle" size={16} color={colors.ok} />
                ) : current && active ? (
                  <ActivityIndicator size="small" color={colors.accent} style={{ transform: [{ scale: 0.75 }] }} />
                ) : (
                  <Icon sf="circle" md="radio_button_unchecked" size={16} color={current ? colors.accent : colors.tertiaryLabel} />
                )}
              </View>
              <Text
                style={[
                  type.subhead,
                  {
                    flex: 1,
                    color: complete ? colors.secondaryLabel : colors.label,
                    fontWeight: current ? "600" : "400",
                    textDecorationLine: complete ? "line-through" : "none",
                  },
                ]}
              >
                {entry.content}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
});

/**
 * A marker in the conversation (compacted, stopped, handed over): a hairline
 * with the words in its middle, so it reads as punctuation, not as another bubble.
 */
function CenterPill({ icon, text, tone }: { icon: React.ReactNode; text: string; tone?: "warn" | "danger" }) {
  const rule = <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {rule}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "80%" }}>
        {icon}
        <Text
          selectable
          style={[
            type.footnote,
            { color: tone === "warn" ? colors.waiting : tone === "danger" ? colors.danger : colors.secondaryLabel, flexShrink: 1, textAlign: "center" },
          ]}
        >
          {text}
        </Text>
      </View>
      {rule}
    </View>
  );
}

export const Notice = memo(function Notice({ item }: { item: Of<"notice"> }) {
  return (
    <CenterPill
      tone={item.level === "warning" ? "warn" : undefined}
      icon={
        <Icon
          sf={item.level === "warning" ? "exclamationmark.triangle.fill" : "info.circle"}
          md={item.level === "warning" ? "warning" : "info"}
          size={13}
          color={item.level === "warning" ? colors.waiting : colors.secondaryLabel}
        />
      }
      text={item.detail ? `${item.title} · ${item.detail}` : item.title}
    />
  );
});

export const ErrorCard = memo(function ErrorCard({ item }: { item: Of<"error"> }) {
  return (
    <View style={{ backgroundColor: colors.dangerSoft, borderRadius: 18, borderCurve: "continuous", padding: 14, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon sf="exclamationmark.octagon.fill" md="report" size={16} color={colors.danger} />
        <Text style={[type.subhead, { color: colors.danger, fontWeight: "600" }]}>出错了</Text>
      </View>
      <Text selectable style={[type.subhead, { color: colors.label }]}>
        {item.message}
      </Text>
      {item.hint ? (
        <Text selectable style={[type.footnote, { color: colors.secondaryLabel }]}>
          {item.hint}
        </Text>
      ) : null}
    </View>
  );
});

const stopCopy: Partial<Record<Of<"turn-end">["stopReason"], string>> = {
  cancelled: "已停止",
  error: "这一轮出错结束",
  max_tokens: "达到输出上限，回复被截断",
  refusal: "Agent 拒绝了这个请求",
};

export const TurnEnd = memo(function TurnEnd({ item }: { item: Of<"turn-end"> }) {
  const text = stopCopy[item.stopReason];
  if (!text) return null;
  return (
    <CenterPill
      tone={item.stopReason === "cancelled" ? undefined : "warn"}
      icon={<Icon sf="stop.circle" md="stop_circle" size={13} color={item.stopReason === "cancelled" ? colors.secondaryLabel : colors.waiting} />}
      text={text}
    />
  );
});

export const DriverChange = memo(function DriverChange({ item }: { item: Of<"driver"> }) {
  const copy =
    item.driver === "remote"
      ? { sf: "iphone" as const, md: "smartphone" as const, text: "手机接管了会话" }
      : item.driver === "desktop"
        ? { sf: "laptopcomputer" as const, md: "laptop_mac" as const, text: "回到电脑上继续" }
        : { sf: "pause.circle" as const, md: "pause_circle" as const, text: "电脑终端已退出 · 可以在这里继续" };
  return <CenterPill icon={<Icon sf={copy.sf} md={copy.md} size={13} color={colors.secondaryLabel} />} text={copy.text} />;
});

export const PermissionResult = memo(function PermissionResult({ item }: { item: Of<"permission-result"> }) {
  if (item.asked) {
    // Questions the agent asked: what was answered to each, or that they were skipped.
    return (
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 26 }}>
          <Icon sf="questionmark.bubble.fill" md="help" size={14} color={item.answers ? colors.accent : colors.tertiaryLabel} />
          <Text numberOfLines={2} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
            {item.answers ? "已回答" : `没有回答 · ${item.title}`}
          </Text>
        </View>
        {item.answers?.map((entry) => (
          <Text key={entry.question} style={[type.footnote, { color: colors.secondaryLabel, paddingLeft: 22 }]}>
            {entry.question}：<Text style={{ color: colors.label }}>{entry.answer}</Text>
          </Text>
        ))}
      </View>
    );
  }
  const allowed = item.allowed !== false;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 26 }}>
      <Icon
        sf={allowed ? "checkmark.shield.fill" : "xmark.shield.fill"}
        md={allowed ? "verified_user" : "gpp_bad"}
        size={14}
        color={allowed ? colors.ok : colors.danger}
      />
      <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
        {allowed ? "已允许" : "已拒绝"} · {item.title}
      </Text>
    </View>
  );
});

export function TimeSeparator({ label }: { label: string }) {
  return (
    <Text style={[type.caption, { color: colors.tertiaryLabel, textAlign: "center", fontWeight: "500" }]}>{label}</Text>
  );
}
