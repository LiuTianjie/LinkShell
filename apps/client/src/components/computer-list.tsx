import { useMemo } from "react";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { ComputerArt } from "@/components/computer-art";
import { Text } from "@/components/fixed-text";
import { Icon } from "@/components/icon";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { useClient, useConnection } from "@/lib/client";
import { listComputers, useComputers } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const platforms: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

export function ComputerList({ onSelect }: { onSelect?: () => void }) {
  const names = useComputerNames((state) => state.names);
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
        const name = computerDisplayName(computer, names);
        const gateway = computer.kind === "relay" ? relayStatus[computer.gateway] : undefined;
        const online = selected ? status === "online" : computer.kind === "relay" && computer.machine.online && gateway === "online";
        const connecting = selected && (status === "connecting" || status === "reconnecting");
        // Gateway presence says a host is reachable, not that its RPC connection is ready.
        const locked = computer.kind === "relay" && computer.machine.locked;
        const stateLabel = selected && status === "locked" ? "需要密码" : online ? selected ? "已连接" : "在线" : connecting ? "正在连接…"
          : selected ? "未连接" : computer.kind === "direct" ? "局域网连接"
          : gateway !== "online" ? "状态待确认" : "离线";
        const platform = selected ? machine?.platform : computer.kind === "relay" ? computer.machine.platform : undefined;
        return (
          <View key={computer.key}>
            {index > 0 ? <View style={{ marginLeft: 52, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} /> : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${name}，${stateLabel}${locked ? "，需要访问密码" : ""}${selected ? "，当前电脑" : ""}`}
              accessibilityState={{ selected }}
              onPress={() => { haptics.selection(); useComputers.getState().select(computer.key); onSelect?.(); }}
              style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 72, paddingVertical: 12, borderRadius: 12, backgroundColor: pressed ? colors.fill : "transparent" })}
            >
              <ComputerArt name={name} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text numberOfLines={2} style={[type.headline, { flex: 1, color: colors.label }]}>{name}</Text>
                  {locked ? <Icon sf="lock.fill" md="lock" size={12} color={colors.tertiaryLabel} /> : null}
                </View>
                {/* Which one is in use, on the status line: a tag beside the name sat off the row's centre line. */}
                <Text numberOfLines={2} style={[type.subhead, { color: colors.secondaryLabel }]}>
                  {selected ? <Text style={{ color: colors.accent, fontWeight: "600" }}>当前 · </Text> : null}
                  {[platform ? platforms[platform] : undefined, stateLabel].filter(Boolean).join(" · ")}
                </Text>
              </View>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`给 ${name} 改名`}
              onPress={() => { haptics.selection(); router.push({ pathname: "/rename-computer", params: { computer: computer.key } }); }}
              style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: pressed ? colors.fill : "transparent" })}>
              <Icon sf="pencil" md="edit" size={18} color={colors.secondaryLabel} />
            </Pressable>
            </View>
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
