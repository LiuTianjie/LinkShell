import React, { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
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
  onFocusChange?: (focused: boolean) => void;
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
  { onSendText, onSpecialKey, disabled, onFocusChange },
  ref,
) {
  const { theme } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const isFocusedRef = useRef(false);
  const sentViaKeyPressRef = useRef(false);

  const focusInput = useCallback(() => {
    if (disabled || isFocusedRef.current) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      setTimeout(() => {
        if (!isFocusedRef.current) inputRef.current?.focus();
      }, 60);
    });
  }, [disabled]);

  useImperativeHandle(ref, () => ({
    focus: focusInput,
    blur: () => inputRef.current?.blur(),
  }), [focusInput]);

  // onKeyPress fires BEFORE onChangeText.
  // For ASCII keys (letters, digits, punctuation), send immediately here.
  // Mark as sent so onChangeText doesn't double-send.
  const handleKeyPress = useCallback(({ nativeEvent }: { nativeEvent: { key: string } }) => {
    if (disabled) return;
    sentViaKeyPressRef.current = false;

    if (nativeEvent.key === "Backspace") {
      onSpecialKey("\x7f");
      sentViaKeyPressRef.current = true;
      inputRef.current?.clear();
      return;
    }

    if (nativeEvent.key === "Enter") {
      onSpecialKey("\r");
      sentViaKeyPressRef.current = true;
      inputRef.current?.clear();
      return;
    }

    // Single ASCII character — send directly (covers letters, digits, punctuation)
    if (nativeEvent.key.length === 1) {
      const code = nativeEvent.key.charCodeAt(0);
      if (code >= 0x20 && code <= 0x7e) {
        onSendText(nativeEvent.key);
        sentViaKeyPressRef.current = true;
        // Clear on next tick to avoid race with onChangeText
        setTimeout(() => inputRef.current?.clear(), 0);
        return;
      }
    }
  }, [disabled, onSendText, onSpecialKey]);

  // onChangeText handles non-ASCII (CJK, emoji, etc.)
  // Skip if already sent via onKeyPress.
  const handleChangeText = useCallback((text: string) => {
    if (disabled) {
      inputRef.current?.clear();
      return;
    }

    if (sentViaKeyPressRef.current) {
      sentViaKeyPressRef.current = false;
      // Already sent via keyPress, just clear
      setTimeout(() => inputRef.current?.clear(), 0);
      return;
    }

    if (text && text.length > 0) {
      onSendText(text);
      setTimeout(() => inputRef.current?.clear(), 0);
    }
  }, [disabled, onSendText]);

  const handleSubmitEditing = useCallback(() => {
    if (disabled) return;
    onSpecialKey("\r");
    inputRef.current?.clear();
  }, [disabled, onSpecialKey]);

  const handleFocus = useCallback(() => {
    isFocusedRef.current = true;
    onFocusChange?.(true);
  }, [onFocusChange]);

  const handleBlur = useCallback(() => {
    isFocusedRef.current = false;
    onFocusChange?.(false);
  }, [onFocusChange]);

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
        autoComplete="off"
        blurOnSubmit={false}
        caretHidden={Platform.OS === "ios"}
        contextMenuHidden
        editable={!disabled}
        showSoftInputOnFocus
        inputAccessoryViewID={ACCESSORY_ID}
        keyboardType="default"
        keyboardAppearance={theme.mode === "dark" ? "dark" : "light"}
        onChangeText={handleChangeText}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyPress={handleKeyPress}
        onSubmitEditing={handleSubmitEditing}
        returnKeyType="default"
        enablesReturnKeyAutomatically={false}
        selectionColor="transparent"
        spellCheck={false}
        style={styles.hiddenInput}
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
    width: 16,
    height: 16,
    opacity: 0.02,
    left: 0,
    top: 0,
  },
});
