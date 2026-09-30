import { AppMenu } from "@/components/app-menu";
import { Stack } from "expo-router";
import { Platform, Pressable, View } from "react-native";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { Icon, type IconProps } from "./icon";

type Glyph = Pick<IconProps, "sf" | "md">;

export interface HeaderMenuItem {
  title: string;
  icon: Glyph;
  destructive?: boolean;
  onPress: () => void;
}

export type HeaderAction =
  | { kind: "button"; key: string; icon: Glyph; label: string; onPress: () => void }
  | { kind: "menu"; key: string; icon: Glyph; label: string; items: HeaderMenuItem[] };

/**
 * Header buttons for both platforms: iOS gets the system toolbar (liquid glass
 * buttons, UIMenu), Android gets Material icon buttons and a popup menu, since
 * the Android toolbar can't draw SF Symbols.
 */
export function HeaderActions({ actions }: { actions: HeaderAction[] }) {
  if (Platform.OS === "ios") {
    return (
      <Stack.Toolbar placement="right">
        {actions.map((action) =>
          action.kind === "button" ? (
            <Stack.Toolbar.Button key={action.key} icon={action.icon.sf} accessibilityLabel={action.label} onPress={action.onPress} />
          ) : (
            <Stack.Toolbar.Menu key={action.key} icon={action.icon.sf}>
              {action.items.map((item) => (
                <Stack.Toolbar.MenuAction key={item.title} icon={item.icon.sf} destructive={item.destructive} onPress={item.onPress}>
                  {item.title}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          ),
        )}
      </Stack.Toolbar>
    );
  }
  return <Stack.Screen options={{ headerRight: () => <MaterialActions actions={actions} /> }} />;
}

function IconButton({ icon, label, onPress }: { icon: Glyph; label: string; onPress?: () => void }) {
  // Inside a menu the menu handles the tap; a nested pressable would swallow it.
  if (!onPress) {
    return (
      <View accessibilityRole="button" accessibilityLabel={label} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Icon {...icon} size={24} color={colors.label} />
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ color: colors.fill as string, borderless: true, radius: 22 }}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
    >
      <Icon {...icon} size={24} color={colors.label} />
    </Pressable>
  );
}

function MaterialActions({ actions }: { actions: HeaderAction[] }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {actions.map((action) =>
        action.kind === "button" ? (
          <IconButton key={action.key} icon={action.icon} label={action.label} onPress={action.onPress} />
        ) : (
          <AppMenu
            key={action.key}
            actions={action.items.map((item, index) => ({
              id: String(index),
              title: item.title,
              attributes: { destructive: item.destructive },
            }))}
            onOpenMenu={() => haptics.selection()}
            onPressAction={({ nativeEvent }) => action.items[Number(nativeEvent.event)]?.onPress()}
            shouldOpenOnLongPress={false}
          >
            <IconButton icon={{ sf: action.icon.sf, md: "more_vert" }} label={action.label} />
          </AppMenu>
        ),
      )}
    </View>
  );
}
