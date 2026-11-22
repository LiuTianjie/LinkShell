import { router, Stack } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SessionSummary } from "@linkshell/wire";
import { usePageInsets } from "@/components/adaptive-page";
import { AgentTile } from "@/components/agent-tile";
import { Button } from "@/components/button";
import { ComputerArt } from "@/components/computer-art";
import { useComputerPresentation } from "@/components/computer-controls";
import { formatConnectionDetail } from "@/components/connection-banner";
import { Text } from "@/components/fixed-text";
import { IOS_TAB_BAR_HEIGHT, useFloatingTabInset } from "@/components/floating-tabs";
import { Icon } from "@/components/icon";
import { isHostLowBattery } from "@/components/computer-metrics";
import { openPreview } from "@/components/port-row";
import { openSession } from "@/components/session-row";
import { LinkDot, StatusDot, stateColor } from "@/components/status";
import { Welcome } from "@/components/welcome";
import { useActions, useClient, useConnection, useConnectionStatus, useHasComputer } from "@/lib/client";
import { platformLabel } from "@/lib/computer-profile";
import { useContentWidth } from "@/lib/content-width";
import { needsAttention, sessionTitle } from "@/lib/describe";
import { baseName } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { useMachineMetrics } from "@/lib/machine-metrics";
import { usePorts } from "@/lib/ports";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

function priority(s: SessionSummary) {
  return needsAttention(s) ? 2 : s.state === "running" ? 1 : 0;
}
function featured(sessions: Record<string, SessionSummary>) {
  let best: SessionSummary | undefined;
  for (const s of Object.values(sessions)) {
    if (s.archived) continue;
    if (!best || priority(s) > priority(best) || (priority(s) === priority(best) && s.updatedAt > best.updatedAt))
      best = s;
  }
  return best;
}

function Workspace() {
  const sessions = useClient((s) => s.sessions);
  const loaded = useClient((s) => s.sessionsLoaded);
  const session = useMemo(() => featured(sessions), [sessions]);
  const { ports, error } = usePorts();
  const { t, pick } = useLocale();
  const active = session && priority(session) > 0;
  const phase =
    session &&
    (needsAttention(session)
      ? pick({ zh: "等你处理", en: "Needs attention", ja: "対応待ち" })
      : session.state === "running"
        ? pick({ zh: "运行中", en: "Running", ja: "実行中" })
        : session.state === "error"
          ? pick({ zh: "出错", en: "Error", ja: "エラー" })
          : pick({ zh: "最近会话", en: "Recent session", ja: "最近のセッション" }));
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text accessibilityRole="header" style={[type.title, { flex: 1, color: colors.label }]}>
          {active || !session
            ? pick({ zh: "当前工作", en: "On this computer", ja: "現在の作業" })
            : pick({ zh: "最近工作", en: "Recent work", ja: "最近の作業" })}
        </Text>
        <TextLink
          title={pick({ zh: "主机详情", en: "Details", ja: "詳細" })}
          onPress={() => router.push("/computer-details")}
        />
      </View>
      {session ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => openSession(session.id)}
          style={({ pressed }) => [styles.workRow, { backgroundColor: pressed ? colors.fill : "transparent" }]}
        >
          <AgentTile agent={session.agent} size={36} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text numberOfLines={2} style={[type.headline, { color: colors.label }]}>
              {sessionTitle(session)}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <StatusDot color={needsAttention(session) ? colors.waiting : stateColor(session.state)} />
              <Text numberOfLines={1} style={[type.footnote, { flexShrink: 1, color: colors.secondaryLabel }]}>
                {[phase, baseName(session.cwd)].filter(Boolean).join(" · ")}
              </Text>
            </View>
          </View>
          <Chevron />
        </Pressable>
      ) : (
        <Hint
          text={
            loaded
              ? pick({
                  zh: "这台电脑还没有会话",
                  en: "No sessions on this computer yet",
                  ja: "このコンピュータにはまだセッションがありません",
                })
              : t("common.loading")
          }
        />
      )}
      <View
        style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, marginTop: 9, paddingTop: 8 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[type.headline, { flex: 1, color: colors.label }]}>{t("nav.ports")}</Text>
          <TextLink
            title={pick({ zh: "全部", en: "All", ja: "すべて" }) + (ports ? ` ${ports.length}` : "")}
            onPress={() => router.push("/ports")}
          />
        </View>
        {ports?.slice(0, 2).map((port, i) => (
          <Pressable
            key={port.port}
            accessibilityRole="button"
            onPress={() => openPreview(port.port, port.title)}
            style={({ pressed }) => ({
              minHeight: 46,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 6,
              borderTopWidth: i ? StyleSheet.hairlineWidth : 0,
              borderColor: colors.separator,
              backgroundColor: pressed ? colors.fill : "transparent",
            })}
          >
            <Icon sf="globe" md="language" size={18} color={colors.secondaryLabel} />
            <Text numberOfLines={1} style={[type.callout, { flex: 1, color: colors.label }]}>
              {port.title || "localhost"}
            </Text>
            <Text style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
              :{port.port}
            </Text>
            <Chevron />
          </Pressable>
        ))}
        {(!ports || !ports.length) && (
          <Hint
            text={
              error ??
              (ports
                ? pick({
                    zh: "未发现可预览的服务",
                    en: "No preview services found",
                    ja: "プレビューできるサービスはありません",
                  })
                : t("common.loading"))
            }
          />
        )}
      </View>
    </>
  );
}

