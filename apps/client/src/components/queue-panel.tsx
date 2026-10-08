import type { MenuAction } from "@react-native-menu/menu";
import type { QueueEntry } from "@linkshell/client-core";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
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
  onSendNow: () => Promise<void>;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const [sending, setSending] = useState(false);
  const images = entry.images ? `${entry.images} 张图片` : "";
  const actions: MenuAction[] = [
    { id: "now", title: "立即发送", image: "arrow.up.circle" },
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
      <Text
        numberOfLines={2}
        style={[type.footnote, { flex: 1, paddingRight: 6, color: entry.text && !entry.pending ? colors.label : colors.secondaryLabel }]}
      >
        {entry.text || images}
        {entry.text && images ? <Text style={{ color: colors.secondaryLabel }}> · {images}</Text> : null}
      </Text>
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
            accessibilityLabel="立即发送"
            hitSlop={4}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }}>
              {sending ? (
                <ActivityIndicator size="small" color={colors.accent} style={{ transform: [{ scale: 0.7 }] }} />
              ) : (
                <Icon sf="arrow.up" md="arrow_upward" size={12} color={colors.accent} weight="bold" />
              )}
            </View>
          </Pressable>
          <Pressable
            onPress={() => {
              haptics.selection();
              onEdit();
            }}
            accessibilityRole="button"
            accessibilityLabel="编辑"
            hitSlop={4}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Icon sf="pencil" md="edit" size={15} color={colors.secondaryLabel} />
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
export function QueuePanel({ queue, disabled = false, contained = false, onSendNow, onEdit, onRemove, onReorder }: QueuePanelProps) {
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
      <QueueBody contained={contained} count={queue.length}>
        {queue.map((entry, index) => (
          <Row
            key={entry.clientMessageId}
            entry={entry}
            index={index}
            count={held}
            first={index === 0}
            disabled={disabled}
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
