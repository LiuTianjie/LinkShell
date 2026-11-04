import { Platform, type TextStyle } from "react-native";

// Fixed point sizes shared by the app's text styles.
export const type = {
  /** A tab page's own title, where the system's large title isn't drawn (iOS Large Title / Title 1). */
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: "700" },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: "600" },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 22 },
  chat: { fontSize: 16, lineHeight: 23 },
  callout: { fontSize: 16, lineHeight: 21 },
  subhead: { fontSize: 15, lineHeight: 20 },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  caption2: { fontSize: 11, lineHeight: 13 },
} satisfies Record<string, TextStyle>;

export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

/**
 * The only corner radii (continuous corners): chip for badges, tags and inline
 * code; control for inputs, segmented controls and small tiles; card for list
 * groups and cards; panel for split panes and large overlays. Buttons are
 * capsules (half their height), dots and avatars circles.
 */
export const radius = { chip: 8, control: 12, card: 16, panel: 24 } as const;
