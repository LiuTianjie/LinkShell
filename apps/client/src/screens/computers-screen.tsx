import { router } from "expo-router";
import { useRef } from "react";
import { Pressable, ScrollView, useColorScheme, View } from "react-native";
import { usePageInsets } from "@/components/adaptive-page";
import { ComputerList } from "@/components/computer-list";
import { Text } from "@/components/fixed-text";
import { Glass } from "@/components/glass";
import { Icon } from "@/components/icon";
import { haptics } from "@/lib/haptics";
import { sheetBottom } from "@/lib/sheet-bottom";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function ComputersScreen() {
  const insets = usePageInsets();
  const dark = useColorScheme() === "dark";
  const leaving = useRef(false);
  const leave = (action: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    haptics.selection();
    action();
  };

  return (
    // Native form sheets size their scroll view to the sheet. Keep the custom
    // heading in that same flow so the first row cannot slide underneath it.
    <ScrollView style={{ flex: 1 }} onAccessibilityEscape={() => leave(() => router.back())} contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: sheetBottom(insets.bottom) }}>
      <View collapsable={false}>
        <View collapsable={false} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, backgroundColor: colors.sheet }}>
          <Text accessibilityRole="header" style={{ flex: 1, fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.6, color: colors.label }}>电脑</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="添加电脑" onPress={() => leave(() => router.replace("/pair"))} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Glass interactive tint={dark ? "rgba(120,120,128,0.28)" : "rgba(120,120,128,0.12)"} style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
              <Icon sf="plus" md="add" size={23} color={colors.label} weight="regular" />
            </Glass>
          </Pressable>
        </View>
        <View style={{ paddingHorizontal: 20 }}>
          <ComputerList onSelect={() => leave(() => router.back())} />
          <Pressable accessibilityRole="button" onPress={() => leave(() => router.replace("/account"))} style={({ pressed }) => ({ minHeight: 44, marginTop: 4, paddingHorizontal: 4, flexDirection: "row", alignItems: "center", gap: 8, opacity: pressed ? 0.6 : 1 })}>
            <Text style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>管理电脑与账号</Text>
            <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} />
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
