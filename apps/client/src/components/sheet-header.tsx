import { router, Stack } from "expo-router";
import { Platform, Pressable, useColorScheme, View } from "react-native";
import { Icon, type IconProps } from "@/components/icon";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Text } from "./fixed-text";
import { useLocale } from "@/lib/locale";
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
export function SheetHeader({
  title,
  actions = [],
  onClose = dismiss,
}: {
  title: string;
  actions?: SheetHeaderAction[];
  onClose?: () => void;
}) {
  const scheme = useColorScheme();
  const { t } = useLocale();
  // Android presents formSheet in a bottom sheet without the native stack toolbar.
  // Put the actual actions in its content, not only in navigation options.
  if (Platform.OS === "android")
    return (
      <>
        <Stack.Screen options={{ title, headerShown: false }} />
        <View
          style={{
            alignSelf: "stretch",
            flexShrink: 0,
            minHeight: 52,
            flexDirection: "row",
            alignItems: "center",
            columnGap: 8,
            paddingHorizontal: 4,
          }}
        >
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            style={({ pressed }) => ({ ...button, opacity: pressed ? 0.6 : 1 })}
          >
            <Icon sf="xmark" md="close" size={21} color={colors.label} />
          </Pressable>
          <Text
            accessibilityRole="header"
            numberOfLines={2}
            style={[type.headline, { flex: 1, minWidth: 0, color: colors.label }]}
          >
            {title}
          </Text>
          {actions.map((action) => (
            <Pressable
              key={action.key}
              onPress={action.onPress}
              disabled={action.disabled}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityState={{ disabled: Boolean(action.disabled) }}
              style={({ pressed }) => ({
                minHeight: 44,
                minWidth: 44,
                maxWidth: "44%",
                paddingHorizontal: action.prominent ? 14 : 8,
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "row",
                gap: 5,
                borderRadius: 22,
                opacity: pressed ? 0.6 : 1,
                backgroundColor: action.prominent ? (action.disabled ? colors.fill : colors.accentFill) : "transparent",
              })}
            >
              <Icon
                {...action.icon}
                size={17}
                color={action.disabled ? colors.secondaryLabel : action.prominent ? colors.onAccent : colors.accent}
              />
              <Text
                numberOfLines={2}
                style={[
                  type.subhead,
                  {
                    flexShrink: 1,
                    fontWeight: "600",
                    color: action.disabled ? colors.secondaryLabel : action.prominent ? colors.onAccent : colors.accent,
                  },
                ]}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </>
    );
  // Keep both native bar appearances equal to the sheet's elevated surface.
  const backgroundColor = brandColors.sheet[scheme === "dark" ? 1 : 0];
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerShown: true,
          headerBackVisible: false,
          headerLargeTitleEnabled: false,
          headerTransparent: false,
          headerShadowVisible: false,
          headerStyle: { backgroundColor },
          headerLargeStyle: { backgroundColor },
        }}
      />
      {Platform.OS === "ios" ? (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon="xmark" accessibilityLabel="关闭" onPress={onClose}>
              关闭
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            {actions.map((action) => (
              <Stack.Toolbar.Button
                key={action.key}
                icon={action.icon.sf}
                accessibilityLabel={action.label}
                disabled={action.disabled}
                variant={action.prominent ? "done" : "plain"}
                tintColor={action.prominent ? colors.accentFill : undefined}
                onPress={action.onPress}
              >
                {action.label}
              </Stack.Toolbar.Button>
            ))}
          </Stack.Toolbar>
        </>
      ) : (
        <Stack.Screen
          options={{
            headerLeft: () => (
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭" style={button}>
                <Icon sf="xmark" md="close" size={22} color={colors.label} />
              </Pressable>
            ),
            headerRight: () => (
              <View style={{ flexDirection: "row" }}>
                {actions.map((action) => (
                  <Pressable
                    key={action.key}
                    onPress={action.onPress}
                    disabled={action.disabled}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    accessibilityState={{ disabled: action.disabled }}
                    style={[button, { opacity: action.disabled ? 0.4 : 1 }]}
                  >
                    <Icon {...action.icon} size={22} color={colors.accent} />
                  </Pressable>
                ))}
              </View>
            ),
          }}
        />
      )}
    </>
  );
}

const button = { width: 44, height: 44, alignItems: "center", justifyContent: "center" } as const;
