import { ActivityIndicator, Text, View, type ColorValue, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon, type IconProps } from "./icon";
import { PressableScale } from "./pressable-scale";

type Variant = "primary" | "tonal" | "plain" | "destructive" | "warning";
type Size = "small" | "medium" | "large";

const fills: Record<Variant, { background: ColorValue; foreground: ColorValue }> = {
  primary: { background: colors.accent, foreground: colors.onAccent },
  tonal: { background: colors.fill, foreground: colors.label },
  plain: { background: "transparent", foreground: colors.accent },
  destructive: { background: colors.dangerSoft, foreground: colors.danger },
  warning: { background: colors.waiting, foreground: "#ffffff" },
};

const sizes: Record<Size, { height: number; paddingHorizontal: number; font: typeof type.subhead; icon: number; radius: number }> = {
  small: { height: 32, paddingHorizontal: 12, font: type.footnote, icon: 13, radius: 16 },
  medium: { height: 40, paddingHorizontal: 16, font: type.subhead, icon: 15, radius: 20 },
  large: { height: 50, paddingHorizontal: 20, font: type.headline, icon: 17, radius: 25 },
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
  const fill = fills[variant];
  const metrics = sizes[size];
  const inactive = disabled || busy;
  return (
    <PressableScale
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: inactive, busy }}
      hitSlop={size === "small" ? 6 : 0}
      // Sharing a row equally is the pressable's own layout; what is inside fills it.
      outerStyle={wide ? { flex: 1 } : undefined}
      style={style}
    >
      <View
        style={{
          height: metrics.height,
          paddingHorizontal: metrics.paddingHorizontal,
          borderRadius: metrics.radius,
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
        <Text numberOfLines={1} style={[metrics.font, { color: fill.foreground, fontWeight: "600" }]}>
          {title}
        </Text>
      </View>
    </PressableScale>
  );
}
