import type { MenuAction } from "@react-native-menu/menu";
import type { QueueEntry } from "@linkshell/client-core";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import type { queuedSendAction } from "@/lib/queued-send-action";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { AppMenu } from "./app-menu";
import { Glass } from "./glass";
import { Icon } from "./icon";

/** Every row is this tall (two lines of text fit), so the panel is exactly as tall as the rows it shows. */
const ROW = 46;
/** Rows in view at once; a longer queue scrolls inside the panel, which stays this tall. */
const SHOWN = 3;

export interface QueuePanelProps {
  /** What waits, and at the end what is still on its way to the queue (`pending`). */
  queue: QueueEntry[];
  /** Offline, or the composer can't take a message: the rows only show. */
  disabled?: boolean;
  contained?: boolean;
  sendAction: ReturnType<typeof queuedSendAction>;
  status: string;
  onSendNow: (clientMessageId: string) => Promise<void>;
  /** Takes the message back into the composer. */
  onEdit: (clientMessageId: string) => void;
  onRemove: (clientMessageId: string) => void;
  /** All the queue's ids, in the new order. */
  onReorder: (clientMessageIds: string[]) => void;
}

function Row({
  entry,
  index,
  count,
  first,
  disabled,
  sendAction,
  onSendNow,
  onEdit,
  onRemove,
  onMove,
}: {
  entry: QueueEntry;
  index: number;
  count: number;
  first: boolean;
  disabled: boolean;
  sendAction: QueuePanelProps["sendAction"];
  onSendNow: () => Promise<void>;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const [sending, setSending] = useState(false);
  const images = entry.images ? `${entry.images} 张图片` : "";
  const actions: MenuAction[] = [
    { id: "now", title: sendAction.label, subtitle: sendAction.detail, image: "arrow.up.circle", attributes: { disabled: sending } },
    { id: "edit", title: "编辑", image: "pencil" },
    { id: "up", title: "上移", image: "arrow.up", attributes: { disabled: index === 0 } },
    { id: "down", title: "下移", image: "arrow.down", attributes: { disabled: index === count - 1 } },
    { id: "remove", title: "删除", image: "trash", attributes: { destructive: true } },
  ];
  const sendNow = () => {
    if (sending) return;
    haptics.light();
    setSending(true);
    void onSendNow().finally(() => setSending(false));
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        height: ROW,
        paddingLeft: 12,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: colors.separator,
      }}
    >
      <Text style={[type.caption, { width: 16, color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{index + 1}</Text>
      <Pressable
        disabled={disabled || entry.pending}
        onPress={() => { haptics.selection(); onEdit(); }}
        accessibilityRole="button"
        accessibilityLabel={`编辑待发送消息：${entry.text || images}`}
        accessibilityState={{ disabled: disabled || !!entry.pending }}
        style={{ flex: 1, minHeight: 44, justifyContent: "center", paddingRight: 6 }}
      >
        <Text numberOfLines={2} style={[type.footnote, { color: entry.text && !entry.pending ? colors.label : colors.secondaryLabel }]}>
          {entry.text || images}
          {entry.text && images ? <Text style={{ color: colors.secondaryLabel }}> · {images}</Text> : null}
        </Text>
      </Pressable>
      {entry.pending ? (
        // Not in the queue yet: nothing can be done with it until the computer has it.
        <View accessibilityLabel="正在排队" style={{ width: 36, height: 40, marginRight: 8, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="small" color={colors.secondaryLabel} style={{ transform: [{ scale: 0.7 }] }} />
        </View>
      ) : disabled ? null : (
        <>
          <Pressable
            onPress={sendNow}
            accessibilityRole="button"
            disabled={sending}
            accessibilityLabel={sendAction.label}
            accessibilityHint={sendAction.detail}
            accessibilityState={{ disabled: sending, busy: sending }}
            hitSlop={4}
            style={{ minWidth: 54, height: 44, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ minHeight: 28, paddingHorizontal: 9, borderRadius: 14, backgroundColor: sendAction.interrupts ? colors.waitingSoft : colors.accentSoft, alignItems: "center", justifyContent: "center" }}>
              {sending ? (
                <ActivityIndicator size="small" color={sendAction.interrupts ? colors.waiting : colors.accent} style={{ transform: [{ scale: 0.7 }] }} />
              ) : (
                <Text style={[type.caption, { fontWeight: "600", color: sendAction.interrupts ? colors.waiting : colors.accent }]}>{sendAction.label}</Text>
              )}
            </View>
          </Pressable>
          <AppMenu
            actions={actions}
            shouldOpenOnLongPress={false}
            onPressAction={({ nativeEvent }) => {
              const id = nativeEvent.event;
              if (id === "now") sendNow();
              else if (id === "edit") onEdit();
              else if (id === "up") onMove(-1);
              else if (id === "down") onMove(1);
              else if (id === "remove") onRemove();
            }}
          >
            <View accessibilityRole="button" accessibilityLabel="更多" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Icon sf="ellipsis" md="more_horiz" size={16} color={colors.secondaryLabel} />
            </View>
          </AppMenu>
        </>
      )}
    </View>
  );
}

/**
 * Messages waiting for the running turn to end, above the composer: each can
 * go now, come back to be edited, move up or down, or be dropped. The queue
 * lives on the computer, so every device looking at the session sees it.
 */
export function QueuePanel({ queue, disabled = false, contained = false, sendAction, status, onSendNow, onEdit, onRemove, onReorder }: QueuePanelProps) {
  const move = (index: number, by: -1 | 1) => {
    // (Only what the computer holds has an order to change.)
    const ids = queue.filter((entry) => !entry.pending).map((entry) => entry.clientMessageId);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    haptics.selection();
    onReorder(ids);
  };

  const held = queue.filter((entry) => !entry.pending).length;

  return (
    <Glass style={{ borderRadius: 22, paddingHorizontal: 4, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 }}>
        <Text style={[type.caption, { color: colors.secondaryLabel, fontWeight: "600" }]}>待发送 · {queue.length}</Text>
        <Text style={[type.caption, { color: colors.secondaryLabel }]}>{status}</Text>
      </View>
      <QueueBody contained={contained} count={queue.length}>
        {queue.map((entry, index) => (
          <Row
            key={entry.clientMessageId}
            entry={entry}
            index={index}
            count={held}
            first={index === 0}
            disabled={disabled}
            sendAction={sendAction}
            onSendNow={() => onSendNow(entry.clientMessageId)}
            onEdit={() => onEdit(entry.clientMessageId)}
            onRemove={() => {
              haptics.selection();
              onRemove(entry.clientMessageId);
            }}
            onMove={(by) => move(index, by)}
          />
        ))}
      </QueueBody>
    </Glass>
  );
}

function QueueBody({ children, contained, count }: { children: ReactNode; contained: boolean; count: number }) {
  if (contained) return <View accessibilityLabel={`排队中的消息，${count} 条`}>{children}</View>;
  return <ScrollView style={{ maxHeight: ROW * SHOWN }} scrollEnabled={count > SHOWN} nestedScrollEnabled bounces={false} snapToInterval={ROW} decelerationRate="fast" keyboardShouldPersistTaps="handled" accessibilityLabel={`排队中的消息，${count} 条`}>{children}</ScrollView>;
}
