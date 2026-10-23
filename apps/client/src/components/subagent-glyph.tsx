import { useId, useMemo } from "react";
import { useColorScheme } from "react-native";
import { SvgXml } from "react-native-svg";
import { subagentGlyphs } from "@/theme/subagent-glyphs";

// Always use the spawning call identity: native IDs can arrive after the first render.
function glyphIndex(sessionId: string | undefined, toolCallId: string): number {
  const identity = JSON.stringify([sessionId ?? "", toolCallId]);
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % 16;
}

export function SubagentGlyph({ sessionId, toolCallId, size }: { sessionId: string | undefined; toolCallId: string; size: number }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const instance = useId();
  const source = subagentGlyphs[glyphIndex(sessionId, toolCallId)]![scheme];
  const xml = useMemo(() => {
    // Each mounted SVG needs its own paint servers, even when the glyph repeats.
    const prefix = `agent-${instance.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    return source.replace(/id="([^"]+)"/g, `id="${prefix}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`);
  }, [source, instance]);
  return <SvgXml xml={xml} width={size} height={size} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}
