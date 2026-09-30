import { useMemo } from "react";
import { Text, useColorScheme, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { agentLook } from "@/theme/agents";
import { agentMarks } from "@/theme/agent-marks";

/** The agent's app-icon style tile, drawn from its official mark. */
export function AgentTile({ agent, size = 40, dimmed = false }: { agent: string; size?: number; dimmed?: boolean }) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const mark = agentMarks[agent];
  const look = agentLook(agent);
  const corner = size * 0.26;
  const xml = useMemo(() => (mark ? mark.svg.replaceAll("currentColor", mark.fg?.[scheme] ?? "#ffffff") : null), [mark, scheme]);

  const frame = {
    width: size,
    height: size,
    borderRadius: corner,
    borderCurve: "continuous" as const,
    overflow: "hidden" as const,
    opacity: dimmed ? 0.5 : 1,
    // A hairline keeps light tiles from dissolving into light backgrounds.
    boxShadow: scheme === "light" ? "inset 0 0 0 0.5px rgba(0,0,0,0.08)" : "inset 0 0 0 0.5px rgba(255,255,255,0.10)",
  };

  if (mark && xml && mark.full) {
    return (
      <View style={frame} accessibilityRole="image" accessibilityLabel={look.name}>
        <SvgXml xml={xml} width={size} height={size} />
      </View>
    );
  }

  const background = mark?.bg?.[scheme] ?? (scheme === "dark" ? "#3a3b44" : "#767986");
  return (
    <View
      style={[frame, { backgroundColor: background, alignItems: "center", justifyContent: "center" }]}
      accessibilityRole="image"
      accessibilityLabel={look.name}
    >
      {xml ? (
        <SvgXml xml={xml} width={size * 0.62} height={size * 0.62} />
      ) : (
        <Text style={{ color: "#ffffff", fontSize: size * 0.44, fontWeight: "700" }}>{look.name.slice(0, 1).toUpperCase()}</Text>
      )}
    </View>
  );
}
