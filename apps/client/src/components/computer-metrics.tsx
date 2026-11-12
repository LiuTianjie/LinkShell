import {
  MACHINE_METRICS_HISTORY_LIMIT,
  MACHINE_METRICS_INTERVAL_MS,
  type KeepAwakeMode,
  type MachineKeepAwake,
  type MachineMetrics,
  type MachinePower,
} from "@linkshell/wire";
import { dateLocaleTag } from "@linkshell/client-core";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import Svg, { Circle, G, Line, Path } from "react-native-svg";
import { useConnection } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { metricPercent, useMachineMetrics } from "@/lib/machine-metrics";
import { colors, palette } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { Button } from "./button";
import { Text } from "./fixed-text";
import { Icon } from "./icon";
import { PressableFeedback } from "./pressable-feedback";

const percent = (value: number | null) => (value == null ? "—" : `${Math.round(value)}%`);

export function isHostLowBattery(power?: MachinePower | null): boolean {
  if (!power) return false;
  return Boolean(power.onBattery && !power.charging && power.percent !== null && power.percent < 20);
}

function History({ history }: { history: MachineMetrics[] }) {
  const tint = palette[useColorScheme() === "dark" ? "dark" : "light"];
  const latest = history.at(-1)?.sampledAt;
  const samples = Array<MachineMetrics | undefined>(MACHINE_METRICS_HISTORY_LIMIT).fill(undefined);
  if (latest !== undefined) {
    for (const sample of history) {
      const index = MACHINE_METRICS_HISTORY_LIMIT - 1 - Math.round((latest - sample.sampledAt) / MACHINE_METRICS_INTERVAL_MS);
      if (index >= 0 && index < samples.length) samples[index] = sample;
    }
  }
  const series = (kind: "cpu" | "memory") => {
    const paths: { d: string; x: number; y: number }[] = [];
    let d = "";
    let x = 0;
    let y = 0;
    for (let column = 0; column < samples.length; column++) {
      const sample = samples[column];
      const value = sample ? (kind === "cpu" ? sample.cpu.usage : metricPercent(sample.memory.usedBytes, sample.memory.totalBytes)) : null;
      if (value === null) {
        if (d) paths.push({ d, x, y });
        d = "";
        continue;
      }
      x = 3 + column * 10;
      y = 61 - value * 0.58;
      d += `${d ? " L" : "M"}${x} ${y}`;
    }
    if (d) paths.push({ d, x, y });
    const color = kind === "cpu" ? tint.accent : tint.secondaryLabel;
    return paths.map((path, index) => (
      <G key={`${kind}-${index}`}>
        <Path d={path.d} stroke={color} strokeWidth={1.5} fill="none" />
        <Circle cx={path.x} cy={path.y} r={1.75} fill={color} />
      </G>
    ));
  };
  return (
    <Svg width="100%" height={64} viewBox="0 0 236 64" preserveAspectRatio="none" accessible={false}>
      {[3, 32, 61].map((y) => (
        <Line key={y} x1={0} x2={236} y1={y} y2={y} stroke={tint.separator} strokeWidth={0.5} />
      ))}
      {series("cpu")}
      {series("memory")}
    </Svg>
  );
}

