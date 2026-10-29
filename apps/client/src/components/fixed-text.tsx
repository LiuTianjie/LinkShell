import { forwardRef } from "react";
import { Platform, StyleSheet, Text as NativeText, TextInput as NativeTextInput, type TextProps, type TextInputProps } from "react-native";

// Keep typography at the app's chosen point sizes while the surrounding layout resizes.
export type Text = NativeText;
export const Text = forwardRef<NativeText, TextProps>(function Text(props, ref) {
  return <NativeText {...props} ref={ref} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});

export type TextInput = NativeTextInput;
export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function TextInput(props, ref) {
  // On iOS a line height on a one-line field spreads its placeholder's letters apart.
  const style = Platform.OS === "ios" && !props.multiline ? [props.style, { lineHeight: undefined }] : props.style;
  return <NativeTextInput {...props} style={StyleSheet.flatten(style)} ref={ref} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});
