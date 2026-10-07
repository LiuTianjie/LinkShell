import { useWindowDimensions } from "react-native";

/** Rotation and resizing stay live; system text settings do not change app layout. */
export function useAppWindowDimensions() {
  const dimensions = useWindowDimensions();
  return { ...dimensions, fontScale: 1 };
}
