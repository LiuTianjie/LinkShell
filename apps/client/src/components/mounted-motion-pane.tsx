import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { cancelAnimation, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { ContentWidth } from "@/lib/content-width";

export interface PaneFrame { left: number; top: number; width: number; height: number }

const PANE_SPRING = { mass: 0.8, stiffness: 260, damping: 22, energyThreshold: 1e-5, reduceMotion: ReduceMotion.System };

/** Only explicit controls animate; resize and fold geometry always take effect immediately. */
export function MountedMotionPane({
  children, frame, visible, action, geometry, style, fixedWidth,
}: {
  children: ReactNode;
  frame: PaneFrame;
  visible: boolean;
  action: number;
  geometry: string;
  style?: StyleProp<ViewStyle>;
  fixedWidth?: number;
}) {
  const { left, top, width, height } = frame;
  const opacity = visible ? 1 : 0;
  const position = useSharedValue({ left, top, opacity });
  const dimensions = useSharedValue({ width, height });
  const previousPosition = useRef({ action, geometry });
  const previousDimensions = useRef({ action, geometry });
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  // Retarget the running spring, so another tap never restarts from rest.
  useLayoutEffect(() => {
    const previous = previousPosition.current;
    const animate = previous.action !== action && previous.geometry === geometry;
    previousPosition.current = { action, geometry };
    const next = { left, top, opacity };
    if (animate) position.value = withSpring(next, PANE_SPRING);
    else {
      if (previous.geometry !== geometry) cancelAnimation(position);
      position.value = next;
    }
  }, [action, geometry, left, top, opacity, position]);

  // A child's measured viewport can follow its parent's size without resetting its slide.
  useLayoutEffect(() => {
    const previous = previousDimensions.current;
    const animate = previous.action !== action && previous.geometry === geometry;
    previousDimensions.current = { action, geometry };
    const next = { width, height };
    if (animate) dimensions.value = withSpring(next, PANE_SPRING);
    else {
      if (previous.geometry !== geometry) cancelAnimation(dimensions);
      dimensions.value = next;
    }
  }, [action, geometry, width, height, dimensions]);

  const animated = useAnimatedStyle(() => ({
    left: position.value.left,
    top: position.value.top,
    width: Math.max(0, dimensions.value.width),
    height: Math.max(0, dimensions.value.height),
    opacity: Math.max(0, Math.min(1, position.value.opacity)),
  }));
  return (
    <Animated.View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      onLayout={(event) => { const next = event.nativeEvent.layout.width; if (fixedWidth === undefined && next > 0) setMeasuredWidth(next); }}
      style={[{ position: "absolute", overflow: "hidden", minWidth: 0 }, style, animated]}
    >
      <View style={{ width: fixedWidth ?? "100%", height: "100%" }}><ContentWidth value={fixedWidth ?? measuredWidth}>{children}</ContentWidth></View>
    </Animated.View>
  );
}
