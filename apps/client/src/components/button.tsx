import { ActivityIndicator, View, type ColorValue, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "@/components/fixed-text";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon, type IconProps } from "./icon";
import { PressableFeedback } from "./pressable-feedback";

type Variant = "primary" | "tonal" | "plain" | "destructive" | "warning";
type Size = "small" | "medium" | "large";

function fills(): Record<Variant, { background: ColorValue; foreground: ColorValue }> {
  return {
    primary: { background: colors.accentFill, foreground: colors.onAccent },
    tonal: { background: colors.fill, foreground: colors.label },
    plain: { background: "transparent", foreground: colors.accent },
    destructive: { background: colors.dangerSoft, foreground: colors.danger },
    warning: { background: colors.waitingFill, foreground: colors.onAccent },
  };
}

const sizes: Record<Size, { height: number; paddingHorizontal: number; font: typeof type.subhead; icon: number }> = {
  small: { height: 32, paddingHorizontal: 12, font: type.footnote, icon: 13 },
  medium: { height: 40, paddingHorizontal: 16, font: type.subhead, icon: 15 },
  large: { height: 50, paddingHorizontal: 20, font: type.headline, icon: 17 },
};

export function Button({
  title,
  onPress,
  variant = "tonal",
  size = "medium",
  icon,
  busy = false,
  disabled = false,
  wide = false,
  style,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  icon?: Pick<IconProps, "sf" | "md">;
  busy?: boolean;
  disabled?: boolean;
  wide?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const fill = fills()[variant];
  const metrics = sizes[size];
  const inactive = disabled || busy;
  const height = Math.max(44, metrics.height);
  return (
    <PressableFeedback
      feedback="button"
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: inactive, busy }}
      hitSlop={size === "small" ? 6 : 0}
      // Sharing a row equally is the pressable's own layout; what is inside fills it.
      outerStyle={{ maxWidth: "100%", flexShrink: 1, ...(wide ? { flex: 1 } : {}) }}
      style={style}
    >
      <View
        style={{
          minHeight: height,
          paddingHorizontal: metrics.paddingHorizontal,
          paddingVertical: size === "small" ? 6 : size === "large" ? 12 : 8,
          // A capsule, as on iOS 26; a title that wraps keeps the same ends.
          borderRadius: height / 2,
          borderCurve: "continuous",
          backgroundColor: fill.background,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          opacity: disabled ? 0.45 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator size="small" color={fill.foreground} />
        ) : icon ? (
          <Icon {...icon} size={metrics.icon} color={fill.foreground} weight="semibold" />
        ) : null}
        <Text style={[metrics.font, { flexShrink: 1, color: fill.foreground, fontWeight: "600", textAlign: "center" }]}>
          {title}
        </Text>
      </View>
    </PressableFeedback>
  );
}
