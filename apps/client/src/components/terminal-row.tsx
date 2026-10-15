import type { TerminalInfo } from "@linkshell/wire";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { memo } from "react";
import { Alert, useColorScheme, View } from "react-native";
import { useConnection } from "@/lib/client";
import { baseName, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { terminalState } from "@/lib/terminals";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";
import { ListRow, type RowPosition } from "./session-row";
import { LiveDot } from "./status";

export function openTerminal(id: string) {
  router.push({ pathname: "/terminal/[id]", params: { id } });
}

function confirmDeleteTerminal(terminal: TerminalInfo, close: () => void) {
  const state = terminalState(terminal);
  Alert.alert(
    state.ended ? `删除“${state.title}”？` : `关闭并删除“${state.title}”？`,
    state.ended ? "这条终端记录会从列表里移除。" : "正在运行的终端进程会被停止，并从列表里移除。",
    [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: close,
      },
    ],
  );
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
  const { link } = useConnection();
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
      href={{ pathname: "/terminal/[id]", params: { id: terminal.id } }}
      accessibilityLabel={["终端", state.title, project, state.detail].filter(Boolean).join("，")}
      menu={[
        {
          title: "复制工作目录",
          icon: { sf: "folder", md: "folder" },
          onPress: () => {
            void Clipboard.setStringAsync(terminal.cwd);
            haptics.success();
          },
        },
        {
          title: "删除",
          icon: { sf: "trash", md: "delete" },
          destructive: true,
          onPress: () =>
            confirmDeleteTerminal(terminal, () => {
              void link
                .call("terminals.close", { terminalId: terminal.id })
                .then(() => haptics.success())
                .catch((error: unknown) => Alert.alert("删除失败", error instanceof Error ? error.message : String(error)));
            }),
        },
      ]}
    />
  );
});
