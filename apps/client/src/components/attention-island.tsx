import type { LiveActivityPayload } from "../../modules/link-layout";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import { phaseLabel, type AttentionPhase } from "@/lib/session-attention";
import { agentLook } from "@/theme/agents";
import brandColors from "@/theme/brand-colors.json";
import { radius, type } from "@/theme/type";
import { AgentTile } from "./agent-tile";
import { Icon } from "./icon";
import { StatusDot } from "./status";

/** The island is dark in both appearances, like the Dynamic Island it mirrors: it takes the dark half of each pair. */
const onDark = (name: keyof typeof brandColors) => brandColors[name][1];

/** Anything waiting on the user is amber, approval or question alike; done and offline are grey. */
function phaseAccent(phase: AttentionPhase) {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return onDark("waiting");
    case "failed":
      return onDark("danger");
    case "running":
    case "starting":
      return onDark("running");
    case "completed":
    case "stale":
      return onDark("tertiaryLabel");
  }
}

export interface AttentionIslandProps {
  payload: LiveActivityPayload;
  onOpenHero: () => void;
}

/**
 * Interactive Dynamic Island / Live Activity summary capsule on the Home screen.
 * Mirrors the single-card 7-phase attention aggregation sent to iOS ActivityKit,
 * and shows "离线" (`stale`) when the computer is out of reach.
 */
export function AttentionIsland({ payload, onOpenHero }: AttentionIslandProps) {
  const [expanded, setExpanded] = useState(false);
  if (!payload.active || !payload.phase) return null;

  const phase = payload.phase;
  const accent = phaseAccent(phase);
  const resting = phase === "completed" || phase === "stale";
  const label = phaseLabel(phase);
  const waiting = payload.waitingCount ?? 0;
  const running = payload.runningCount ?? 0;
  const failed = payload.failedCount ?? 0;
  const extraCount = Math.max(0, waiting + running + failed - 1);
  const agentName = payload.agent === "terminal" ? "终端" : agentLook(payload.agent ?? "").short;

  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={{ paddingBottom: 8 }}>
      <Pressable
        onPress={() => {
          haptics.selection();
          if (expanded) onOpenHero();
          else setExpanded(true);
        }}
        onLongPress={() => {
          haptics.medium();
          setExpanded((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityLabel={`实时活动：${label}，${payload.title ?? ""}`}
        accessibilityHint={expanded ? "点击打开该会话" : "点击展开实时活动详情"}
        style={({ pressed }) => ({
          backgroundColor: "#141418",
          // A capsule while it is one line (half its 40 pt height or more), a panel once expanded.
          borderRadius: radius.panel,
          borderCurve: "continuous",
          paddingHorizontal: 14,
          paddingVertical: expanded ? 12 : 9,
          gap: expanded ? 10 : 0,
          opacity: pressed ? 0.6 : 1,
          boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {payload.agent && payload.agent !== "terminal" ? (
            <AgentTile agent={payload.agent} size={22} />
          ) : (
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 22 * 0.26,
                borderCurve: "continuous",
                backgroundColor: "rgba(255,255,255,0.12)",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon sf="terminal" md="terminal" size={12} color="#ffffff" />
            </View>
          )}
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <StatusDot color={accent} />
            <Text numberOfLines={1} style={[type.caption, { color: resting ? onDark("secondaryLabel") : accent, fontWeight: "600" }]}>
              {label}
            </Text>
            <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: "#f3f3f7", fontWeight: "600" }]}>
              {payload.title}
            </Text>
          </View>
          {extraCount > 0 ? (
            <View
              style={{
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: radius.chip,
                borderCurve: "continuous",
                backgroundColor: "rgba(255,255,255,0.14)",
              }}
            >
              <Text style={[type.caption2, { fontWeight: "600", color: "#d1d1d8", fontVariant: ["tabular-nums"] }]}>
                +{extraCount}
              </Text>
            </View>
          ) : null}
          <Icon
            sf={expanded ? "arrow.up.forward.circle.fill" : "chevron.down"}
            md={expanded ? "open_in_new" : "expand_more"}
            size={expanded ? 16 : 12}
            color="#a6a7b3"
          />
        </View>

        {expanded ? (
          <View style={{ gap: 8, paddingTop: 2 }}>
            {payload.subtitle ? (
              <Text numberOfLines={2} style={[type.footnote, { color: "#c8c9d4" }]}>
                {payload.subtitle}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text numberOfLines={1} style={[type.caption, { color: "#8e8f9e", flex: 1 }]}>
                {[payload.computerName, payload.project, agentName].filter(Boolean).join(" · ")}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {waiting > 0 ? (
                  <Text style={[type.caption, { color: onDark("waiting"), fontWeight: "600" }]}>{waiting} 等你处理</Text>
                ) : null}
                {failed > 0 ? (
                  <Text style={[type.caption, { color: onDark("danger"), fontWeight: "600" }]}>{failed} 出错</Text>
                ) : null}
                {running > 0 ? (
                  <Text style={[type.caption, { color: onDark("running"), fontWeight: "600" }]}>{running} 运行中</Text>
                ) : null}
                <Pressable
                  onPress={() => {
                    haptics.selection();
                    setExpanded(false);
                  }}
                  hitSlop={8}
                  style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: "rgba(255,255,255,0.12)", opacity: pressed ? 0.6 : 1 })}
                >
                  <Text style={[type.caption, { color: "#d1d1d8", fontWeight: "600" }]}>收起</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
