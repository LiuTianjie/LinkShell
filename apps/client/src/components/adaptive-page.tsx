import { Children, createContext, use, useState, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ContentWidth, useContentWidth } from "@/lib/content-width";
import { colors } from "@/theme/colors";
import { LayoutProbe } from "../../modules/link-layout";
import { useLayoutGeometry } from "@/lib/use-layout-geometry";
import { safeContentInsets, type ContentInsets } from "@/lib/adaptive-insets";

const PageInsets = createContext<ContentInsets | null>(null);
export function usePageInsets() {
  const local = use(PageInsets);
  const fallback = useSafeAreaInsets();
  return local ?? fallback;
}

/** A pane placed below the native bar must not reserve its top inset again. */
export function ConsumedTopInset({ height, children }: { height: number; children: ReactNode }) {
  const insets = usePageInsets();
  return <PageInsets value={{ ...insets, top: Math.max(0, insets.top - height) }}>{children}</PageInsets>;
}

type Options = { maxWidth?: number; surface?: "plain" | "background" | "sheet" | "code" };

/** Native bars can move to either side; every page keeps its own readable width. */
export function AdaptivePage({ children, maxWidth, surface = "background" }: Options & { children: ReactNode }) {
  const fallback = useSafeAreaInsets();
  const geometry = useLayoutGeometry();
  const insets = safeContentInsets(geometry.metrics, fallback);
  const [width, setWidth] = useState<number | null>(null);
  return (
    <View onLayout={geometry.onLayout} style={{ flex: 1, backgroundColor: colors[surface] }}>
      <LayoutProbe onMetrics={geometry.onMetrics} revision={geometry.revision} />
      <View style={{ flex: 1, paddingLeft: insets.left, paddingRight: insets.right }}>
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, width: "100%", maxWidth, alignSelf: "center" }}>
        <PageInsets value={{ ...insets, left: 0, right: 0 }}><ContentWidth value={width}>{children}</ContentWidth></PageInsets>
      </View>
      </View>
    </View>
  );
}

export function adaptiveScreen(Screen: ComponentType, options: Options = {}) {
  return function AdaptiveRoute() { return <AdaptivePage {...options}><Screen /></AdaptivePage>; };
}

export function AdaptiveGrid({ children, minimum = 340 }: { children: ReactNode; minimum?: number }) {
  const width = useContentWidth() - 32;
  const columns = width >= minimum * 2 + 16 ? 2 : 1;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>{Children.toArray(children).map((child, index) => <View key={index} style={{ width: columns === 2 ? (width - 16) / 2 : "100%", minWidth: 0 }}>{child}</View>)}</View>;
}
