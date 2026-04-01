import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import {
  Pressable,
  Platform,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { KeyboardAccessory } from "./KeyboardAccessory";
import { useTheme } from "../theme";

interface InputBarProps {
  onSendText: (text: string) => void;
  onSpecialKey: (key: string) => void;
  disabled?: boolean;
}

export interface InputBarHandle {
  focus: () => void;
  blur: () => void;
}

const SPECIAL_KEYS = [
  { label: "Esc", value: "\x1b" },
  { label: "Tab", value: "\t" },
  { label: "Ctrl+C", value: "\x03" },
  { label: "Ctrl+D", value: "\x04" },
  { label: "Ctrl+L", value: "\x0c" },
  { label: "\u2191", value: "\x1b[A" },
  { label: "\u2193", value: "\x1b[B" },
  { label: "\u2192", value: "\x1b[C" },
  { label: "\u2190", value: "\x1b[D" },
];

const ACCESSORY_ID = "terminal-input-accessory";

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(
  { onSendText, onSpecialKey, disabled },
  ref,
) {
  const { theme } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const [buffer, setBuffer] = useState("");

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (!disabled) {
        inputRef.current?.focus();
      }
    },
    blur: () => {
      inputRef.current?.blur();
    },
  }), [disabled]);

  const handleChangeText = useCallback((text: string) => {
    if (disabled) {
      setBuffer("");
      return;
    }

    if (text.length > 0) {
      onSendText(text);
    }
    setBuffer("");
  }, [disabled, onSendText]);

  const handleKeyPress = useCallback(({ nativeEvent }: { nativeEvent: { key: string } }) => {
    if (disabled) {
      return;
    }

    if (nativeEvent.key === "Backspace") {
      onSpecialKey("\x7f");
      setBuffer("");
      return;
    }

    if (nativeEvent.key === "Enter") {
      onSpecialKey("\r");
      setBuffer("");
    }
  }, [disabled, onSpecialKey]);

  const handleSubmitEditing = useCallback(() => {
    if (disabled) {
      return;
    }

    onSpecialKey("\r");
    setBuffer("");
  }, [disabled, onSpecialKey]);

  const accessoryKeys = (
    <>
      {SPECIAL_KEYS.map((key) => (
        <Pressable
          key={key.label}
          style={({ pressed }) => [
            styles.accessoryKey,
            {
              backgroundColor: theme.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.72)",
              borderColor: theme.mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.82)",
            },
            pressed && { backgroundColor: theme.mode === "dark" ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.92)" },
          ]}
          onPress={() => onSpecialKey(key.value)}
          disabled={disabled}
        >
          <Text style={[styles.accessoryKeyLabel, { color: theme.text }]}>{key.label}</Text>
        </Pressable>
      ))}
    </>
  );

  return (
    <>
      <TextInput
        ref={inputRef}
        autoCapitalize="none"
        autoCorrect={false}
        blurOnSubmit={false}
        caretHidden={Platform.OS === "ios"}
        contextMenuHidden
        editable={!disabled}
        showSoftInputOnFocus
        inputAccessoryViewID={ACCESSORY_ID}
        keyboardAppearance={theme.mode === "dark" ? "dark" : "light"}
        onChangeText={handleChangeText}
        onKeyPress={handleKeyPress}
        onSubmitEditing={handleSubmitEditing}
        returnKeyType="default"
        enablesReturnKeyAutomatically={false}
        selectionColor="transparent"
        spellCheck={false}
        style={styles.hiddenInput}
        value={buffer}
      />
      <KeyboardAccessory nativeID={ACCESSORY_ID} title="终端快捷键">
        {accessoryKeys}
      </KeyboardAccessory>
    </>
  );
});

const styles = StyleSheet.create({
  accessoryKey: {
    minHeight: 34,
    minWidth: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },
  accessoryKeyLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  hiddenInput: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0.01,
    left: 0,
    top: 0,
  },
});
