import { Platform, Pressable, useColorScheme, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Glass } from "./glass";
import { Icon, type IconProps } from "./icon";
import { TopFade } from "./top-fade";
import { usePageInsets } from "./adaptive-page";
import { HeaderActions } from "./header-actions";

// Tab pages' header: the large title and its buttons share one line, with no
// empty navigation bar above them. Scrolls with the content; a fade keeps the
// status bar legible over whatever passes under it.

export interface PageAction {
  key: string;
  icon: Pick<IconProps, "sf" | "md">;
  label: string;
  onPress: () => void;
}

export function PageActionButton({ action }: { action: PageAction }) {
  const icon = <Icon {...action.icon} size={19} color={colors.label} weight="medium" />;
  const press = () => {
    haptics.selection();
    action.onPress();
  };
  if (Platform.OS === "ios") {
    return (
      <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={action.label} hitSlop={6}>
        <Glass interactive style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
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

export function PageHeader({ title, actions = [], children, compact = false, native = false }: { title: string; actions?: PageAction[]; children?: React.ReactNode; compact?: boolean; native?: boolean }) {
  const insets = usePageInsets();
  if (native && Platform.OS === "ios") {
    return <>{actions.length ? <HeaderActions actions={actions.map((action) => ({ ...action, kind: "button" as const }))} /> : null}{children}</>;
  }
  // Tab pages own their insets because their scroll views use adjustment="never".
  return (
    <View style={{ paddingTop: compact ? 18 : insets.top + 12, gap: compact ? 10 : 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, fontSize: compact ? 28 : 34, lineHeight: compact ? 35 : 41, fontWeight: "700", color: colors.label }}>
          {title}
        </Text>
        {actions.map((action) => (
          <PageActionButton key={action.key} action={action} />
        ))}
      </View>
      {children}
    </View>
  );
}

/** A search field in the page's own style (tab pages have no native search bar). */
export function PageSearch({ value, onChangeText, placeholder, action }: { value: string; onChangeText: (text: string) => void; placeholder: string; action?: PageAction }) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 }}>
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: Math.max(44, Math.ceil(20 * fontScale) + 14),
        paddingHorizontal: 11,
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
    {action ? <PageActionButton action={action} /> : null}
    </View>
  );
}

/** Fades content out under the status bar. Place last in the screen. */
export function StatusBarFade() {
  const insets = usePageInsets();
  const dark = useColorScheme() === "dark";
  if (Platform.OS !== "ios") {
    return <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top, backgroundColor: colors.background }} />;
  }
  return <TopFade height={insets.top + 18} color={dark ? "#000000" : "#f2f2f7"} />;
}
