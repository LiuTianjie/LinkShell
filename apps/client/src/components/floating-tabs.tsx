import { BlurTargetView, BlurView } from "expo-blur";
import { TabList, TabSlot, Tabs, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Platform, Pressable, useColorScheme, View, type View as RNView } from "react-native";
import { Text } from "@/components/fixed-text";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { Icon, type IconProps } from "./icon";

// A floating capsule tab bar for Android (and anywhere without native liquid
// glass tabs): content blurs underneath it and a pill slides to the selected
// tab, so it reads like the iOS 26 bar rather than a Material bottom nav.

export const TAB_BAR_HEIGHT = 64;
const SIDE_MARGIN = 24;
const GAP_BELOW = 10;

/** Space scroll views should leave under their content for the floating bar. */
export function useFloatingTabInset(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === "ios" ? 0 : TAB_BAR_HEIGHT + GAP_BELOW + insets.bottom + 8;
}

export interface FloatingTab {
  name: string;
  href: string;
  label: string;
  icon: Pick<IconProps, "sf" | "md">;
  selectedIcon?: Pick<IconProps, "sf" | "md">;
  badge?: number;
}

const SPRING = { damping: 20, stiffness: 260, mass: 0.8 };

const TabButton = forwardRef<RNView, TabTriggerSlotProps & { tab: FloatingTab }>(function TabButton(
  { tab, isFocused, onPress, onLongPress, style: _style, ...props },
  ref,
) {
  const icon = isFocused && tab.selectedIcon ? tab.selectedIcon : tab.icon;
  const tint = isFocused ? colors.accent : colors.secondaryLabel;
  return (
    <Pressable
      {...props}
      ref={ref}
      onPress={(event) => {
        if (!isFocused) haptics.selection();
        onPress?.(event);
      }}
      onLongPress={onLongPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={tab.badge ? `${tab.label}，${tab.badge} 项待处理` : tab.label}
      android_ripple={{ color: "transparent" }}
      style={{ flex: 1, height: TAB_BAR_HEIGHT, alignItems: "center", justifyContent: "center", gap: 3 }}
    >
      <View>
        <Icon {...icon} size={24} color={tint} weight={isFocused ? "semibold" : "regular"} />
        {tab.badge ? (
          <View
            style={{
              position: "absolute",
              top: -4,
              left: 16,
              minWidth: 18,
              height: 18,
              paddingHorizontal: 5,
              borderRadius: 9,
              backgroundColor: colors.danger,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "#ffffff", fontSize: 11, lineHeight: 13, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
              {tab.badge > 99 ? "99+" : tab.badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={{ fontSize: 11, lineHeight: 13, fontWeight: isFocused ? "700" : "500", color: tint }}>{tab.label}</Text>
    </Pressable>
  );
});

/** The capsule itself: blur, hairline, shadow, and the sliding selection pill. */
function Capsule({ tabs, focused, blurTarget }: { tabs: FloatingTab[]; focused: number; blurTarget: React.RefObject<RNView | null> }) {
  const dark = useColorScheme() === "dark";
  const [width, setWidth] = useState(0);
  const slot = width > 0 ? (width - 12) / tabs.length : 0;
  const x = useSharedValue(0);

  useEffect(() => {
    if (slot > 0) x.value = withSpring(focused * slot, SPRING);
  }, [focused, slot, x]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        if (next !== width) {
          setWidth(next);
          x.value = focused * ((next - 12) / tabs.length);
        }
      }}
      style={{
        height: TAB_BAR_HEIGHT,
        borderRadius: TAB_BAR_HEIGHT / 2,
        overflow: "hidden",
        boxShadow: dark ? "0 8px 28px rgba(0,0,0,0.55)" : "0 8px 28px rgba(20,24,60,0.16)",
      }}
    >
      <BlurView
        blurTarget={blurTarget}
        blurMethod="dimezisBlurViewSdk31Plus"
        tint={dark ? "dark" : "light"}
        intensity={70}
        style={{ position: "absolute", inset: 0 }}
      />
      {/* Frosted wash: keeps labels legible over busy content and is the whole look where blur is unavailable. */}
      <View
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: dark ? "rgba(36,37,44,0.72)" : "rgba(252,252,255,0.74)",
          borderRadius: TAB_BAR_HEIGHT / 2,
          borderWidth: 0.5,
          borderColor: dark ? "rgba(255,255,255,0.12)" : "rgba(10,12,40,0.08)",
        }}
      />
      {slot > 0 ? (
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 6,
              left: 6,
              width: slot,
              height: TAB_BAR_HEIGHT - 12,
              borderRadius: (TAB_BAR_HEIGHT - 12) / 2,
              backgroundColor: dark ? "rgba(255,255,255,0.10)" : "rgba(10,12,40,0.06)",
            },
            pill,
          ]}
        />
      ) : null}
    </View>
  );
}

/** Headless expo-router tabs with the floating capsule. */
export function FloatingTabs({ tabs }: { tabs: FloatingTab[] }) {
  const insets = useSafeAreaInsets();
  const target = useRef<RNView | null>(null);
  const [focused, setFocused] = useState(0);

  return (
    <Tabs style={{ flex: 1 }}>
      {/* The blur target takes no colour props; the page colour lives inside it. */}
      <BlurTargetView ref={target} style={{ flex: 1 }}>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <TabSlot />
        </View>
      </BlurTargetView>
      <TabList
        style={{
          position: "absolute",
          left: SIDE_MARGIN,
          right: SIDE_MARGIN,
          bottom: insets.bottom + GAP_BELOW,
          height: TAB_BAR_HEIGHT,
          flexDirection: "row",
          paddingHorizontal: 6,
        }}
      >
        <View pointerEvents="none" style={{ position: "absolute", inset: 0 }}>
          <Capsule tabs={tabs} focused={focused} blurTarget={target} />
        </View>
        {tabs.map((tab, index) => (
          <TabTrigger key={tab.name} name={tab.name} href={tab.href as never} asChild>
            <FocusReporter tab={tab} onFocused={() => setFocused(index)} />
          </TabTrigger>
        ))}
      </TabList>
    </Tabs>
  );
}

/** Passes the trigger through and tells the capsule which tab is selected. */
const FocusReporter = forwardRef<RNView, TabTriggerSlotProps & { tab: FloatingTab; onFocused: () => void }>(function FocusReporter(
  { onFocused, ...props },
  ref,
) {
  useEffect(() => {
    if (props.isFocused) onFocused();
  }, [props.isFocused, onFocused]);
  return <TabButton ref={ref} {...props} />;
});
