import * as Clipboard from "expo-clipboard";
import { Pressable, ScrollView, Text, View } from "react-native";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono } from "@/theme/type";
import { Icon, type IconProps } from "../icon";

// The keys a phone keyboard lacks, above it: Esc, Tab, a sticky Ctrl, arrows
// and the punctuation shells lean on.

type Key =
  | { label: string; send: string; wide?: boolean }
  | { icon: Pick<IconProps, "sf" | "md">; send: string; label: string };

const KEYS: Key[] = [
  // Its own key: with a Chinese/Japanese keyboard, ctrl + c would go to the input method.
  { label: "^C", send: "\x03", wide: true },
  { label: "esc", send: "\x1b", wide: true },
  { label: "tab", send: "\t", wide: true },
  { icon: { sf: "arrow.up", md: "arrow_upward" }, send: "\x1b[A", label: "上" },
  { icon: { sf: "arrow.down", md: "arrow_downward" }, send: "\x1b[B", label: "下" },
  { icon: { sf: "arrow.left", md: "arrow_back" }, send: "\x1b[D", label: "左" },
  { icon: { sf: "arrow.right", md: "arrow_forward" }, send: "\x1b[C", label: "右" },
  { label: "/", send: "/" },
  { label: "-", send: "-" },
  { label: "|", send: "|" },
  { label: "~", send: "~" },
  { label: "`", send: "`" },
];

function KeyCap({ children, onPress, active = false, label }: { children: React.ReactNode; onPress: () => void; active?: boolean; label: string }) {
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        minWidth: 38,
        height: 34,
        paddingHorizontal: 10,
        borderRadius: 9,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? colors.accent : pressed ? colors.fillStrong : colors.fill,
      })}
    >
      {children}
    </Pressable>
  );
}

export function KeyBar({
  ctrl,
  onToggleCtrl,
  onKey,
  onHideKeyboard,
}: {
  ctrl: boolean;
  onToggleCtrl: () => void;
  onKey: (data: string) => void;
  onHideKeyboard: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ gap: 6, paddingHorizontal: 8, alignItems: "center" }}
        style={{ flex: 1 }}
      >
        <KeyCap label="Ctrl" active={ctrl} onPress={onToggleCtrl}>
          <Text style={{ fontFamily: mono, fontSize: 14, fontWeight: "600", color: ctrl ? colors.onAccent : colors.label }}>ctrl</Text>
        </KeyCap>
        {KEYS.map((key) => (
          <KeyCap key={key.label} label={key.label} onPress={() => onKey(key.send)}>
            {"icon" in key ? (
              <Icon {...key.icon} size={14} color={colors.label} weight="semibold" />
            ) : (
              <Text style={{ fontFamily: mono, fontSize: 15, fontWeight: "500", color: colors.label }}>{key.label}</Text>
            )}
          </KeyCap>
        ))}
        <KeyCap
          label="粘贴"
          onPress={() => {
            void Clipboard.getStringAsync().then((text) => {
              if (text) onKey(text);
            });
          }}
        >
          <Icon sf="doc.on.clipboard" md="content_paste" size={14} color={colors.label} />
        </KeyCap>
      </ScrollView>
      <View style={{ width: 0.5, height: 22, backgroundColor: colors.separator }} />
      <Pressable
        onPress={onHideKeyboard}
        accessibilityRole="button"
        accessibilityLabel="收起键盘"
        hitSlop={6}
        style={{ width: 46, height: 34, alignItems: "center", justifyContent: "center" }}
      >
        <Icon sf="keyboard.chevron.compact.down" md="keyboard_hide" size={18} color={colors.secondaryLabel} />
      </Pressable>
    </View>
  );
}

/** Ctrl+<key> as the control character a terminal expects (Ctrl+C → \x03). */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  if (data === " ") return "\x00";
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code & 0x1f) : data;
}