/** Only the grabber owns an upward gesture; the session and port rows still scroll normally. */
function DetailsGrabber() {
  const open = () => {
    haptics.selection();
    router.push("/computer-details");
  };
  const gesture = Gesture.Exclusive(
    Gesture.Pan()
      .activeOffsetY(-8)
      .failOffsetX([-18, 18])
      .runOnJS(true)
      .onEnd(({ translationY }) => {
        if (translationY < -18) open();
      }),
    Gesture.Tap()
      .runOnJS(true)
      .onEnd((_, success) => {
        if (success) open();
      }),
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible={false}
        importantForAccessibility="no"
        style={{
          alignSelf: "center",
          height: 20,
          width: 86,
          marginTop: -8,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: colors.separator }} />
      </View>
    </GestureDetector>
  );
}

function Chevron() {
  return <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.secondaryLabel} />;
}
function TextLink({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={[type.subhead, { color: colors.accent }]}>{title}</Text>
      <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.accent} />
    </Pressable>
  );
}
function Hint({ text }: { text: string }) {
  return <Text style={[type.subhead, { color: colors.secondaryLabel, paddingVertical: 12 }]}>{text}</Text>;
}

export function ComputerScreen() {
  const { computer } = useConnection();
  return <ComputerWorkspace key={computer.key} />;
}

