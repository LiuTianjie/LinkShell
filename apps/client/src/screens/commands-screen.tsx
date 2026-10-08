import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { SheetHeader } from "@/components/sheet-header";
import { Icon } from "@/components/icon";
import { useSessionCommands } from "@/lib/use-session-commands";
import { useComposerDraft } from "@/lib/use-composer-draft";
import { useActions, useClient, useSessionSubscription } from "@/lib/client";
import { commandDetail, matchCommands, type Command } from "@/lib/commands";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

/**
 * The agent's slash commands, searchable: the common ones first (compact,
 * context, usage…), then skills and the rest. Picking one puts it in the
 * composer, ready for its arguments.
 */
export function CommandsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useSessionSubscription(id);
  const insets = usePageInsets();
  const { commands } = useSessionCommands(id);
  const { setText } = useComposerDraft(id);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const actions = useActions();
  const online = useClient((state) => state.status === "online");
  const shown = useMemo(() => matchCommands(commands, query), [commands, query]);

  const pick = (command: Command) => {
    haptics.selection();
    if (command.action === "goal") { router.replace({ pathname: "/session/[id]/goal", params: { id } }); return; }
    if (command.action === "settings") { router.replace({ pathname: "/session/[id]/settings", params: { id, option: command.optionId } }); return; }
    if (command.action === "commands") { setQuery(""); return; }
    // The composer can unmount in adaptive layouts; write its persistent draft
    // instead of depending on a live event listener behind this sheet.
    setText(`/${command.name} `);
    router.back();
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title="命令" actions={commands.some((command) => command.name === "reload-skills") ? [{ key: "refresh", label: "刷新命令", icon: { sf: "arrow.clockwise", md: "refresh" }, disabled: !online || refreshing, onPress: () => {
        setRefreshing(true);
        void actions.send(id, [{ type: "text", text: "/reload-skills" }], { now: true }).then((delivery) => {
          if (delivery === "failed") Alert.alert("刷新失败", "请在会话中查看原因后重试");
        }).finally(() => setRefreshing(false));
      } }] : []} />
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
            paddingHorizontal: 12,
            borderRadius: 12,
            borderCurve: "continuous",
            backgroundColor: colors.fill,
          }}
        >
          <Icon sf="magnifyingglass" md="search" size={15} color={colors.secondaryLabel} />
          <TextInput
            accessibilityLabel="搜索命令"
            value={query}
            onChangeText={setQuery}
            placeholder="搜索命令"
            placeholderTextColor={colors.placeholder as string}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={[type.body, { flex: 1, fontSize: 16, color: colors.label, minHeight: 44, paddingVertical: 8 }]}
          />
        </View>
      </View>
      {/* Wrapped: a sheet stretches a scroll view that's a direct child of the screen over the whole sheet. */}
      <View style={{ flex: 1, overflow: "hidden" }}>
        <ScrollView
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustKeyboardInsets
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
