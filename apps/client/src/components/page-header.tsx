import { Platform, Pressable, Text, TextInput, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Glass } from "./glass";
import { Icon, type IconProps } from "./icon";
import { TopFade } from "./top-fade";

// Tab pages' header: the large title and its buttons share one line, with no
// empty navigation bar above them. Scrolls with the content; a fade keeps the
// status bar legible over whatever passes under it.

export interface PageAction {
  key: string;
  icon: Pick<IconProps, "sf" | "md">;
  label: string;
  onPress: () => void;
}

function ActionButton({ action }: { action: PageAction }) {
  const icon = <Icon {...action.icon} size={19} color={colors.label} weight="medium" />;
  const press = () => {
    haptics.selection();
    action.onPress();
  };
  if (Platform.OS === "ios") {
    return (
      <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={action.label} hitSlop={6}>
        <Glass interactive style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
          {icon}
        </Glass>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      android_ripple={{ color: colors.fill as string, borderless: true, radius: 22 }}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
    >
      <Icon {...action.icon} size={24} color={colors.label} />
    </Pressable>
  );
}

export function PageHeader({ title, actions = [], children }: { title: string; actions?: PageAction[]; children?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  // iOS scroll views already start their content below the status bar;
  // Android's don't.
  return (
    <View style={{ paddingTop: Platform.OS === "ios" ? 4 : insets.top + 12, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, fontSize: 34, lineHeight: 41, fontWeight: "700", color: colors.label }}>
          {title}
        </Text>
        {actions.map((action) => (
          <ActionButton key={action.key} action={action} />
        ))}
      </View>
      {children}
    </View>
  );
}

/** A search field in the page's own style (tab pages have no native search bar). */
export function PageSearch({ value, onChangeText, placeholder }: { value: string; onChangeText: (text: string) => void; placeholder: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: 38,
        paddingHorizontal: 11,
        marginTop: 4,
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: colors.fillStrong,
      }}
    >
      <Icon sf="magnifyingglass" md="search" size={15} color={colors.secondaryLabel} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder as string}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        style={[type.body, { flex: 1, fontSize: 16, color: colors.label, paddingVertical: 0 }]}
      />
    </View>
  );
}

/** Fades content out under the status bar. Place last in the screen. */
export function StatusBarFade() {
  const insets = useSafeAreaInsets();
  const dark = useColorScheme() === "dark";
  if (Platform.OS !== "ios") {
    return <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top, backgroundColor: colors.background }} />;
  }
  return <TopFade height={insets.top + 18} color={dark ? "#000000" : "#f2f2f7"} />;
}
