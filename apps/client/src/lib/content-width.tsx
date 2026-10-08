import { createContext, use, useState } from "react";
import { View, type ViewProps } from "react-native";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";

export const ContentWidth = createContext<number | null>(null);

/** Embedded content measures its pane, while full-screen viewers use the window. */
export function useContentWidth() {
  const pane = use(ContentWidth);
  const window = useWindowDimensions();
  return pane ?? window.width;
}

/** Measure after margins and safe areas, rather than predicting a child's width. */
export function ContentPane({ children, onLayout, ...props }: ViewProps) {
  const [width, setWidth] = useState<number | null>(null);
  return <View {...props} onLayout={(event) => { setWidth(event.nativeEvent.layout.width); onLayout?.(event); }}><ContentWidth value={width}>{children}</ContentWidth></View>;
}
