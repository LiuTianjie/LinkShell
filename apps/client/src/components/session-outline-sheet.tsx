import type { TimelineItem } from "@linkshell/client-core";
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { extractSessionOutline, type OutlineCategory, type SessionOutlineEntry } from "@/lib/coding-ux";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { Text, TextInput } from "./fixed-text";
import { Icon, type IconProps } from "./icon";

export interface SessionOutlineSheetProps {
  visible: boolean;
  items: readonly TimelineItem[];
  onClose: () => void;
  onSelectIndex: (timelineIndex: number) => void;
}

const CATEGORY_META: Record<SessionOutlineEntry["category"], { icon: Pick<IconProps, "sf" | "md">; tint: "accent" | "waiting" | "danger" | "secondary" }> = {
  prompts: { icon: { sf: "person.fill", md: "person" }, tint: "accent" },
  agent: { icon: { sf: "sparkles", md: "auto_awesome" }, tint: "secondary" },
  approvals: { icon: { sf: "checkmark.shield.fill", md: "verified_user" }, tint: "waiting" },
  errors: { icon: { sf: "exclamationmark.triangle.fill", md: "error" }, tint: "danger" },
};

export function SessionOutlineSheet({ visible, items, onClose, onSelectIndex }: SessionOutlineSheetProps) {
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<OutlineCategory>("all");
  const [query, setQuery] = useState("");

  const entries = useMemo(() => extractSessionOutline(items, filter, query), [items, filter, query]);

  const filters: { key: OutlineCategory; label: string }[] = [
    { key: "all", label: t("session.outlineAll") },
    { key: "prompts", label: t("session.outlinePrompts") },
    { key: "approvals", label: t("session.outlineApprovals") },
    { key: "errors", label: t("session.outlineErrors") },
  ];

  const tintColor = (tint: "accent" | "waiting" | "danger" | "secondary") => {
    if (tint === "accent") return colors.accent;
    if (tint === "waiting") return colors.waiting;
    if (tint === "danger") return colors.danger;
    return colors.secondaryLabel;
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.sheet, paddingTop: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingBottom: 12 }}>
          <Text style={[type.title3, { color: colors.label }]}>{t("session.outline")}</Text>
          <Pressable
            onPress={() => {
              haptics.selection();
              onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            hitSlop={8}
            style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
          >
            <Icon sf="xmark" md="close" size={14} color={colors.secondaryLabel} weight="bold" />
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 10 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              minHeight: 40,
              borderRadius: radius.control,
              borderCurve: "continuous",
              backgroundColor: colors.fill,
            }}
          >
            <Icon sf="magnifyingglass" md="search" size={16} color={colors.secondaryLabel} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t("session.searchPlaceholder")}
              placeholderTextColor={colors.placeholder as string}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              style={[type.subhead, { flex: 1, color: colors.label, paddingVertical: 8 }]}
            />
          </View>

          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {filters.map((tab) => {
              const selected = filter === tab.key;
              return (
                <Pressable
                  key={tab.key}
                  onPress={() => {
                    haptics.selection();
                    setFilter(tab.key);
                  }}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: selected ? colors.accentFill : colors.fill,
                  }}
                >
                  <Text style={[type.footnote, { color: selected ? colors.onAccent : colors.label, fontWeight: "600" }]}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 20) + 12, gap: 8 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 48, gap: 8 }}>
              <Icon sf="doc.text.magnifyingglass" md="manage_search" size={30} color={colors.tertiaryLabel} />
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{t("session.noMatches")}</Text>
            </View>
          }
          renderItem={({ item }) => {
            const meta = CATEGORY_META[item.category];
            return (
              <Pressable
                onPress={() => {
                  haptics.selection();
                  onSelectIndex(item.timelineIndex);
                  onClose();
                }}
                accessibilityRole="button"
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  borderRadius: radius.card,
                  borderCurve: "continuous",
                  backgroundColor: pressed ? colors.fill : colors.sheetCard,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.separator,
                })}
              >
                <Icon {...meta.icon} size={16} color={tintColor(meta.tint)} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={2} style={[type.subhead, { color: colors.label, fontWeight: item.category === "prompts" ? "600" : "400" }]}>
                    {item.title}
                  </Text>
                  {item.subtitle ? (
                    <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                      {item.subtitle}
                    </Text>
                  ) : null}
                </View>
                <Icon sf="arrow.turn.down.right" md="subdirectory_arrow_right" size={14} color={colors.tertiaryLabel} />
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}
