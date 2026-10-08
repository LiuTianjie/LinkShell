import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { LayoutMetrics } from "../../modules/link-layout";
import { matchingLayoutMetrics } from "./adaptive-insets";

/** Native reserved regions and RN layout events can cross during a rotation. */
export function useLayoutGeometry() {
  const [frame, setFrame] = useState({ width: 0, height: 0, generation: 0 });
  const [reported, setReported] = useState<LayoutMetrics | null>(null);
  const revision = `${frame.generation}:${frame.width}x${frame.height}`;
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setFrame((current) => current.width === width && current.height === height ? current : { width, height, generation: current.generation + 1 });
  }, []);
  const onMetrics = useCallback((next: LayoutMetrics) => {
    if (matchingLayoutMetrics(next, frame, revision)) setReported(next);
  }, [frame, revision]);
  return { frame, revision, onLayout, onMetrics, metrics: matchingLayoutMetrics(reported, frame, revision) };
}
