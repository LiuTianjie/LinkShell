import type { TerminalKeyModifiers } from "../../../modules/link-terminal/src";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import { swipeKeySteps } from "@/lib/terminal-snippets";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Icon, type IconProps } from "../icon";

type Key =
  | { id: string; label: string; send: string; modifiers?: TerminalKeyModifiers; arrow?: boolean }
  | { id: string; icon: Pick<IconProps, "sf" | "md">; send: string; label: string; modifiers?: TerminalKeyModifiers; arrow?: boolean };

const KEYS: Key[] = [
  { id: "ctrl-c", label: "^C", send: "c", modifiers: { ctrl: true } },
  { id: "esc", label: "esc", send: "escape" },
  { id: "tab", label: "tab", send: "tab" },
  { id: "left", icon: { sf: "arrow.left", md: "arrow_back" }, send: "left", label: "左", arrow: true },
  { id: "down", icon: { sf: "arrow.down", md: "arrow_downward" }, send: "down", label: "下", arrow: true },
  { id: "up", icon: { sf: "arrow.up", md: "arrow_upward" }, send: "up", label: "上", arrow: true },
  { id: "right", icon: { sf: "arrow.right", md: "arrow_forward" }, send: "right", label: "右", arrow: true },
  { id: "shift-enter", label: "⇧↵", send: "enter", modifiers: { shift: true } },
  { id: "slash", label: "/", send: "/" },
  { id: "dash", label: "-", send: "-" },
  { id: "pipe", label: "|", send: "|" },
  { id: "tilde", label: "~", send: "~" },
  { id: "pgup", label: "PgUp", send: "pageUp" },
  { id: "pgdn", label: "PgDn", send: "pageDown" },
];

function KeyPill({
  children,
  onPress,
  active = false,
  label,
}: {
  children: React.ReactNode;
  onPress: () => void;
  active?: boolean;
  label: string;
}) {
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
        minWidth: 36,
        height: 34,
        paddingHorizontal: 10,
        borderRadius: 11,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? colors.accent : pressed ? colors.fillStrong : colors.fill,
        transform: [{ scale: pressed ? 0.95 : 1 }],
      })}
    >
      {children}
    </Pressable>
  );
}

function ActionCircle({
  icon,
  label,
  active = false,
  onPress,
}: {
  icon: Pick<IconProps, "sf" | "md">;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        borderRadius: 17,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? colors.accentSoft : pressed ? colors.fillStrong : colors.fill,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      <Icon {...icon} size={14} color={active ? colors.accent : colors.label} weight="medium" />
    </Pressable>
  );
}

