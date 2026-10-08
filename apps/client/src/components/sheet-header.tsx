import { router, Stack } from "expo-router";
import { Platform, Pressable, useColorScheme, View } from "react-native";
import { Icon, type IconProps } from "@/components/icon";
import { colors } from "@/theme/colors";
import brandColors from "@/theme/brand-colors.json";

export interface SheetHeaderAction {
  key: string;
  label: string;
  icon: Pick<IconProps, "sf" | "md">;
  onPress: () => void;
  disabled?: boolean;
  prominent?: boolean;
}

const dismiss = () => router.back();

/** Let the navigation controller place sheet controls on the appropriate edge. */
export function SheetHeader({ title, actions = [], onClose = dismiss }: { title: string; actions?: SheetHeaderAction[]; onClose?: () => void }) {
  const scheme = useColorScheme();
  // Keep both native bar appearances equal to the sheet's elevated surface.
  const backgroundColor = brandColors.sheet[scheme === "dark" ? 1 : 0];
  return (
    <>
      <Stack.Screen options={{ title, headerShown: true, headerBackVisible: false, headerLargeTitleEnabled: false, headerTransparent: false, headerShadowVisible: false, headerStyle: { backgroundColor }, headerLargeStyle: { backgroundColor } }} />
      {Platform.OS === "ios" ? (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon="xmark" accessibilityLabel="关闭" onPress={onClose}>关闭</Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            {actions.map((action) => (
              <Stack.Toolbar.Button key={action.key} icon={action.icon.sf} accessibilityLabel={action.label} disabled={action.disabled} variant={action.prominent ? "done" : "plain"} onPress={action.onPress}>{action.label}</Stack.Toolbar.Button>
            ))}
          </Stack.Toolbar>
        </>
      ) : (
        <Stack.Screen options={{
          headerLeft: () => <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭" style={button}><Icon sf="xmark" md="close" size={22} color={colors.label} /></Pressable>,
          headerRight: () => <View style={{ flexDirection: "row" }}>{actions.map((action) => <Pressable key={action.key} onPress={action.onPress} disabled={action.disabled} accessibilityRole="button" accessibilityLabel={action.label} accessibilityState={{ disabled: action.disabled }} style={[button, { opacity: action.disabled ? 0.4 : 1 }]}><Icon {...action.icon} size={22} color={colors.accent} /></Pressable>)}</View>,
        }} />
      )}
    </>
  );
}

const button = { width: 44, height: 44, alignItems: "center", justifyContent: "center" } as const;
