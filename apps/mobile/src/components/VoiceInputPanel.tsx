import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { AppSymbol } from "./AppSymbol";
import { useVoiceInput } from "../hooks/useVoiceInput";
import type { Theme } from "../theme";

const VOICE_PANEL_HEIGHT = 180;
const LOCALES = ["en-US", "zh-CN"] as const;
const LOCALE_LABELS: Record<string, string> = {
  "en-US": "EN",
  "zh-CN": "中",
};

interface VoiceInputPanelProps {
  bottomInset: number;
  theme: Theme;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export { VOICE_PANEL_HEIGHT };

export function VoiceInputPanel({
  bottomInset,
  theme,
  onSend,
  onCancel,
}: VoiceInputPanelProps) {
  const { isListening, partialText, finalText, error, start, stop, cancel } =
    useVoiceInput();
  const [localeIndex, setLocaleIndex] = useState(0);
  const locale = LOCALES[localeIndex];
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Start listening on mount
  useEffect(() => {
    start(locale);
    return () => {
      cancel();
    };
  }, []);

  // Pulse animation while listening
  useEffect(() => {
    if (isListening) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.4,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isListening, pulseAnim]);

  const displayText = partialText || finalText;
  const sendableText = finalText || partialText;

  const handleSend = async () => {
    if (!sendableText) return;
    await stop();
    onSend(sendableText);
    // Restart for next input
    start(locale);
  };

  const handleCancel = async () => {
    await cancel();
    onCancel();
  };

  const handleLocaleToggle = async () => {
    const nextIndex = (localeIndex + 1) % LOCALES.length;
    setLocaleIndex(nextIndex);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await cancel();
    start(LOCALES[nextIndex]);
  };

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: bottomInset,
        height: VOICE_PANEL_HEIGHT,
        backgroundColor: theme.bgElevated,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.separator,
        paddingHorizontal: 16,
        paddingVertical: 10,
      }}
    >
      <View
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12 }}
      >
        {/* Pulse indicator */}
        <View
          style={{ alignItems: "center", justifyContent: "center", width: 40 }}
        >
          <Animated.View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: isListening ? theme.error : theme.textTertiary,
              opacity: 0.3,
              transform: [{ scale: pulseAnim }],
              position: "absolute",
            }}
          />
          <AppSymbol
            name={isListening ? "mic.fill" : "mic.slash.fill"}
            size={20}
            color={isListening ? theme.error : theme.textTertiary}
          />
        </View>

        {/* Text display */}
        <View style={{ flex: 1, minHeight: 160 }}>
          <Text
            style={{
              fontSize: 15,
              color: displayText ? theme.text : theme.textTertiary,
              fontFamily: "Menlo",
              lineHeight: 22,
            }}
            numberOfLines={3}
          >
            {displayText ||
              (error
                ? `Error: ${error}`
                : isListening
                  ? "正在听..."
                  : "准备中...")}
          </Text>
        </View>
      </View>

      {/* Bottom buttons */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingTop: 6,
        }}
      >
        {/* Locale toggle */}
        <Pressable
          style={({ pressed }) => ({
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
            borderCurve: "continuous",
            backgroundColor: pressed ? theme.bgCard : theme.bgTerminal,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.separator,
          })}
          onPress={handleLocaleToggle}
        >
          <Text
            style={{ fontSize: 12, fontWeight: "600", color: theme.accent }}
          >
            {LOCALE_LABELS[locale]}
          </Text>
        </Pressable>

        <View style={{ flex: 1 }} />

        {/* Cancel */}
        <Pressable
          style={({ pressed }) => ({
            paddingHorizontal: 14,
            paddingVertical: 6,
            borderRadius: 8,
            borderCurve: "continuous",
            backgroundColor: pressed ? theme.bgCard : theme.bgTerminal,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.separator,
          })}
          onPress={handleCancel}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: theme.textSecondary,
            }}
          >
            取消
          </Text>
        </Pressable>

        {/* Send */}
        <Pressable
          style={({ pressed }) => ({
            paddingHorizontal: 14,
            paddingVertical: 6,
            borderRadius: 8,
            borderCurve: "continuous",
            backgroundColor: sendableText
              ? pressed
                ? theme.accentLight
                : theme.accent
              : theme.bgCard,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: sendableText ? theme.accent : theme.separator,
          })}
          onPress={handleSend}
          disabled={!sendableText}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: sendableText ? theme.textInverse : theme.textTertiary,
            }}
          >
            发送
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
