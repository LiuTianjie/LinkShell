import { Platform } from "react-native";

export interface SheetBottomOptions {
  /** Compact floating sheet (`fitToContents`) that floats above the home indicator on iOS 26+. */
  floating?: boolean;
  /** Full-height detent (`1`) sheet that extends to the bottom edge even on iOS 26+. */
  fullHeight?: boolean;
  /** Override iOS major version (for unit tests). */
  iosMajorVersion?: number;
  /** Override platform OS (for unit tests). */
  platformOS?: string;
}

function resolveIOSMajorVersion(override?: number): number {
  if (override !== undefined) return override;
  const raw = typeof Platform.Version === "string" ? parseInt(Platform.Version, 10) : Number(Platform.Version);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Room under the last thing in a sheet. Only iOS 26+ floating compact sheets sit
 * clear of the home indicator; iOS 16–18 sheets, full-height detent `1` sheets,
 * and Android sheets run to the screen's bottom edge and must reserve safeBottom.
 */
export function sheetBottom(safeBottom: number, options: SheetBottomOptions = {}): number {
  const bottom = Math.max(0, safeBottom);
  const os = options.platformOS ?? Platform.OS;
  if (os !== "ios") return bottom + 16;
  const major = resolveIOSMajorVersion(options.iosMajorVersion);
  if (major >= 26 && options.floating === true && !options.fullHeight) {
    return 8;
  }
  return bottom + 16;
}
