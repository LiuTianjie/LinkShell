import { Color } from "expo-router";
import { Appearance, DynamicColorIOS, Platform, type ColorValue } from "react-native";
import brandColors from "./brand-colors.json";

// iOS keeps native semantic colors. Android uses the matching brand palette
// as literals, resolved whenever a component reads a color during rendering.

/**
 * iOS system colours (they adapt to contrast settings and liquid glass). On
 * Android uses the same explicit light/dark values rather than Material
 * dynamic colour, so both platforms share one look.
 */
function system(ios: ColorValue, android: BrandName, web: string): ColorValue {
  if (Platform.OS === "ios") return ios;
  if (Platform.OS === "android") return brandColors[android][Appearance.getColorScheme() === "dark" ? 1 : 0];
  return web;
}

type BrandName = keyof typeof brandColors;

/**
 * LinkShell's own tints, light/dark. iOS resolves them with DynamicColorIOS;
 * Android's getters below select the same pair from the current appearance.
 */
function brand(name: BrandName): ColorValue {
  const [light, dark] = brandColors[name];
  if (Platform.OS === "ios") return DynamicColorIOS({ light, dark });
  return light;
}

const nativeColors = {
  label: system(Color.ios.label, "label", "#101014"),
  secondaryLabel: system(Color.ios.secondaryLabel, "secondaryLabel", "#5e5f6a"),
  tertiaryLabel: system(Color.ios.tertiaryLabel, "tertiaryLabel", "#9394a0"),
  placeholder: system(Color.ios.placeholderText, "placeholder", "#9394a0"),
  separator: system(Color.ios.separator, "separator", "#d9d9e0"),

  background: system(Color.ios.systemGroupedBackground, "background", "#f3f3f7"),
  card: system(Color.ios.secondarySystemGroupedBackground, "card", "#ffffff"),
  cardRaised: system(Color.ios.tertiarySystemGroupedBackground, "cardRaised", "#f6f6fa"),
  /**
   * Sheets sit above the page, so their surfaces are the elevated pair (iOS
   * swaps these in on its own inside a sheet; Android needs them spelled out,
   * or a dark sheet is black on black).
   */
  sheet: system(Color.ios.systemGroupedBackground, "sheet", "#f3f3f7"),
  sheetCard: system(Color.ios.secondarySystemGroupedBackground, "sheetCard", "#ffffff"),
  /** A raised surface on the plain (chat) background. */
  inset: system(Color.ios.secondarySystemBackground, "inset", "#f2f2f7"),
  plain: system(Color.ios.systemBackground, "plain", "#ffffff"),
  fill: system(Color.ios.tertiarySystemFill, "fill", "#ececf1"),
  fillStrong: system(Color.ios.secondarySystemFill, "fillStrong", "#e4e4eb"),

  accent: brand("accent"),
  onAccent: "#ffffff",
  accentSoft: brand("accentSoft"),

  running: brand("running"),
  waiting: system(Color.ios.systemOrange, "waiting", "#dc7100"),
  waitingSoft: brand("waitingSoft"),
  ok: system(Color.ios.systemGreen, "ok", "#0f9560"),
  okSoft: brand("okSoft"),
  danger: system(Color.ios.systemRed, "danger", "#dc3d3d"),
  dangerSoft: brand("dangerSoft"),

  userBubble: brand("userBubble"),
  code: brand("code"),
  codeText: brand("codeText"),
  diffAdd: brand("diffAdd"),
  diffDel: brand("diffDel"),
  diffAddText: brand("diffAddText"),
  diffDelText: brand("diffDelText"),
};

// Android's Fabric text colors are resolved/cached as integers. Recreating the
// navigation tree alone can still reuse an old PlatformColor result. Read the
// matching literal at render time instead; RootLayout remounts that tree on an
// appearance change. Getters also keep helpers from capturing the launch theme.
// iOS keeps semantic native colors (including contrast and elevated surfaces).
export const colors: typeof nativeColors = Platform.OS === "android"
  ? Object.defineProperties({ ...nativeColors }, Object.fromEntries(
      Object.entries(brandColors).map(([name, pair]) => [name, {
        enumerable: true,
        get: () => pair[Appearance.getColorScheme() === "dark" ? 1 : 0],
      }]),
    ))
  : nativeColors;

/** Plain-string colors for APIs that can't take native color objects. */
export const palette = {
  light: {
    label: "#101014",
    secondaryLabel: "#5e5f6a",
    tertiaryLabel: "#9394a0",
    accent: "#4a6cf7",
    code: "#f1f1f6",
    codeBorder: "rgba(16,16,28,0.08)",
    codeText: "#2a2b35",
    inlineCode: "#3a3b48",
    inlineCodeBackground: "rgba(16,16,28,0.06)",
    quote: "rgba(16,16,28,0.14)",
    tableHeader: "#f1f1f6",
    separator: "rgba(16,16,28,0.10)",
  },
  dark: {
    label: "#f3f3f6",
    secondaryLabel: "#a6a7b3",
    tertiaryLabel: "#70717f",
    accent: "#7d95ff",
    code: "#1c1c22",
    codeBorder: "rgba(255,255,255,0.08)",
    codeText: "#e4e4ec",
    inlineCode: "#e4e4ec",
    inlineCodeBackground: "rgba(255,255,255,0.09)",
    quote: "rgba(255,255,255,0.18)",
    tableHeader: "#1c1c22",
    separator: "rgba(255,255,255,0.10)",
  },
};

export type Palette = (typeof palette)["light"];