function ComputerWorkspace() {
  const { t, pick } = useLocale();
  const { name, profile, transport } = useComputerPresentation();
  const { link } = useConnection();
  const { refresh } = useActions();
  const status = useConnectionStatus();
  const online = useClient((s) => s.status === "online");
  const detail = useClient((s) => s.statusDetail);
  const hasComputer = useHasComputer();
  const { metrics } = useMachineMetrics();
  const power = online ? metrics?.power : undefined;
  const connecting = status === "connecting" || status === "reconnecting";
  const [refreshing, setRefreshing] = useState(false);
  const insets = usePageInsets();
  const bottomTab = useFloatingTabInset();
  const width = useContentWidth();
  const wide = width >= 760;
  const padding = width < 360 ? 16 : 24;
  const bottom = Platform.OS === "ios" ? insets.bottom + IOS_TAB_BAR_HEIGHT + 12 : bottomTab + 12;
  const phase = online
    ? t("connection.online")
    : status === "locked"
      ? pick({ zh: "需要访问密码", en: "Access password needed", ja: "パスワードが必要" })
      : connecting
        ? t("connection.connecting")
        : t("connection.offline");
  const picker = () => {
    haptics.selection();
    router.push("/computers");
  };
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (online) await refresh();
      else link.reconnectNow(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 4 }}
        refreshControl={
          hasComputer ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void doRefresh()}
              progressViewOffset={insets.top}
            />
          ) : undefined
        }
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: padding,
            minHeight: 48,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t("nav.computer")} · ${name}`}
            onPress={picker}
            style={({ pressed }) => ({
              minHeight: 44,
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon sf="rectangle.on.rectangle" md="devices" size={18} color={colors.secondaryLabel} />
            <Text style={[type.subhead, { color: colors.secondaryLabel, fontWeight: "600" }]}>{t("nav.computer")}</Text>
            <Icon sf="chevron.down" md="expand_more" size={12} color={colors.secondaryLabel} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("nav.account")}
            onPress={() => router.push("/account")}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <View style={{ backgroundColor: colors.fill, padding: 8, borderRadius: 18 }}>
              <Icon sf="person" md="person_outline" size={18} color={colors.label} />
            </View>
          </Pressable>
        </View>
        {!hasComputer ? (
          <View style={{ paddingHorizontal: padding, paddingBottom: bottom }}>
            <Welcome />
          </View>
        ) : (
          <View
            style={{
              flex: 1,
              flexDirection: wide ? "row" : "column",
              gap: wide ? 12 : 0,
              ...(wide ? { alignItems: "flex-start", padding: 16, paddingBottom: bottom } : {}),
            }}
          >
            <View
              style={{ ...(wide ? { flex: 1 } : {}), paddingHorizontal: padding, paddingTop: 12, paddingBottom: 24 }}
            >
              <Text
                accessibilityRole="header"
                selectable
                style={[name.length > 22 ? type.title1 : type.largeTitle, { color: colors.label }]}
              >
                {name}
              </Text>
              <View style={{ minHeight: 28, flexDirection: "row", alignItems: "center", gap: 6 }}>
                <LinkDot health={online ? "online" : connecting ? "connecting" : "offline"} />
                <Text style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
                  {[phase, profile.hardwareModel?.family ?? (profile.formFactor === "mac-mini" ? "Mac mini" : platformLabel(profile.platform)), online ? transport : undefined].filter(Boolean).join(" · ")}
                </Text>
                {typeof power?.percent === "number" ? (
                  <View
                    accessible
                    accessibilityLabel={pick({
                      zh: `电量 ${Math.round(power.percent)}%`,
                      en: `Battery ${Math.round(power.percent)}%`,
                      ja: `バッテリー ${Math.round(power.percent)}%`,
                    })}
                    style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                  >
                    <Icon
                      sf={
                        power.charging
                          ? "battery.100percent.bolt"
                          : power.percent < 25
                            ? "battery.25percent"
                            : power.percent < 60
                              ? "battery.50percent"
                              : power.percent < 90
                                ? "battery.75percent"
                                : "battery.100percent"
                      }
                      md="battery_std"
                      size={15}
                      color={colors.secondaryLabel}
                    />
                    <Text
                      style={[
                        type.footnote,
                        {
                          color: isHostLowBattery(power) ? colors.danger : colors.secondaryLabel,
                          fontVariant: ["tabular-nums"],
                        },
                      ]}
                    >
                      {Math.round(power.percent)}%
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={{ alignItems: "center", justifyContent: "center", marginVertical: 14 }}>
                <ComputerArt profile={profile} width={Math.min(292, width * 0.76)} height={width < 360 ? 145 : 185} />
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
                {online ? (
                  <>
                    <Button
                      title={pick({ zh: "打开远程屏幕", en: "Remote screen", ja: "リモート画面" })}
                      icon={{ sf: "display", md: "desktop_windows" }}
                      variant="primary"
                      onPress={() => router.push("/screen")}
                    />
                    <Button
                      title={pick({ zh: "新会话", en: "New session", ja: "新規セッション" })}
                      icon={{ sf: "square.and.pencil", md: "edit" }}
                      onPress={() => router.push("/new")}
                    />
                  </>
                ) : status === "locked" ? (
                  <Button
                    title={pick({ zh: "解锁电脑", en: "Unlock computer", ja: "ロックを解除" })}
                    variant="primary"
                    onPress={() => router.push("/unlock")}
                  />
                ) : (
                  <Button
                    title={status === "connecting" ? t("connection.connecting") : t("connection.reconnect")}
                    busy={status === "connecting"}
                    variant="primary"
                    onPress={() => link.reconnectNow(true)}
                  />
                )}
              </View>
            </View>
            <View
              style={{
                flexGrow: 1,
                ...(wide
                  ? { flex: 1.15, borderRadius: radius.panel }
                  : { borderTopLeftRadius: radius.panel, borderTopRightRadius: radius.panel }),
                borderCurve: "continuous",
                paddingHorizontal: padding,
                paddingTop: 12,
                paddingBottom: wide ? 20 : bottom,
                backgroundColor: colors.card,
              }}
            >
              {online && !wide ? <DetailsGrabber /> : null}
              {online ? (
                <Workspace />
              ) : (
                <>
                  <Hint text={formatConnectionDetail(detail) ?? phase} />
                  <TextLink
                    title={pick({ zh: "连接设置", en: "Connection settings", ja: "接続設定" })}
                    onPress={() => router.push("/connect")}
                  />
                </>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </>
  );
}
const styles = StyleSheet.create({
  workRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 67,
    paddingVertical: 8,
    borderRadius: radius.control,
  },
});
