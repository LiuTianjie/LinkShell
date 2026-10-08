import { forwardRef } from "react";
import { Text as NativeText, TextInput as NativeTextInput, type TextProps, type TextInputProps } from "react-native";

// Keep typography at the app's chosen point sizes while the surrounding layout resizes.
export type Text = NativeText;
export const Text = forwardRef<NativeText, TextProps>(function Text(props, ref) {
  return <NativeText {...props} ref={ref} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});

export type TextInput = NativeTextInput;
export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function TextInput(props, ref) {
  return <NativeTextInput {...props} ref={ref} allowFontScaling={false} maxFontSizeMultiplier={1} />;
});
