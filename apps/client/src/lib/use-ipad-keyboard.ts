import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Platform, View, useWindowDimensions, type KeyboardEvent, type KeyboardMetrics } from "react-native";
import { keyboardOverlap } from "./composer-layout";

/** iPad keyboards can move independently of the pane in portrait, landscape, Split View, and Slide Over. */
export function useIPadKeyboard(focused: boolean) {
  const window = useWindowDimensions();
  const enabled = Platform.OS === "ios" && Platform.isPad;
  const ref = useRef<View>(null);
  const frame = useRef<KeyboardMetrics | undefined>(undefined);
  const revision = useRef(0);
  const [overlap, setOverlap] = useState(0);
  const measure = useCallback(() => {
    if (!enabled) return;
    const current = ++revision.current;
    ref.current?.measureInWindow((x, y, width, height) => {
      if (current !== revision.current) return;
      setOverlap(keyboardOverlap({ x, y, width, height }, frame.current));
    });
  }, [enabled]);
  const invalidate = useCallback(() => { ++revision.current; }, []);
  useEffect(() => {
    if (!enabled || !focused) {
      frame.current = undefined;
      invalidate();
      setOverlap(0);
      return;
    }
    frame.current = Keyboard.metrics();
    measure();
    const change = (event: KeyboardEvent) => {
      frame.current = event.endCoordinates;
      Keyboard.scheduleLayoutAnimation(event);
      measure();
    };
    const hide = (event: KeyboardEvent) => {
      frame.current = undefined;
      ++revision.current;
      Keyboard.scheduleLayoutAnimation(event);
      setOverlap(0);
    };
    const subscriptions = [
      Keyboard.addListener("keyboardWillChangeFrame", change),
      Keyboard.addListener("keyboardDidShow", change),
      Keyboard.addListener("keyboardWillHide", hide),
    ];
    return () => {
      invalidate();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [enabled, focused, measure, invalidate, window.width, window.height]);
  return { enabled, ref, measure, overlap: enabled && focused ? overlap : 0 };
}
