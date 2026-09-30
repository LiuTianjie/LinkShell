import type { TerminalInfo } from "@linkshell/wire";
import { router } from "expo-router";
import { memo } from "react";
import { useColorScheme, View } from "react-native";
import { baseName, relativeTime } from "@/lib/format";
import { terminalState } from "@/lib/terminals";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";
import { ListRow, type RowPosition } from "./session-row";
import { LiveDot } from "./status";

export function openTerminal(id: string) {
  router.push({ pathname: "/terminal/[id]", params: { id } });
}

/** A terminal's icon, sized like an agent tile: a console square. An ended one keeps its tile and greys its prompt. */
export function TerminalTile({ size = 20, dimmed = false, busy = false }: { size?: number; dimmed?: boolean; busy?: boolean }) {
  const dark = useColorScheme() === "dark";
  const dot = Math.max(6, Math.round(size * 0.22));
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.26,
          borderCurve: "continuous",
          // Lifted off dark cards so it never sinks into them.
          backgroundColor: dark ? "#2c2d35" : "#1d1e24",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon sf="chevron.right" md="chevron_right" size={size * 0.56} color={dimmed ? "#8b8d98" : "#7fddb4"} weight="bold" />
      </View>
      {busy ? (
        <View style={{ position: "absolute", right: -4, bottom: -4, padding: 1.5, borderRadius: dot, backgroundColor: colors.card }}>
          <LiveDot size={dot} />
        </View>
      ) : null}
    </View>
  );
}

export const TerminalRow = memo(function TerminalRow({
  terminal,
  position = "only",
  showProject = true,
  now,
}: {
  terminal: TerminalInfo;
  position?: RowPosition;
  showProject?: boolean;
  now: number;
}) {
  const state = terminalState(terminal);
  const project = showProject ? baseName(terminal.cwd) : undefined;
  return (
    <ListRow
      leading={<TerminalTile busy={state.busy} dimmed={state.ended} />}
      title={state.title}
      titleMono={state.mono}
      time={relativeTime(terminal.activeAt, now)}
      project={project}
      detail={state.detail}
      detailColor={state.busy ? colors.running : state.failed ? colors.danger : colors.secondaryLabel}
      warn={state.failed}
      position={position}
      onPress={() => openTerminal(terminal.id)}
      accessibilityLabel={["终端", state.title, project, state.detail].filter(Boolean).join("，")}
    />
  );
});
