import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ComputerArt } from "@/components/computer-art";
import { Text } from "@/components/fixed-text";
import { useClient, useConnection } from "@/lib/client";
import { listComputers, useComputers } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const platforms: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

export function ComputerList({ onSelect }: { onSelect?: () => void }) {
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const relayStatus = useComputers((state) => state.relayStatus);
  const computers = useMemo(() => listComputers({ saved, live }), [saved, live]);
  const { computer: current } = useConnection();
  const status = useClient((state) => state.status);
  const machine = useClient((state) => state.machine);
  return (
    <View>
      {computers.map((computer, index) => {
        const selected = computer.key === current.key;
        const name = computer.kind === "relay" ? computer.machine.name : computer.name;
        const gateway = computer.kind === "relay" ? relayStatus[computer.gateway] : undefined;
        const online = selected ? status === "online" : computer.kind === "relay" && computer.machine.online && gateway === "online";
        const connecting = selected && (status === "connecting" || status === "reconnecting");
        // Gateway presence says a host is reachable, not that its RPC connection is ready.
        const stateLabel = online ? selected ? "已连接" : "在线" : connecting ? "正在连接…"
          : selected ? "未连接" : computer.kind === "direct" ? "局域网连接"
          : gateway !== "online" ? "状态待确认" : "离线";
        const platform = selected ? machine?.platform : computer.kind === "relay" ? computer.machine.platform : undefined;
        return (
          <View key={computer.key}>
            {index > 0 ? <View style={{ marginLeft: 52, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${name}，${stateLabel}${selected ? "，当前电脑" : ""}`}
              accessibilityState={{ selected }}
              onPress={() => { haptics.selection(); useComputers.getState().select(computer.key); onSelect?.(); }}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 72, paddingVertical: 12, borderRadius: 12, backgroundColor: pressed ? colors.fill : "transparent" })}
            >
              <ComputerArt name={name} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text numberOfLines={2} style={[type.headline, { flex: 1, color: colors.label }]}>{name}</Text>
                  {selected ? <Text style={[type.subhead, { color: colors.secondaryLabel }]}>当前</Text> : null}
                </View>
                <Text numberOfLines={2} style={[type.subhead, { color: colors.secondaryLabel }]}>{[platform ? platforms[platform] : undefined, stateLabel].filter(Boolean).join(" · ")}</Text>
              </View>
            </Pressable>
          </View>
        );
      })}
      {computers.length === 0 ? (
        <View style={{ alignItems: "center", paddingVertical: 32, gap: 12 }}>
          <ComputerArt name="" size={64} />
          <Text style={[type.headline, { color: colors.label }]}>添加你的第一台电脑</Text>
          <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>在电脑上登录同一账号，或添加电脑进行配对。</Text>
        </View>
      ) : null}
    </View>
  );
}
