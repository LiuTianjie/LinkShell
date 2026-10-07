import { AppMenu } from "@/components/app-menu";
import { Stack } from "expo-router";
import { Platform, Pressable, View } from "react-native";
import { useContentWidth } from "@/lib/content-width";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { Icon, type IconProps } from "./icon";
import { LiveDot } from "./status";

type Glyph = Pick<IconProps, "sf" | "md">;

export interface HeaderMenuItem {
  title: string;
  icon: Glyph;
  destructive?: boolean;
  onPress: () => void;
}

export type HeaderAction =
  | {
      kind: "button";
      key: string;
      icon: Glyph;
      label: string;
      /** Given: the button can show the app's live dot at its icon's corner (true: something behind it is at work). */
      live?: boolean;
      onPress: () => void;
    }
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
            <Stack.Toolbar.Button key={action.key} icon={action.icon.sf} accessibilityLabel={action.label} onPress={action.onPress}>
              <Stack.Toolbar.Label>{action.label}</Stack.Toolbar.Label>
              {action.live ? <Stack.Toolbar.Badge>•</Stack.Toolbar.Badge> : null}
            </Stack.Toolbar.Button>
          ) : (
            <Stack.Toolbar.Menu key={action.key} icon={action.icon.sf} accessibilityLabel={action.label}>
              <Stack.Toolbar.Label>{action.label}</Stack.Toolbar.Label>
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

/**
 * The widest a custom header title can be beside the back button and `count`
 * actions. The native header never sizes a custom title to the room it has, so
 * a wider one slides under the buttons.
 */
export function useHeaderTitleWidth(count: number): number {
  const width = useContentWidth();
  // iOS 26: the back button is a 44pt circle 16 from the edge; the actions share
  // one capsule, 44 each and 14 apart. The bar keeps 12 between it and the title.
  // Android: the title starts 56 in, then 44 per icon button and a 16 margin.
  const room =
    Platform.OS === "ios"
      ? width - (16 + 44 + 12) - (12 + 44 * count + 14 * Math.max(count - 1, 0) + 16)
      : width - 56 - (12 + 44 * count + 16);
  return Math.max(80, Math.min(room, 320));
}

function IconButton({ icon, label, live, onPress }: { icon: Glyph; label: string; live?: boolean; onPress?: () => void }) {
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
      {live ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 8, right: 6 }}>
          <LiveDot size={6} />
        </View>
      ) : null}
    </Pressable>
  );
}

function MaterialActions({ actions }: { actions: HeaderAction[] }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {actions.map((action) =>
        action.kind === "button" ? (
          <IconButton key={action.key} icon={action.icon} label={action.label} live={action.live} onPress={action.onPress} />
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
