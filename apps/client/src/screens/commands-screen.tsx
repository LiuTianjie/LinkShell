import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/icon";
import { useClient } from "@/lib/client";
import { pickCommand } from "@/lib/command-pick";
import { commandDetail, matchCommands, type Command } from "@/lib/commands";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

const NONE: Command[] = [];

/**
 * The agent's slash commands, searchable: the common ones first (compact,
 * context, usage…), then skills and the rest. Picking one puts it in the
 * composer, ready for its arguments.
 */
export function CommandsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const commands = useClient((state) => state.views[id]?.commands) ?? NONE;
  const [query, setQuery] = useState("");
  const shown = useMemo(() => matchCommands(commands, query), [commands, query]);

  const pick = (command: Command) => {
    haptics.selection();
    pickCommand(id, command.name);
    router.back();
  };

  return (
    <View style={{ flex: 1 }}>
      {Platform.OS === "android" ? (
        <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginTop: 10, backgroundColor: colors.separator }} />
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: Platform.OS === "android" ? 12 : 22, paddingBottom: 12 }}>
        <Text style={[type.title, { flex: 1, color: colors.label }]}>命令</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="关闭"
          hitSlop={10}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="xmark" md="close" size={13} color={colors.secondaryLabel} weight="bold" />
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            height: 40,
            paddingHorizontal: 12,
            borderRadius: 12,
            borderCurve: "continuous",
            backgroundColor: colors.fill,
          }}
        >
          <Icon sf="magnifyingglass" md="search" size={15} color={colors.secondaryLabel} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索命令"
            placeholderTextColor={colors.placeholder as string}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={[type.body, { flex: 1, fontSize: 16, color: colors.label, paddingVertical: 0 }]}
          />
        </View>
      </View>
      {/* Wrapped: a sheet stretches a scroll view that's a direct child of the screen over the whole sheet. */}
      <View style={{ flex: 1, overflow: "hidden" }}>
        <ScrollView
          contentInsetAdjustmentBehavior="never"
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}
        >
          {shown.length === 0 ? (
            <Text style={[type.subhead, { color: colors.tertiaryLabel, textAlign: "center", marginTop: 28 }]}>
              {commands.length === 0 ? "这个 Agent 还没有报告可用的命令" : `没有找到「${query.trim()}」`}
            </Text>
          ) : (
            <View style={{ backgroundColor: colors.sheetCard, borderRadius: 18, borderCurve: "continuous", overflow: "hidden" }}>
              {shown.map((command, index) => {
                const detail = commandDetail(command);
                return (
                  <Pressable
                    key={command.name}
                    onPress={() => pick(command)}
                    accessibilityRole="button"
                    accessibilityLabel={`/${command.name}${detail ? `，${detail}` : ""}`}
                    style={({ pressed }) => ({
                      minHeight: 46,
                      justifyContent: "center",
                      gap: 1,
                      paddingHorizontal: 14,
                      paddingVertical: 9,
                      backgroundColor: pressed ? colors.fill : undefined,
                      borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: colors.separator,
                    })}
                  >
                    <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 14.5, lineHeight: 20, color: colors.label, fontWeight: "600" }}>
                      /{command.name}
                      {command.hint ? <Text style={{ color: colors.tertiaryLabel, fontWeight: "400" }}> {command.hint}</Text> : null}
                    </Text>
                    {detail ? (
                      <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>
                        {detail}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
