import { memo, useMemo } from "react";
import { Platform, useColorScheme } from "react-native";
import { openLink, useLinkBase } from "@/lib/links";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import { palette, type Palette } from "@/theme/colors";
import { mono, type } from "@/theme/type";

function markdownStyle(p: Palette, dark: boolean, variant: "chat" | "thought"): MarkdownStyle {
  const body =
    variant === "thought"
      ? { fontSize: type.subhead.fontSize, lineHeight: 21, color: p.secondaryLabel }
      : { fontSize: type.chat.fontSize, lineHeight: type.chat.lineHeight, color: p.label };
  return {
    paragraph: { ...body, marginBottom: 10 },
    h1: { ...body, fontSize: 22, lineHeight: 28, fontWeight: "700", marginTop: 6, marginBottom: 8 },
    h2: { ...body, fontSize: 19, lineHeight: 25, fontWeight: "700", marginTop: 6, marginBottom: 6 },
    h3: { ...body, fontSize: 17, lineHeight: 23, fontWeight: "600", marginTop: 4, marginBottom: 4 },
    h4: { ...body, fontWeight: "600", marginBottom: 4 },
    h5: { ...body, fontWeight: "600", marginBottom: 4 },
    h6: { ...body, fontWeight: "600", color: p.secondaryLabel, marginBottom: 4 },
    list: { ...body, bulletColor: p.secondaryLabel, markerColor: p.secondaryLabel, gapWidth: 8, marginLeft: 18, itemSpacing: 4, marginBottom: 10 },
    blockquote: { ...body, color: p.secondaryLabel, borderColor: p.quote, borderWidth: 3, gapWidth: 12, marginBottom: 10 },
    // Android resolves a named family through React Native's font manager, where "monospace"
    // falls back to the proportional default; empty means the library's own monospace.
    // The border matches the fill: the library's default is a pink outline.
    code: {
      fontFamily: Platform.OS === "android" ? "" : mono,
      fontSize: 14,
      color: p.inlineCode,
      backgroundColor: p.inlineCodeBackground,
      borderColor: p.inlineCodeBackground,
    },
    codeBlock: {
      fontFamily: mono,
      fontSize: 13,
      lineHeight: 19,
      color: p.codeText,
      backgroundColor: p.code,
      borderColor: p.codeBorder,
      borderWidth: 1,
      borderRadius: 14,
      padding: 12,
      marginBottom: 12,
      syntaxColors: dark
        ? { keyword: "#c6a8ff", string: "#7fddb4", number: "#f2b978", comment: "#70717f", function: "#8fb4ff", type: "#f0c674", constant: "#f2b978", property: "#9fd4ff", tag: "#ff9a9a", attribute: "#f2b978" }
        : { keyword: "#7c4ddb", string: "#0b7a5a", number: "#b35900", comment: "#9394a0", function: "#3556db", type: "#a0620a", constant: "#b35900", property: "#1e6ea8", tag: "#c2362f", attribute: "#b35900" },
    },
    link: { color: p.accent, underline: false },
    strong: { color: variant === "thought" ? p.secondaryLabel : p.label },
    table: {
      fontSize: 14,
      color: p.label,
      borderColor: p.separator,
      borderRadius: 12,
      headerBackgroundColor: p.tableHeader,
      // The library's defaults are light-only (white rows, near-black header text).
      headerTextColor: p.label,
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: p.inlineCodeBackground,
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 7,
      marginBottom: 12,
    },
    thematicBreak: { color: p.separator, height: 1, marginTop: 8, marginBottom: 14 },
    taskList: { checkedColor: p.accent, borderColor: p.tertiaryLabel, checkmarkColor: "#ffffff", checkboxSize: 16, checkedTextColor: p.secondaryLabel },
  };
}


/** Agent markdown, rendered natively; the tail fades in while it streams. */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  variant = "chat",
}: {
  text: string;
  streaming?: boolean;
  variant?: "chat" | "thought";
}) {
  const dark = useColorScheme() === "dark";
  const base = useLinkBase();
  const style = useMemo(() => markdownStyle(dark ? palette.dark : palette.light, dark, variant), [dark, variant]);
  return (
    <EnrichedMarkdownText
      allowFontScaling={false}
      maxFontSizeMultiplier={1}
      markdown={text}
      flavor="github"
      markdownStyle={style}
      streamingAnimation={streaming}
      enableTaskListItemToggle={false}
      selectionColor={dark ? palette.dark.accent : palette.light.accent}
      onLinkPress={({ url }) => openLink(url, base)}
    />
  );
});
