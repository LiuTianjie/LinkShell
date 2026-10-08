import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Modal, Platform, Pressable, ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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

export interface FloatingMenuHandle {
  open(): void;
}

/**
 * Android only: the floating card opened by the caller (a row's own long
 * press), for children that handle their own touches — wrapping them in
 * another Pressable would never see the long press.
 */
export function OwnedFloatingMenu({ handle, ...props }: Omit<AppMenuProps, "shouldOpenOnLongPress"> & { handle: Ref<FloatingMenuHandle> }) {
  return <FloatingMenu {...props} handle={handle} />;
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
  geometry: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const CARD_MIN = 232;
const GUTTER = 12;

function FloatingMenu({
  title,
  actions,
  onPressAction,
  onOpenMenu,
  shouldOpenOnLongPress,
  style,
  children,
  handle,
}: AppMenuProps & { handle?: Ref<FloatingMenuHandle> }) {
  const anchorRef = useRef<View>(null);
  const measurement = useRef(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  // Submenus push onto this stack.
  const [stack, setStack] = useState<{ title?: string; actions: MenuAction[] }[]>([]);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const geometry = [window.width, window.height, insets.top, insets.right, insets.bottom, insets.left].join(":");
  // Native measurement can finish after rotation, dismissal, or unmount.
  useEffect(() => {
    measurement.current += 1;
    setAnchor(null);
    return () => { measurement.current += 1; };
  }, [geometry]);

  const open = () => {
    const request = ++measurement.current;
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      if (request !== measurement.current || width <= 0 || height <= 0) return;
      haptics.selection();
      onOpenMenu?.();
      setStack([{ title, actions }]);
      setAnchor({ geometry, x, y, width, height });
    });
  };
  useImperativeHandle(handle, () => ({ open }));
  const close = () => { measurement.current += 1; setAnchor(null); };
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
  const safeLeft = insets.left + GUTTER;
  const safeRight = window.width - insets.right - GUTTER;
  const safeTop = insets.top + GUTTER;
  const safeBottom = window.height - insets.bottom - GUTTER;
  const width = Math.max(0, Math.min(safeRight - safeLeft, Math.max(CARD_MIN, anchor?.width ?? CARD_MIN)));
  const left = Math.max(safeLeft, Math.min(anchor?.x ?? safeLeft, safeRight - width));
  const anchorTop = Math.max(safeTop, Math.min(anchor?.y ?? safeTop, safeBottom));
  const anchorBottom = Math.max(safeTop, Math.min((anchor?.y ?? safeTop) + (anchor?.height ?? 0), safeBottom));
  const below = Math.max(0, safeBottom - anchorBottom - 6);
  const above = Math.max(0, anchorTop - safeTop - 6);
  const openUp = below < 280 && above > below;
  const maxHeight = openUp ? above : below;

  return (
    <>
      {handle ? (
        <View ref={anchorRef} collapsable={false} style={style}>
          {children}
        </View>
      ) : (
        <Pressable
          ref={anchorRef}
          onPress={shouldOpenOnLongPress ? undefined : open}
          onLongPress={shouldOpenOnLongPress ? open : undefined}
          style={style}
        >
          {children}
        </Pressable>
      )}
      {anchor && anchor.geometry === geometry && level ? (
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
                ...(openUp ? { bottom: window.height - anchorTop + 6 } : { top: anchorBottom + 6 }),
                borderRadius: 18,
                backgroundColor: colors.cardRaised,
                boxShadow: "0 12px 36px rgba(12,14,30,0.22), 0 2px 6px rgba(12,14,30,0.08)",
                overflow: "hidden",
              }}
            >
              <Pressable>
                {stack.length > 1 || level.title ? (
                  <View onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 }}>
                    {stack.length > 1 ? (
                      <Pressable onPress={() => setStack((current) => current.slice(0, -1))} accessibilityRole="button" accessibilityLabel="返回" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                        <Icon sf="chevron.left" md="arrow_back" size={16} color={colors.secondaryLabel} />
                      </Pressable>
                    ) : null}
                    {/* Two lines: a title can carry a short note on what the choice does. */}
                    <Text numberOfLines={2} style={[type.footnote, { flex: 1, color: colors.secondaryLabel, fontWeight: "600" }]}>
                      {level.title}
                    </Text>
                  </View>
                ) : null}
                <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={{ maxHeight: Math.max(0, maxHeight - (stack.length > 1 || level.title ? headerHeight : 0)) }} contentContainerStyle={{ paddingVertical: 6 }}>
                  {level.actions.map((action, index) => {
                    const disabled = action.attributes?.disabled === true;
                    const destructive = action.attributes?.destructive === true;
                    const checked = action.state === "on";
                    return (
                      <Pressable
                        key={action.id ?? index}
                        disabled={disabled}
                        accessibilityRole="menuitem"
                        accessibilityState={{ disabled, selected: checked }}
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
                            numberOfLines={2}
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
