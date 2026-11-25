import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text, TextInput } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

export interface TextPromptModalProps {
  visible: boolean;
  title: string;
  message?: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  validate?: (value: string) => string | null;
  onCancel: () => void;
  onConfirm: (value: string) => void | Promise<void>;
}

/**
 * Cross-platform (iOS & Android) modal text prompt matching the LinkShell card/control system.
 */
export function TextPromptModal({
  visible,
  title,
  message,
  initialValue,
  placeholder,
  confirmLabel = "确认",
  cancelLabel = "取消",
  busy = false,
  validate,
  onCancel,
  onConfirm,
}: TextPromptModalProps) {
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setValue(initialValue);
      setError(null);
    }
  }, [visible, initialValue]);

  const submit = () => {
    if (busy) return;
    if (validate) {
      const validationError = validate(value);
      if (validationError) {
        setError(validationError);
        haptics.error();
        return;
      }
    }
    haptics.selection();
    void onConfirm(value);
  };

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={["portrait", "portrait-upside-down", "landscape", "landscape-left", "landscape-right"]}
      animationType="fade"
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        behavior="padding"
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.45)",
          justifyContent: "center",
          paddingLeft: Math.max(24, insets.left + 16),
          paddingRight: Math.max(24, insets.right + 16),
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 12,
        }}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onCancel} />
        <View
          style={{
            backgroundColor: colors.cardRaised,
            borderRadius: radius.panel,
            borderCurve: "continuous",
            padding: 20,
            gap: 12,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.separator,
          }}
        >
          <View style={{ gap: 4 }}>
            <Text style={[type.headline, { color: colors.label }]}>{title}</Text>
            {message ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{message}</Text> : null}
          </View>

          <TextInput
            value={value}
            onChangeText={(next) => {
              setValue(next);
              if (error) setError(null);
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.placeholder as string}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={submit}
            editable={!busy}
            style={{
              backgroundColor: colors.fill,
              color: colors.label,
              borderRadius: radius.control,
              borderCurve: "continuous",
              paddingHorizontal: 14,
              paddingVertical: 11,
              fontSize: 16,
              borderWidth: error ? 1 : 0,
              borderColor: colors.danger,
            }}
          />

          {error ? <Text style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}

          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, paddingTop: 4 }}>
            <Pressable
              disabled={busy}
              onPress={onCancel}
              accessibilityRole="button"
              style={({ pressed }) => ({
                minHeight: 38,
                paddingHorizontal: 16,
                borderRadius: radius.control,
                borderCurve: "continuous",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.fill,
                opacity: busy ? 0.5 : pressed ? 0.7 : 1,
              })}
            >
              <Text style={[type.subhead, { color: colors.label, fontWeight: "500" }]}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={submit}
              accessibilityRole="button"
              style={({ pressed }) => ({
                minHeight: 38,
                paddingHorizontal: 18,
                borderRadius: radius.control,
                borderCurve: "continuous",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.accentFill,
                opacity: busy ? 0.6 : pressed ? 0.85 : 1,
              })}
            >
              <Text style={[type.subhead, { color: colors.onAccent, fontWeight: "600" }]}>
                {busy ? "处理中…" : confirmLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