export function KeyBar({
  ctrl,
  alt = false,
  cmd = false,
  showCmd = true,
  keyboardOpen = false,
  snippetsOpen = false,
  onToggleCtrl,
  onToggleAlt,
  onToggleCmd,
  onToggleSnippets,
  onVoice,
  onKey,
  onHideKeyboard,
  onPaste,
  onImage,
}: {
  ctrl: boolean;
  alt?: boolean;
  cmd?: boolean;
  showCmd?: boolean;
  keyboardOpen?: boolean;
  snippetsOpen?: boolean;
  onToggleCtrl: () => void;
  onToggleAlt?: () => void;
  onToggleCmd?: () => void;
  onToggleSnippets?: () => void;
  onVoice?: () => void;
  onKey: (key: string, modifiers?: TerminalKeyModifiers) => void;
  onPaste: () => void;
  onImage: () => void;
  onHideKeyboard: () => void;
}) {
  const touchOrigin = useRef<{ x: number; y: number; stepsX: number; stepsY: number } | null>(null);
  const [scrubHint, setScrubHint] = useState<string | null>(null);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 6 }}>
      {onToggleSnippets ? (
        <ActionCircle
          icon={{ sf: "bolt.fill", md: "bolt" }}
          label="快捷指令栏"
          active={snippetsOpen}
          onPress={onToggleSnippets}
        />
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ gap: 5, alignItems: "center", paddingRight: 4 }}
        style={{ flex: 1 }}
      >
        <KeyPill label="Ctrl" active={ctrl} onPress={onToggleCtrl}>
          <Text style={{ fontFamily: mono, fontSize: 12.5, fontWeight: "600", color: ctrl ? colors.onAccent : colors.label }}>
            ctrl
          </Text>
        </KeyPill>
        {showCmd && onToggleCmd ? (
          <KeyPill label="Command" active={cmd} onPress={onToggleCmd}>
            <Text style={{ fontFamily: mono, fontSize: 13, fontWeight: "600", color: cmd ? colors.onAccent : colors.label }}>
              ⌘
            </Text>
          </KeyPill>
        ) : null}
        {onToggleAlt ? (
          <KeyPill label="Alt / Option" active={alt} onPress={onToggleAlt}>
            <Text style={{ fontFamily: mono, fontSize: 12.5, fontWeight: "600", color: alt ? colors.onAccent : colors.label }}>
              alt
            </Text>
          </KeyPill>
        ) : null}

        {/* Arrow cluster also supports continuous horizontal/vertical trackpad scrubbing */}
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
          onTouchStart={(e) => {
            touchOrigin.current = {
              x: e.nativeEvent.pageX,
              y: e.nativeEvent.pageY,
              stepsX: 0,
              stepsY: 0,
            };
          }}
          onTouchMove={(e) => {
            const origin = touchOrigin.current;
            if (!origin) return;
            const dx = e.nativeEvent.pageX - origin.x;
            const dy = e.nativeEvent.pageY - origin.y;
            const nextStepsX = swipeKeySteps(dx, 14);
            const nextStepsY = swipeKeySteps(dy, 18);
            if (nextStepsX !== origin.stepsX) {
              const diff = nextStepsX - origin.stepsX;
              origin.stepsX = nextStepsX;
              const key = diff > 0 ? "right" : "left";
              for (let i = 0; i < Math.min(4, Math.abs(diff)); i++) onKey(key);
              haptics.selection();
              setScrubHint(diff > 0 ? "→" : "←");
            } else if (nextStepsY !== origin.stepsY) {
              const diff = nextStepsY - origin.stepsY;
              origin.stepsY = nextStepsY;
              const key = diff > 0 ? "down" : "up";
              for (let i = 0; i < Math.min(2, Math.abs(diff)); i++) onKey(key);
              haptics.selection();
              setScrubHint(diff > 0 ? "↓" : "↑");
            }
          }}
          onTouchEnd={() => {
            touchOrigin.current = null;
            setScrubHint(null);
          }}
          onTouchCancel={() => {
            touchOrigin.current = null;
            setScrubHint(null);
          }}
        >
          {KEYS.map((key) => (
            <KeyPill key={key.id} label={key.label} onPress={() => onKey(key.send, key.modifiers)}>
              {"icon" in key ? (
                <Icon {...key.icon} size={13} color={colors.label} weight="semibold" />
              ) : (
                <Text style={{ fontFamily: mono, fontSize: 13, fontWeight: "500", color: colors.label }}>{key.label}</Text>
              )}
            </KeyPill>
          ))}
        </View>
      </ScrollView>

      {scrubHint ? (
        <View
          pointerEvents="none"
          style={{
            paddingHorizontal: 7,
            height: 24,
            borderRadius: 12,
            backgroundColor: colors.accentSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={[type.caption, { color: colors.accent, fontWeight: "700" }]}>{scrubHint}</Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <ActionCircle icon={{ sf: "doc.on.clipboard", md: "content_paste" }} label="粘贴" onPress={onPaste} />
        {onVoice ? <ActionCircle icon={{ sf: "mic.fill", md: "mic" }} label="语音输入" onPress={onVoice} /> : null}
        {keyboardOpen ? (
          <ActionCircle
            icon={{ sf: "keyboard.chevron.compact.down", md: "keyboard_hide" }}
            label="收起键盘"
            onPress={onHideKeyboard}
          />
        ) : (
          <ActionCircle icon={{ sf: "photo.badge.plus", md: "add_photo_alternate" }} label="上传图片" onPress={onImage} />
        )}
      </View>
    </View>
  );
}
