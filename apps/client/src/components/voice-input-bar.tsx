import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Text } from "@/components/fixed-text";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Icon } from "./icon";

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

export interface VoiceInputBarProps {
  elapsedSeconds: number;
  levels: number[];
  canceling?: boolean;
  processing?: boolean;
  hasText: boolean;
  onCancel: () => void;
  onFinish: () => void;
  onSendNow?: () => void;
  /** Optional quick demo phrases when testing on Simulator without a physical mic. */
  onInjectPhrase?: (phrase: string) => void;
}

const QUICK_VOICE_PHRASES = [
  "帮我检查一下当前改动的测试有没有通过",
  "重构刚才这个函数，保持类型安全",
  "总结一下目前完成了哪些工作",
];

/**
 * Replaces only the bottom toolbar row inside Composer while keeping the
 * TextInput mounted above it, avoiding keyboard flicker or layout jumps.
 */
export function VoiceInputBar({
  elapsedSeconds,
  levels,
  canceling = false,
  processing = false,
  hasText,
  onCancel,
  onFinish,
  onSendNow,
  onInjectPhrase,
}: VoiceInputBarProps) {
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      style={{ gap: 6, paddingTop: 2 }}
    >
      {__DEV__ && onInjectPhrase ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 4 }}>
          {QUICK_VOICE_PHRASES.map((phrase) => (
            <Pressable
              key={phrase}
              accessibilityRole="button"
              accessibilityLabel={`模拟语音：${phrase}`}
              onPress={() => onInjectPhrase(phrase)}
              style={({ pressed }) => ({
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 12,
                backgroundColor: pressed ? colors.fillStrong : colors.fill,
              })}
            >
              <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                🎙️ “{phrase.slice(0, 12)}…”
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 44,
          paddingHorizontal: 4,
        }}
      >
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="取消语音输入"
          hitSlop={6}
          style={({ pressed }) => ({
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: canceling ? colors.danger : pressed ? colors.fillStrong : colors.fill,
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <Icon sf="xmark" md="close" size={19} color={canceling ? "#ffffff" : colors.secondaryLabel} weight="bold" />
        </Pressable>

        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            height: 38,
            paddingHorizontal: 12,
            borderRadius: 19,
            backgroundColor: canceling ? colors.dangerSoft : colors.accentSoft,
          }}
        >
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 3.5,
              backgroundColor: canceling ? colors.danger : colors.accent,
            }}
          />
          <Text
            style={{
              fontFamily: mono,
              fontSize: 12,
              fontWeight: "600",
              color: canceling ? colors.danger : colors.accent,
              fontVariant: ["tabular-nums"],
              minWidth: 32,
            }}
          >
            {formatDuration(elapsedSeconds)}
          </Text>

          {processing ? (
            <Text accessibilityLiveRegion="polite" style={[type.caption, { flex: 1, color: colors.secondaryLabel, textAlign: "center" }]}>正在处理语音…</Text>
          ) : canceling ? (
            <Text numberOfLines={1} style={[type.caption, { flex: 1, color: colors.danger, fontWeight: "600", textAlign: "center" }]}>
              松开手指取消录音
            </Text>
          ) : (
            <View
              accessibilityLabel="正在聆听语音波形"
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                height: 24,
                gap: 2,
              }}
            >
              {levels.map((level, index) => {
                const barHeight = Math.max(4, Math.round(level * 22));
                return (
                  <View
                    key={index}
                    style={{
                      width: 3,
                      height: barHeight,
                      borderRadius: 1.5,
                      backgroundColor: colors.accent,
                      opacity: 0.45 + level * 0.55,
                    }}
                  />
                );
              })}
            </View>
          )}
        </View>

        <Pressable
          onPress={onFinish}
          disabled={processing}
          accessibilityRole="button"
          accessibilityLabel="完成语音转写"
          hitSlop={6}
          style={({ pressed }) => ({
            minHeight: 38,
            opacity: processing ? 0.5 : 1,
            paddingHorizontal: 12,
            borderRadius: 19,
            backgroundColor: pressed ? colors.fillStrong : colors.fill,
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <Text style={[type.footnote, { color: colors.label, fontWeight: "600" }]}>完成</Text>
        </Pressable>

        {onSendNow ? (
          <Pressable
            onPress={onSendNow}
            disabled={!hasText || processing}
            accessibilityRole="button"
            accessibilityLabel="结束录音并发送"
            hitSlop={6}
            style={({ pressed }) => ({
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: hasText ? colors.accentFill : colors.fillStrong,
              alignItems: "center",
              justifyContent: "center",
              transform: [{ scale: pressed ? 0.94 : 1 }],
            })}
          >
            <Icon sf="arrow.up" md="arrow_upward" size={21} color={hasText ? colors.onAccent : colors.tertiaryLabel} weight="bold" />
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}