function ResourceRow({
  label,
  value,
  detail,
  warn,
}: {
  label: string;
  value: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <View
      style={{
        minHeight: 44,
        paddingVertical: 11,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.separator,
      }}
    >
      <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0, gap: 3, alignItems: "flex-end" }}>
        <Text
          style={[
            type.subhead,
            {
              maxWidth: "100%",
              color: warn ? colors.danger : colors.label,
              fontWeight: warn ? "600" : "400",
              textAlign: "right",
              fontVariant: ["tabular-nums"],
            },
          ]}
        >
          {value}
        </Text>
        {detail ? (
          <Text style={[type.caption, { maxWidth: "100%", color: colors.secondaryLabel, textAlign: "right", fontVariant: ["tabular-nums"] }]}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function ComputerMetrics() {
  const { link } = useConnection();
  const { locale, t, pick } = useLocale();
  const { metrics, history, online, locked, unavailable, error, retry } = useMachineMetrics();
  const [expanded, setExpanded] = useState(false);
  const [keepAwakeOverride, setKeepAwakeOverride] = useState<MachineKeepAwake | null>(null);
  const [switchingKeepAwake, setSwitchingKeepAwake] = useState(false);

  const gib = (bytes: number) =>
    `${(bytes / 1024 ** 3).toLocaleString(dateLocaleTag(locale), { maximumFractionDigits: 1 })} GB`;

  useEffect(() => {
    if (metrics?.keepAwake) setKeepAwakeOverride(metrics.keepAwake);
  }, [metrics?.keepAwake]);

  useEffect(() => {
    if (!online || metrics?.keepAwake) return;
    let cancelled = false;
    link
      .call("machine.keepAwake", {}, 10_000)
      .then((res) => {
        if (!cancelled) setKeepAwakeOverride(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [link, online, metrics?.keepAwake]);

  const keepAwake = keepAwakeOverride ?? metrics?.keepAwake;
  const power = metrics?.power;
  const lowBattery = isHostLowBattery(power);

  const setKeepAwakeMode = async (mode: KeepAwakeMode) => {
    if (switchingKeepAwake || !online) return;
    setSwitchingKeepAwake(true);
    try {
      const updated = await link.call("machine.keepAwake", { mode }, 10_000);
      setKeepAwakeOverride(updated);
      haptics.selection();
    } catch (reason) {
      haptics.error();
      Alert.alert(
        t("power.keepAwake"),
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setSwitchingKeepAwake(false);
    }
  };

  const powerValue = (() => {
    if (!power) return null;
    if (power.percent === null) return t("power.pluggedIn");
    const pct = Math.round(power.percent);
    if (power.charging) return t("power.charging", { percent: pct });
    if (power.onBattery) return t("power.onBattery", { percent: pct });
    return `${t("power.pluggedIn")} · ${pct}%`;
  })();

  const status = locked
    ? pick({ zh: "解锁后查看资源使用", en: "Unlock to view system metrics", ja: "ロック解除後にリソースを表示" })
    : !online
      ? pick({ zh: "连接电脑后查看资源使用", en: "Connect to view system metrics", ja: "PC 接続後にリソースを表示" })
      : unavailable
        ? pick({ zh: "更新电脑端后可查看资源使用", en: "Update LinkShell Host to view metrics", ja: "PC 側の更新でリソースを表示可能" })
        : error
          ? pick({ zh: "资源读取失败", en: "Failed to read metrics", ja: "リソースの取得に失敗しました" })
          : t("common.loading");

  const disk = metrics?.disk;

  const keepAwakeOptions: { mode: KeepAwakeMode; label: string; desc: string }[] = [
    { mode: "smart", label: t("power.keepAwakeSmart"), desc: t("power.keepAwakeSmartDesc") },
    { mode: "always", label: t("power.keepAwakeAlways"), desc: t("power.keepAwakeAlwaysDesc") },
    { mode: "off", label: t("power.keepAwakeOff"), desc: t("power.keepAwakeOffDesc") },
  ];

  return (
    <View style={{ gap: 12 }}>
      {lowBattery && power?.percent !== null && power?.percent !== undefined ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 14,
            paddingVertical: 11,
            borderRadius: radius.card,
            borderCurve: "continuous",
            backgroundColor: colors.dangerSoft,
          }}
        >
          <Icon sf="battery.25" md="battery_alert" size={18} color={colors.danger} />
          <Text style={[type.footnote, { flex: 1, color: colors.danger, fontWeight: "600" }]}>
            {t("power.lowBatteryWarning", { percent: Math.round(power.percent) })}
          </Text>
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={[type.subhead, { fontWeight: "600", color: colors.secondaryLabel, paddingHorizontal: 6 }]}>
          {pick({ zh: "资源与电源", en: "System & Power", ja: "システムと電源" })}
        </Text>
        <View style={{ paddingHorizontal: 16, backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}>
          {metrics ? (
            <>
              <ResourceRow label="CPU" value={percent(metrics.cpu.usage)} />
              <ResourceRow
                label={pick({ zh: "内存", en: "Memory", ja: "メモリ" })}
                value={percent(metricPercent(metrics.memory.usedBytes, metrics.memory.totalBytes))}
                detail={`${gib(metrics.memory.usedBytes)} / ${gib(metrics.memory.totalBytes)}`}
              />
              <ResourceRow
                label={pick({ zh: "磁盘", en: "Disk", ja: "ディスク" })}
                value={disk ? `${gib(disk.usedBytes)} / ${gib(disk.totalBytes)}` : "—"}
                detail={
                  disk
                    ? pick({
                        zh: `可用 ${gib(disk.availableBytes)}`,
                        en: `${gib(disk.availableBytes)} free`,
                        ja: `空き ${gib(disk.availableBytes)}`,
                      })
                    : undefined
                }
              />
              {powerValue ? (
                <ResourceRow
                  label={pick({ zh: "电源", en: "Power", ja: "電源" })}
                  value={powerValue}
                  warn={lowBattery}
                />
              ) : null}
              <PressableFeedback
                onPress={() => setExpanded((value) => !value)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={pick({ zh: "使用趋势与详情", en: "Trends & Details", ja: "推移と詳細" })}
                style={{ marginHorizontal: -16, paddingHorizontal: 16, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
              >
                <Text style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
                  {pick({ zh: "使用趋势与详情", en: "Trends & Details", ja: "推移と詳細" })}
                </Text>
                <Icon sf={expanded ? "chevron.up" : "chevron.down"} md={expanded ? "expand_less" : "expand_more"} size={14} color={colors.tertiaryLabel} />
              </PressableFeedback>
              {expanded ? (
                <View style={{ gap: 12, paddingBottom: 16 }}>
                  <View style={{ gap: 4 }}>
                    <View style={{ flexDirection: "row", gap: 12 }}>
                      <Text style={[type.caption, { color: colors.accent }]}>CPU</Text>
                      <Text style={[type.caption, { color: colors.secondaryLabel }]}>
                        {pick({ zh: "内存", en: "Memory", ja: "メモリ" })}
                      </Text>
                    </View>
                    <History history={history} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                      <Text style={[type.caption, { color: colors.secondaryLabel }]}>
                        {pick({ zh: "最近 2 分钟", en: "2 min ago", ja: "2分前" })}
                      </Text>
                      <Text style={[type.caption, { color: colors.secondaryLabel }]}>
                        {pick({ zh: "现在", en: "Now", ja: "現在" })}
                      </Text>
                    </View>
                  </View>
                  <Text selectable style={[type.caption, { color: colors.secondaryLabel }]}>
                    {metrics.cpu.model} · {metrics.cpu.cores} cores
                  </Text>
                  {disk ? (
                    <Text selectable style={[type.caption, { color: colors.secondaryLabel }]}>
                      {disk.path} · {percent(metricPercent(disk.usedBytes, disk.totalBytes))}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </>
          ) : (
            <View style={{ gap: 8, paddingVertical: 16 }}>
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{status}</Text>
              {error && !unavailable ? (
                <>
                  <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{error}</Text>
                  <View style={{ alignSelf: "flex-start" }}>
                    <Button title={t("common.retry")} variant="plain" size="small" onPress={retry} />
                  </View>
                </>
              ) : null}
            </View>
          )}
        </View>
      </View>

      {online && keepAwake ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 6 }}>
            <Text accessibilityRole="header" style={[type.subhead, { fontWeight: "600", color: colors.secondaryLabel }]}>
              {t("power.keepAwake")}
            </Text>
            <Text style={[type.caption, { color: keepAwake.active ? colors.ok : colors.tertiaryLabel, fontWeight: "600" }]}>
              {keepAwake.active ? t("power.keepAwakeActive") : t("power.keepAwakeIdle")}
            </Text>
          </View>
          <View style={{ backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", paddingHorizontal: 14, paddingVertical: 8, gap: 4 }}>
            {keepAwakeOptions.map((opt, idx) => {
              const selected = keepAwake.mode === opt.mode;
              return (
                <Pressable
                  key={opt.mode}
                  disabled={switchingKeepAwake}
                  onPress={() => void setKeepAwakeMode(opt.mode)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingVertical: 10,
                    borderTopWidth: idx === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: colors.separator,
                    opacity: pressed ? 0.65 : 1,
                  })}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[type.subhead, { color: colors.label, fontWeight: selected ? "600" : "400" }]}>
                      {opt.label}
                    </Text>
                    <Text style={[type.caption, { color: colors.secondaryLabel }]}>{opt.desc}</Text>
                  </View>
                  <Icon
                    sf={selected ? "checkmark.circle.fill" : "circle"}
                    md={selected ? "radio_button_checked" : "radio_button_unchecked"}
                    size={18}
                    color={selected ? colors.accent : colors.tertiaryLabel}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}
