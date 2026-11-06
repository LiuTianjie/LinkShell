import { MACHINE_METRICS_HISTORY_LIMIT, MACHINE_METRICS_INTERVAL_MS, type MachineMetrics } from "@linkshell/wire";
import { useState } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";
import Svg, { Circle, G, Line, Path } from "react-native-svg";
import { Text } from "./fixed-text";
import { Button } from "./button";
import { Icon } from "./icon";
import { PressableFeedback } from "./pressable-feedback";
import { metricPercent, useMachineMetrics } from "@/lib/machine-metrics";
import { colors, palette } from "@/theme/colors";
import { radius, type } from "@/theme/type";

const percent = (value: number | null) => value == null ? "—" : `${Math.round(value)}%`;
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} GB`;

function History({ history }: { history: MachineMetrics[] }) {
  const tint = palette[useColorScheme() === "dark" ? "dark" : "light"];
  const latest = history.at(-1)?.sampledAt;
  const samples = Array<MachineMetrics | undefined>(MACHINE_METRICS_HISTORY_LIMIT).fill(undefined);
  if (latest !== undefined) for (const sample of history) {
    const index = MACHINE_METRICS_HISTORY_LIMIT - 1 - Math.round((latest - sample.sampledAt) / MACHINE_METRICS_INTERVAL_MS);
    if (index >= 0 && index < samples.length) samples[index] = sample;
  }
  const series = (kind: "cpu" | "memory") => {
    const paths: { d: string; x: number; y: number }[] = [];
    let d = "";
    let x = 0;
    let y = 0;
    for (let column = 0; column < samples.length; column++) {
      const sample = samples[column];
      const value = sample ? kind === "cpu" ? sample.cpu.usage : metricPercent(sample.memory.usedBytes, sample.memory.totalBytes) : null;
      if (value === null) { if (d) paths.push({ d, x, y }); d = ""; continue; }
      x = 3 + column * 10;
      y = 61 - value * 0.58;
      d += `${d ? " L" : "M"}${x} ${y}`;
    }
    if (d) paths.push({ d, x, y });
    const color = kind === "cpu" ? tint.accent : tint.secondaryLabel;
    return paths.map((path, index) => <G key={`${kind}-${index}`}>
      <Path d={path.d} stroke={color} strokeWidth={1.5} fill="none" />
      <Circle cx={path.x} cy={path.y} r={1.75} fill={color} />
    </G>);
  };
  return <Svg width="100%" height={64} viewBox="0 0 236 64" preserveAspectRatio="none" accessible={false}>
    {[3, 32, 61].map((y) => <Line key={y} x1={0} x2={236} y1={y} y2={y} stroke={tint.separator} strokeWidth={0.5} />)}
    {series("cpu")}{series("memory")}
  </Svg>;
}

function ResourceRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <View style={{ minHeight: 44, paddingVertical: 11, flexDirection: "row", alignItems: "flex-start", gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }}>
    <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{label}</Text>
    <View style={{ flex: 1, minWidth: 0, gap: 3, alignItems: "flex-end" }}>
      <Text style={[type.subhead, { maxWidth: "100%", color: colors.label, textAlign: "right", fontVariant: ["tabular-nums"] }]}>{value}</Text>
      {detail ? <Text style={[type.caption, { maxWidth: "100%", color: colors.secondaryLabel, textAlign: "right", fontVariant: ["tabular-nums"] }]}>{detail}</Text> : null}
    </View>
  </View>;
}

export function ComputerMetrics() {
  const { metrics, history, online, locked, unavailable, error, retry } = useMachineMetrics();
  const [expanded, setExpanded] = useState(false);
  const status = locked ? "解锁后查看资源使用" : !online ? "连接电脑后查看资源使用" : unavailable ? "更新电脑端后可查看资源使用" : error ? "资源读取失败" : "正在采样…";
  const disk = metrics?.disk;
  return <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" style={[type.subhead, { fontWeight: "600", color: colors.secondaryLabel, paddingHorizontal: 6 }]}>资源使用</Text>
    <View style={{ paddingHorizontal: 16, backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}>
      {metrics ? <>
        <ResourceRow label="CPU" value={percent(metrics.cpu.usage)} />
        <ResourceRow label="内存" value={percent(metricPercent(metrics.memory.usedBytes, metrics.memory.totalBytes))} detail={`${gib(metrics.memory.usedBytes)} / ${gib(metrics.memory.totalBytes)}`} />
        <ResourceRow label="主目录磁盘" value={disk ? `${gib(disk.usedBytes)} / ${gib(disk.totalBytes)}` : "未提供"} detail={disk ? `可用 ${gib(disk.availableBytes)}` : undefined} />
        <PressableFeedback
          onPress={() => setExpanded((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel="使用趋势与详情"
          style={{ marginHorizontal: -16, paddingHorizontal: 16, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Text style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>使用趋势与详情</Text>
          <Icon sf={expanded ? "chevron.up" : "chevron.down"} md={expanded ? "expand_less" : "expand_more"} size={14} color={colors.tertiaryLabel} />
        </PressableFeedback>
        {expanded ? <View style={{ gap: 12, paddingBottom: 16 }}>
          <View style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Text style={[type.caption, { color: colors.accent }]}>CPU</Text>
              <Text style={[type.caption, { color: colors.secondaryLabel }]}>内存</Text>
            </View>
            <History history={history} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={[type.caption, { color: colors.secondaryLabel }]}>最近 2 分钟</Text>
              <Text style={[type.caption, { color: colors.secondaryLabel }]}>现在</Text>
            </View>
          </View>
          <Text selectable style={[type.caption, { color: colors.secondaryLabel }]}>{metrics.cpu.model} · {metrics.cpu.cores} 个逻辑核心</Text>
          <Text style={[type.caption, { color: colors.secondaryLabel }]}>{metrics.memory.includesCache === false ? "整机已用物理内存，扣除可回收缓存；包含系统与压缩内存。" : "整机物理内存使用量，包含系统和缓存。"}</Text>
          <Text selectable style={[type.caption, { color: colors.secondaryLabel }]}>{disk ? `主目录所在卷 · ${disk.path} · 已用 ${percent(metricPercent(disk.usedBytes, disk.totalBytes))}` : "电脑端暂未提供磁盘数据。"}</Text>
        </View> : null}
      </> : <View style={{ gap: 8, paddingVertical: 16 }}>
        <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{status}</Text>
        {error && !unavailable ? <>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{error}</Text>
          <View style={{ alignSelf: "flex-start" }}><Button title="重试" variant="plain" size="small" onPress={retry} /></View>
        </> : null}
      </View>}
    </View>
  </View>;
}
