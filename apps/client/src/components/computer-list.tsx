import { useMemo, useState } from "react";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { ComputerArt } from "./computer-art";
import { ComputerSwipe, computerRemovable } from "./computer-swipe";
import { Text } from "./fixed-text";
import { Icon } from "./icon";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { computerDescription, computerProfile } from "@/lib/computer-profile";
import { useClient, useConnection } from "@/lib/client";
import { listComputers, useComputers } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

export function ComputerList({ onSelect }: { onSelect: (key: string) => void }) {
  const { locale, pick, t } = useLocale();
  const names = useComputerNames((s) => s.names);
  const saved = useComputers((s) => s.saved);
  const live = useComputers((s) => s.live);
  const lanHosts = useComputers((s) => s.lanHosts);
  const relayStatus = useComputers((s) => s.relayStatus);
  const computers = useMemo(() => listComputers({ saved, live, lanHosts }), [saved, live, lanHosts]);
  const current = useConnection().computer.key;
  const status = useClient((s) => s.status);
  const machine = useClient((s) => s.machine);
  const [editing, setEditing] = useState(false);
  const renameCopy = pick({ zh: "改名", en: "Rename", ja: "名前を変更" });
  return (
    <View>
      <View
        style={{ paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
      >
        <Text style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
          {pick({
            zh: `可访问的电脑 · ${computers.length} 台`,
            en: `Your computers · ${computers.length}`,
            ja: `コンピュータ · ${computers.length} 台`,
          })}
        </Text>
        {computers.length ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setEditing(!editing)}
            style={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "flex-end" }}
          >
            <Text style={[type.footnote, { color: colors.accent }]}>
              {editing ? pick({ zh: "完成", en: "Done", ja: "完了" }) : pick({ zh: "编辑", en: "Edit", ja: "編集" })}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {computers.map((computer, index) => {
        const selected = current === computer.key;
        const name = computerDisplayName(computer, names);
        const gateway = computer.kind === "relay" ? relayStatus[computer.gateway] : undefined;
        const online = selected
          ? status === "online"
          : computer.kind === "relay" && gateway === "online" && computer.machine.online;
        const locked = selected ? status === "locked" : computer.kind === "relay" && computer.machine.locked;
        const connecting = selected && (status === "connecting" || status === "reconnecting");
        const label = locked
          ? pick({ zh: "需要密码", en: "Locked", ja: "ロック中" })
          : online
            ? selected
              ? t("connection.online")
              : pick({ zh: "在线", en: "Online", ja: "オンライン" })
            : connecting
              ? t("connection.connecting")
              : computer.lanReachable
                ? pick({ zh: "局域网可达", en: "On LAN", ja: "LAN で検出" })
                : !selected && (computer.kind === "direct" || gateway !== "online")
                  ? pick({ zh: "待确认", en: "Unconfirmed", ja: "未確認" })
                  : t("connection.offline");
        const profile = computerProfile(computer, saved.profiles?.[computer.key], selected ? machine : undefined);
        const subtitle = computerDescription(profile, locale);
        const rename = () => router.push({ pathname: "/rename-computer", params: { computer: computer.key } });
        return (
          <View key={computer.key}>
            {index > 0 && !selected && computers[index - 1]?.key !== current ? (
              <View style={{ marginLeft: 87, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
            ) : null}
            <ComputerSwipe
              computer={computer}
              name={name}
              enabled={!selected && computerRemovable(computer, online)}
              background={colors.sheet}
            >
              {(remove) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={[
                    name,
                    subtitle,
                    label,
                    selected ? pick({ zh: "当前电脑", en: "Selected", ja: "選択中" }) : undefined,
                  ]
                    .filter(Boolean)
                    .join("，")}
                  accessibilityActions={[
                    { name: "rename", label: renameCopy },
                    ...(remove ? [{ name: "remove", label: pick({ zh: "移除", en: "Remove", ja: "削除" }) }] : []),
                  ]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === "rename") rename();
                    else if (e.nativeEvent.actionName === "remove") remove?.();
                  }}
                  onLongPress={rename}
                  onPress={() => {
                    haptics.selection();
                    if (editing) {
                      rename();
                      return;
                    }
                    onSelect(computer.key);
                  }}
                  style={({ pressed }) => ({
                    minHeight: 82,
                    paddingHorizontal: 8,
                    paddingVertical: 10,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    backgroundColor: pressed ? colors.fill : selected ? colors.accentSoft : colors.sheet,
                    borderRadius: radius.control,
                    borderCurve: "continuous",
                  })}
                >
                  <ComputerArt profile={profile} width={66} height={52} />
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <Text numberOfLines={2} style={[type.headline, { color: colors.label }]}>
                      {name}
                    </Text>
                    {subtitle ? (
                      <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>
                        {subtitle}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "31%" }}>
                    {editing ? (
                      <Icon sf="pencil" md="edit" size={16} color={colors.accent} />
                    ) : selected ? (
                      <Icon sf="checkmark" md="check" size={15} color={colors.accent} />
                    ) : online ? (
                      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.ok }} />
                    ) : null}
                    <Text
                      numberOfLines={2}
                      style={[
                        type.footnote,
                        { flexShrink: 1, color: selected ? colors.accent : colors.secondaryLabel },
                      ]}
                    >
                      {editing ? renameCopy : label}
                    </Text>
                  </View>
                </Pressable>
              )}
            </ComputerSwipe>
          </View>
        );
      })}
      {!computers.length ? (
        <Text style={[type.subhead, { padding: 16, textAlign: "center", color: colors.secondaryLabel }]}>
          {pick({
            zh: "还没有电脑，登录同一账号或添加一台电脑。",
            en: "No computers yet. Sign in to the same account or add a computer.",
            ja: "同じアカウントでログインするか、コンピュータを追加してください。",
          })}
        </Text>
      ) : null}
    </View>
  );
}
