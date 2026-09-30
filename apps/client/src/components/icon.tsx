import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { colors } from "@/theme/colors";

type SFSymbol = Extract<SymbolViewProps["name"], string>;
type AndroidName = Extract<SymbolViewProps["name"], { android?: unknown }>["android"];

export interface IconProps {
  /** SF Symbol (iOS). */
  sf: SFSymbol;
  /** Material Symbol (Android, web). */
  md: AndroidName;
  size?: number;
  color?: ColorValue;
  weight?: "regular" | "medium" | "semibold" | "bold";
  animation?: SymbolViewProps["animationSpec"];
  style?: StyleProp<ViewStyle>;
}

/** SF Symbols on iOS, Material Symbols everywhere else. */
export function Icon({ sf, md, size = 20, color = colors.label, weight = "regular", animation, style }: IconProps) {
  return (
    <SymbolView
      name={{ ios: sf, android: md, web: md }}
      size={size}
      tintColor={color}
      weight={weight}
      animationSpec={animation}
      style={[{ width: size, height: size }, style]}
    />
  );
}
