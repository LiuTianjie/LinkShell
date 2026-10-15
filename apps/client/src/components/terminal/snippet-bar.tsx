import type { TerminalKeyModifiers } from "../../../modules/link-terminal/src";
import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import {
  addTerminalSnippet,
  removeTerminalSnippet,
  resetTerminalSnippets,
  useTerminalSnippets,
  type TerminalSnippet,
} from "@/lib/terminal-snippets";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Button } from "../button";
import { Icon } from "../icon";

export interface SnippetBarProps {
  onSendInput: (data: string) => void;
  onPaste: (text: string) => void;
  onKey: (name: string, modifiers?: TerminalKeyModifiers) => void;
  onCaptureOutput?: () => void;
}

export function SnippetBar({ onSendInput, onPaste, onCaptureOutput }: SnippetBarProps) {
  const snippets = useTerminalSnippets();
  const [adding, setAdding] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftCommand, setDraftCommand] = useState("");

  const runSnippet = (snippet: TerminalSnippet) => {
    haptics.selection();
    if (snippet.autoEnter !== false) {
      onSendInput(`${snippet.command}\r`);
    } else {
      onPaste(snippet.command);
    }
  };

  const openSnippetOptions = (snippet: TerminalSnippet) => {
    haptics.medium();
    Alert.alert(snippet.label, snippet.command, [
      {
        text: "仅粘贴到命令行（不回车）",
        onPress: () => onPaste(snippet.command),
      },
      {
        text: "立即执行",
        onPress: () => onSendInput(`${snippet.command}\r`),
      },
      {
        text: "删除此快捷指令",
        style: "destructive",
        onPress: () => removeTerminalSnippet(snippet.id),
      },
      { text: "取消", style: "cancel" },
    ]);
  };

  const promptAddSnippet = () => {
    haptics.selection();
    setDraftLabel("");
    setDraftCommand("");
    setAdding(true);
  };

  const confirmAddSnippet = () => {
    const command = draftCommand.trim();
    if (!command) return;
    haptics.success();
    addTerminalSnippet({
      label: draftLabel.trim() || command.slice(0, 18),
      command,
      autoEnter: true,
    });
    setAdding(false);
  };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingTop: 6,
        paddingBottom: 5,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.separator,
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ gap: 6, paddingHorizontal: 8, alignItems: "center" }}
        style={{ flex: 1 }}
      >
        {onCaptureOutput ? (
          <Pressable
            onPress={() => {
              haptics.selection();
              onCaptureOutput();
            }}
            accessibilityRole="button"
            accessibilityLabel="抓取终端输出发给 AI"
            style={({ pressed }) => ({
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 14,
              borderCurve: "continuous",
              backgroundColor: pressed ? colors.fillStrong : colors.accentSoft,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              transform: [{ scale: pressed ? 0.96 : 1 }],
            })}
          >
            <Icon sf="sparkles" md="auto_awesome" size={11} color={colors.accent} />
            <Text style={[type.caption, { color: colors.accent, fontWeight: "600" }]}>发给 AI</Text>
          </Pressable>
        ) : null}

        {snippets.map((snippet) => (
          <Pressable
            key={snippet.id}
            onPress={() => runSnippet(snippet)}
            onLongPress={() => openSnippetOptions(snippet)}
            accessibilityRole="button"
            accessibilityLabel={`快捷指令 ${snippet.label}`}
            accessibilityHint="点击发送，长按管理或仅粘贴"
            style={({ pressed }) => ({
              height: 28,
              paddingHorizontal: 10,
              borderRadius: 14,
              borderCurve: "continuous",
              backgroundColor: pressed ? colors.fillStrong : colors.fill,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              transform: [{ scale: pressed ? 0.96 : 1 }],
            })}
          >
            <Text style={{ fontFamily: mono, fontSize: 12, fontWeight: "500", color: colors.label }}>
              {snippet.label}
            </Text>
          </Pressable>
        ))}

        <Pressable
          onPress={promptAddSnippet}
          accessibilityRole="button"
          accessibilityLabel="添加快捷指令"
          style={({ pressed }) => ({
            width: 28,
            height: 28,
            borderRadius: 14,
            borderCurve: "continuous",
            backgroundColor: pressed ? colors.fillStrong : colors.fill,
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <Icon sf="plus" md="add" size={12} color={colors.secondaryLabel} weight="bold" />
        </Pressable>
      </ScrollView>

      <Modal visible={adding} transparent animationType="fade" onRequestClose={() => setAdding(false)}>
        <Pressable
          onPress={() => setAdding(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.45)",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 360,
              backgroundColor: colors.cardRaised,
              borderRadius: 22,
              borderCurve: "continuous",
              padding: 18,
              gap: 12,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={[type.headline, { color: colors.label }]}>添加快捷指令</Text>
              <Pressable
                onPress={() => {
                  Alert.alert("恢复默认指令？", "自定义的快捷指令将被重置为默认列表。", [
                    { text: "取消", style: "cancel" },
                    {
                      text: "重置",
                      style: "destructive",
                      onPress: () => {
                        resetTerminalSnippets();
                        setAdding(false);
                      },
                    },
                  ]);
                }}
                hitSlop={8}
              >
                <Text style={[type.footnote, { color: colors.secondaryLabel }]}>恢复默认</Text>
              </Pressable>
            </View>
            <TextInput
              value={draftLabel}
              onChangeText={setDraftLabel}
              placeholder="按钮名称（可选，如：日志）"
              placeholderTextColor={colors.placeholder as string}
              style={[
                type.subhead,
                {
                  color: colors.label,
                  backgroundColor: colors.fill,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                },
              ]}
            />
            <TextInput
              value={draftCommand}
              onChangeText={setDraftCommand}
              placeholder="终端命令（如：git log --oneline -n 10）"
              placeholderTextColor={colors.placeholder as string}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                fontFamily: mono,
                fontSize: 13,
                color: colors.label,
                backgroundColor: colors.fill,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
              }}
            />
            <Text style={[type.caption, { color: colors.tertiaryLabel }]}>
              点击按钮直接执行；长按任意按钮可选择仅粘贴或删除。
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <Button title="取消" variant="tonal" size="small" onPress={() => setAdding(false)} />
              <Button title="保存" variant="primary" size="small" disabled={!draftCommand.trim()} onPress={confirmAddSnippet} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
