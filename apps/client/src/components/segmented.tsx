import { Pressable, useColorScheme, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";

/**
 * A few mutually exclusive choices in one track, the selected one lifted on a
 * card: the system's segmented control, drawn so it matches on both platforms.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  size = "regular",
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  size?: "regular" | "small";
  /** What is being chosen, for VoiceOver. */
  label?: string;
}) {
  const small = size === "small";
  // The system's own thumb colors: white on light; on dark a raised grey, since a card would sink into the track.
  const thumb = useColorScheme() === "dark" ? "#636366" : "#ffffff";
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: "row", padding: 2, borderRadius: small ? 9 : 10, borderCurve: "continuous", backgroundColor: colors.fill }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => {
              if (selected) return;
              haptics.selection();
              onChange(option.value);
            }}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            hitSlop={small ? 6 : 0}
            style={{
              flex: small ? undefined : 1,
              minWidth: small ? 52 : undefined,
              height: small ? 26 : 32,
              paddingHorizontal: small ? 10 : 12,
              borderRadius: small ? 7 : 8,
              borderCurve: "continuous",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: selected ? thumb : "transparent",
              boxShadow: selected ? "0 1px 3px rgba(0,0,0,0.12)" : undefined,
            }}
          >
            <Text style={{ fontSize: small ? 12 : 13, fontWeight: selected ? "600" : "500", color: selected ? colors.label : colors.secondaryLabel }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
