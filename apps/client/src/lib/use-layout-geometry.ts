import { useCallback, useEffect, useState } from "react";
import { Dimensions, type LayoutChangeEvent } from "react-native";
import type { LayoutMetrics } from "../../modules/link-layout";
import { matchingLayoutMetrics, type LayoutFrame } from "./adaptive-insets";

/**
 * How long to hold the previous matched divisions/occlusions while waiting for
 * native `LayoutProbe` to deliver the updated revision on same-orientation shifts
 * (e.g. Duo toolbar/header transitions), avoiding transient null layout flicker.
 */
export const LAYOUT_METRICS_GRACE_MS = 180;

const MAX_GRACE_DELTA_RATIO = 0.25;

/** True when a layout shift kept the same orientation and stayed within a modest size delta (not a physical fold/rotation). */
export function isTransientMetricsCompatible(reported: LayoutMetrics | null, frame: LayoutFrame): boolean {
  if (!reported || frame.width <= 0 || frame.height <= 0 || reported.width <= 0 || reported.height <= 0) return false;
  const sameOrientation = (reported.width >= reported.height) === (frame.width >= frame.height);
  if (!sameOrientation) return false;
  const widthDelta = Math.abs(reported.width - frame.width) / Math.max(reported.width, frame.width);
  const heightDelta = Math.abs(reported.height - frame.height) / Math.max(reported.height, frame.height);
  return widthDelta <= MAX_GRACE_DELTA_RATIO && heightDelta <= MAX_GRACE_DELTA_RATIO;
}

/**
 * Returns exact revision-matched metrics immediately when available; during a brief
 * same-orientation grace window while native metrics catch up, preserves the last
 * matched divisions/occlusions so folded tabletop layouts do not flicker to null.
 */
export function resolveLayoutMetrics(
  reported: LayoutMetrics | null,
  frame: LayoutFrame,
  revision: string,
  graceActive: boolean,
): { metrics: LayoutMetrics | null; pending: boolean } {
  const exact = matchingLayoutMetrics(reported, frame, revision);
  if (exact) return { metrics: exact, pending: false };
  if (graceActive && reported && isTransientMetricsCompatible(reported, frame)) {
    return {
      metrics: {
        ...reported,
        width: frame.width,
        height: frame.height,
      },
      pending: true,
    };
  }
  return { metrics: null, pending: false };
}

/** Native reserved regions and RN layout events can cross during a rotation. */
export function useLayoutGeometry() {
  const [frame, setFrame] = useState(() => {
    const win = Dimensions.get("window");
    return {
      width: Math.max(0, Math.round(win.width)),
      height: Math.max(0, Math.round(win.height)),
      generation: 0,
    };
  });
  const [reported, setReported] = useState<LayoutMetrics | null>(null);
  const [graceExpiredFor, setGraceExpiredFor] = useState<string | null>(null);
  const revision = `${frame.generation}:${frame.width}x${frame.height}`;
  const exact = matchingLayoutMetrics(reported, frame, revision);
  const canHoldGrace = !exact && graceExpiredFor !== revision && isTransientMetricsCompatible(reported, frame);

  useEffect(() => {
    if (!canHoldGrace) return;
    const timer = setTimeout(() => {
      setGraceExpiredFor(revision);
    }, LAYOUT_METRICS_GRACE_MS);
    return () => clearTimeout(timer);
  }, [canHoldGrace, revision]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    setFrame((current) =>
      current.width === width && current.height === height
        ? current
        : { width, height, generation: current.generation + 1 },
    );
  }, []);
  const onMetrics = useCallback((next: LayoutMetrics) => {
    if (matchingLayoutMetrics(next, frame, revision)) {
      setReported(next);
      setGraceExpiredFor(null);
    }
  }, [frame, revision]);

  const resolved = resolveLayoutMetrics(reported, frame, revision, canHoldGrace);
  return { frame, revision, onLayout, onMetrics, metrics: resolved.metrics, pending: resolved.pending };
}
