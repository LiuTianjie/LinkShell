import { Platform } from "react-native";

/**
 * Room under the last thing in a sheet that fits its contents. iOS 26 floats
 * the sheet clear of the home indicator, so the bottom safe area would only be
 * empty space inside it; Android's sheet still runs to the screen's edge.
 */
export function sheetBottom(safeBottom: number): number {
  return Platform.OS === "ios" ? 8 : safeBottom + 16;
}
