import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import { useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { Easing, FadeIn, FadeOut } from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "./icon";

// Menus: the system's UIMenu on iOS; on Android a floating card in the app's
// own style (Android's popup menu is a dated checkbox list). Same props as
// MenuView, so callers don't care which they get.

export interface AppMenuProps {
  title?: string;
  actions: MenuAction[];
  onPressAction: (event: NativeActionEvent) => void;
  onOpenMenu?: () => void;
  shouldOpenOnLongPress?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

export function AppMenu(props: AppMenuProps) {
  if (Platform.OS === "ios") {
    return (
      <MenuView
        title={props.title}
        actions={props.actions}
        onPressAction={props.onPressAction}
        onOpenMenu={props.onOpenMenu}
        shouldOpenOnLongPress={props.shouldOpenOnLongPress ?? false}
        style={props.style}
      >
        {props.children}
      </MenuView>
    );
  }
  return <FloatingMenu {...props} />;
}

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CARD_MIN = 232;
const GUTTER = 12;

function FloatingMenu({ title, actions, onPressAction, onOpenMenu, shouldOpenOnLongPress, style, children }: AppMenuProps) {
  const anchorRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // Submenus push onto this stack.
  const [stack, setStack] = useState<{ title?: string; actions: MenuAction[] }[]>([]);
  const window = useWindowDimensions();

  const open = () => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      haptics.selection();
      onOpenMenu?.();
      setStack([{ title, actions }]);
      setAnchor({ x, y, width, height });
    });
  };
  const close = () => setAnchor(null);
  const choose = (action: MenuAction) => {
    if (action.subactions?.length) {
      haptics.selection();
      setStack((current) => [...current, { title: action.title, actions: action.subactions! }]);
      return;
    }
    close();
    if (action.id) onPressAction({ nativeEvent: { event: action.id } } as NativeActionEvent);
  };

  const level = stack[stack.length - 1];
  // As wide as what opened it (a field), at least a comfortable minimum (an icon button).
  const width = anchor ? Math.min(window.width - GUTTER * 2, Math.max(CARD_MIN, anchor.width)) : CARD_MIN;
  const left = anchor ? Math.min(Math.max(anchor.x, GUTTER), window.width - width - GUTTER) : 0;
  const below = anchor ? window.height - (anchor.y + anchor.height) : 0;
  const above = anchor ? anchor.y : 0;
  const openUp = below < 280 && above > below;
  const maxHeight = Math.max(160, (openUp ? above : below) - GUTTER * 3);

  return (
    <>
      <Pressable
        ref={anchorRef}
        onPress={shouldOpenOnLongPress ? undefined : open}
        onLongPress={shouldOpenOnLongPress ? open : undefined}
        style={style}
      >
        {children}
      </Pressable>
      {anchor && level ? (
        <Modal visible transparent statusBarTranslucent navigationBarTranslucent animationType="none" onRequestClose={close}>
          <Pressable onPress={close} style={{ flex: 1 }} accessibilityLabel="关闭菜单">
            <Animated.View
              entering={FadeIn.duration(140).easing(Easing.out(Easing.cubic))}
              exiting={FadeOut.duration(100)}
              style={{
                position: "absolute",
                left,
                width,
                maxHeight,
                ...(openUp ? { bottom: window.height - anchor.y + 6 } : { top: anchor.y + anchor.height + 6 }),
                borderRadius: 18,
                backgroundColor: colors.cardRaised,
                boxShadow: "0 12px 36px rgba(12,14,30,0.22), 0 2px 6px rgba(12,14,30,0.08)",
                overflow: "hidden",
              }}
            >
              <Pressable>
                {stack.length > 1 || level.title ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 }}>
                    {stack.length > 1 ? (
                      <Pressable onPress={() => setStack((current) => current.slice(0, -1))} hitSlop={10} accessibilityLabel="返回">
                        <Icon sf="chevron.left" md="arrow_back" size={16} color={colors.secondaryLabel} />
                      </Pressable>
                    ) : null}
                    <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel, fontWeight: "600" }]}>
                      {level.title}
                    </Text>
                  </View>
                ) : null}
                <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={{ maxHeight: maxHeight - 40 }} contentContainerStyle={{ paddingVertical: 6 }}>
                  {level.actions.map((action, index) => {
                    const disabled = action.attributes?.disabled === true;
                    const destructive = action.attributes?.destructive === true;
                    const checked = action.state === "on";
                    return (
                      <Pressable
                        key={action.id ?? index}
                        disabled={disabled}
                        onPress={() => choose(action)}
                        android_ripple={{ color: colors.fill as string }}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 10,
                          minHeight: 48,
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                          opacity: disabled ? 0.4 : 1,
                        }}
                      >
                        <View style={{ flex: 1, gap: 1 }}>
                          <Text
                            numberOfLines={1}
                            style={[
                              type.body,
                              { fontSize: 16, color: destructive ? colors.danger : colors.label, fontWeight: checked ? "600" : "400" },
                            ]}
                          >
                            {action.title}
                          </Text>
                          {action.subtitle ? (
                            <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>
                              {action.subtitle}
                            </Text>
                          ) : null}
                        </View>
                        {action.subactions?.length ? (
                          <Icon sf="chevron.right" md="chevron_right" size={16} color={colors.tertiaryLabel} />
                        ) : checked ? (
                          <Icon sf="checkmark" md="check" size={18} color={colors.accent} weight="semibold" />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </Pressable>
            </Animated.View>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}
