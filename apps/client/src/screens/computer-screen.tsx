import type { AgentInfo, GatewayStatus, UsageReport } from "@linkshell/wire";
import { formatConnectionDetail } from "@/components/connection-banner";
import * as Clipboard from "expo-clipboard";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePageInsets } from "@/components/adaptive-page";
import { HeaderActions } from "@/components/header-actions";
import { hasSideToolbar } from "@/lib/home-layout";
import { Text } from "@/components/fixed-text";
import { AgentTile } from "@/components/agent-tile";
import { Button } from "@/components/button";
import { Icon, type IconProps } from "@/components/icon";
import { LinkDot } from "@/components/status";
import { PressedWash } from "@/components/pressable-feedback";
import { formatApiComputeValue } from "@/components/usage-dashboard";
import { useAccount } from "@/lib/account";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { listComputers, useComputers } from "@/lib/computers";
import { useActions, useClient, useConnection, useConnectionStatus, useHasComputer } from "@/lib/client";
import { Welcome } from "@/components/welcome";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { deviceIdentity } from "@/lib/identity";
import { useLocale } from "@/lib/locale";
import { agentCapabilityTags, agentLook, tierCopy } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { ComputerList } from "@/components/computer-list";
import { ComputerArt } from "@/components/computer-art";
import { ComputerMetrics } from "@/components/computer-metrics";
import { PortRow } from "@/components/port-row";
import { ListRow } from "@/components/session-row";
import { usePorts } from "@/lib/ports";
import { PageActionButton, StatusBarFade, type PageAction } from "@/components/page-header";
import { useContentWidth } from "@/lib/content-width";

const authMethod: Record<string, string> = {
  "claude.ai": "Claude",
  api_key: "API Key",
  provider: "Provider",
  access_token: "Access Token",
  oauth_token: "OAuth",
  chatgpt: "ChatGPT",
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex",
};

function platformName(platform: string): {
  label: string;
  sf: "laptopcomputer" | "pc" | "server.rack";
} {
  if (platform === "darwin") return { label: "macOS", sf: "laptopcomputer" };
  if (platform === "win32") return { label: "Windows", sf: "pc" };
  return { label: "Linux", sf: "server.rack" };
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^ws/, "http")).host;
  } catch {
    return url;
  }
}

function QuickActionTile({
  icon,
  label,
  badge,
  onPress,
}: {
  icon: Pick<IconProps, "sf" | "md">;
  label: string;
  badge?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label} ${badge}` : label}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={{
        flex: 1,
        minHeight: 70,
        borderRadius: radius.card,
        borderCurve: "continuous",
        backgroundColor: colors.card,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 11,
        paddingHorizontal: 6,
        gap: 6,
      }}
    >
      {({ pressed }) => (
        <>
          <PressedWash pressed={pressed} />
          <View style={{ position: "relative" }}>
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                borderCurve: "continuous",
                backgroundColor: colors.accentSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon sf={icon.sf} md={icon.md} size={17} color={colors.accent} />
            </View>
            {badge ? (
              <View
                style={{
                  position: "absolute",
                  top: -4,
                  right: -8,
                  minWidth: 16,
                  height: 16,
                  paddingHorizontal: 4,
                  borderRadius: 8,
                  backgroundColor: colors.accentFill,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={[type.caption, { fontSize: 10, lineHeight: 12, fontWeight: "700", color: "#ffffff", fontVariant: ["tabular-nums"] }]}>
                  {badge}
                </Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={[type.footnote, { fontWeight: "500", color: colors.label }]}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

function AgentRow({ agent, first, online }: { agent: AgentInfo; first: boolean; online: boolean }) {
  const { locale, t, pick } = useLocale();
  const pending = useClient((state) => state.interactions[agent.id]?.length ?? 0);
  const look = agentLook(agent.id, agent.label);
  const missing = agent.auth?.state === "missing";
  const ready = online && agent.installed && !missing && agent.tier !== "terminal";
  const login = look.login;
  const [copied, setCopied] = useState(false);
  const auth = agent.auth?.state === "ok" && agent.auth.method ? (authMethod[agent.auth.method] ?? agent.auth.method) : null;
  const capabilities = agentCapabilityTags(agent, locale);
  const detail = missing
    ? (agent.auth?.hint ?? pick({ zh: "还没登录", en: "Not signed in", ja: "未ログイン" }))
    : [agent.version ? `v${agent.version.replace(/^v/i, "")}` : undefined, auth, ...capabilities].filter(Boolean).join(" · ") ||
      pick({ zh: "可用", en: "Ready", ja: "利用可能" });
  const tierLabel = tierCopy[agent.tier]?.label;

  return (
    <View>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 44 }} />}
      <View style={{ paddingVertical: 10, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Pressable
            disabled={!ready}
            accessibilityRole={ready ? "button" : undefined}
            accessibilityLabel={ready ? `${look.name}，新建会话` : look.name}
            onPress={() => {
              haptics.selection();
              router.push({ pathname: "/new", params: { agent: agent.id } });
            }}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              opacity: ready && pressed ? 0.65 : 1,
            })}
          >
            <AgentTile agent={agent.id} size={34} dimmed={!agent.installed} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text numberOfLines={1} style={[type.callout, { fontWeight: "600", color: colors.label, flexShrink: 1 }]}>
                  {look.name}
                </Text>
                {tierLabel ? (
                  <View
                    style={{
                      paddingHorizontal: 6,
                      paddingVertical: 1,
                      borderRadius: radius.chip,
                      borderCurve: "continuous",
                      backgroundColor: agent.tier === "multi_client" ? colors.accentSoft : colors.fill,
                    }}
                  >
                    <Text
                      style={[
                        type.caption,
                        {
                          fontSize: 11,
                          lineHeight: 14,
                          fontWeight: "600",
                          color: agent.tier === "multi_client" ? colors.accent : colors.secondaryLabel,
                        },
                      ]}
                    >
                      {tierLabel}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text numberOfLines={2} style={[type.footnote, { color: missing ? colors.waiting : colors.secondaryLabel }]}>
                {detail}
              </Text>
            </View>
          </Pressable>
          {missing ? <Icon sf="exclamationmark.circle.fill" md="error" size={16} color={colors.waiting} /> : null}
          {agent.capabilities.acp ? (
            <Button
              title={pending ? `${pick({ zh: "等你处理", en: "Needs You", ja: "確認待ち" })} ${pending}` : t("nav.settings")}
              size="small"
              variant={pending ? "warning" : "plain"}
              onPress={() => router.push({ pathname: "/acp", params: { agent: agent.id } })}
            />
          ) : ready ? (
            <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} weight="semibold" />
          ) : null}
        </View>
        {missing && login ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginLeft: 46,
              padding: 10,
              borderRadius: radius.control,
              borderCurve: "continuous",
              backgroundColor: colors.code,
            }}
          >
            <Text
              selectable
              style={{
                flex: 1,
                fontFamily: mono,
                fontSize: 13,
                color: colors.codeText,
              }}
            >
              {login}
            </Text>
            <Button
              title={copied ? t("common.copied") : t("common.copy")}
              size="small"
              icon={{
                sf: copied ? "checkmark" : "doc.on.doc",
                md: copied ? "check" : "content_copy",
              }}
              onPress={() => {
                void Clipboard.setStringAsync(login);
                haptics.success();
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CatalogAgentRow({ agent, first }: { agent: AgentInfo; first: boolean }) {
  const { t, pick } = useLocale();
  const look = agentLook(agent.id, agent.label);
  const [copied, setCopied] = useState(false);
  const install = look.install;

  return (
    <View>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 38 }} />}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
        <AgentTile agent={agent.id} size={28} dimmed />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={1} style={[type.subhead, { fontWeight: "500", color: colors.label }]}>
            {look.name}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              install ? { fontFamily: mono, fontSize: 11, lineHeight: 15 } : type.caption,
              { color: colors.tertiaryLabel },
            ]}
          >
            {install ?? pick({ zh: "在电脑安装后自动识别", en: "Auto-detected once installed", ja: "インストール後に自動検出" })}
          </Text>
        </View>
        {install ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t("common.copy")} ${look.name}`}
            hitSlop={8}
            onPress={() => {
              void Clipboard.setStringAsync(install);
              haptics.success();
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            style={({ pressed }) => ({
              paddingHorizontal: 9,
              paddingVertical: 4,
              borderRadius: radius.chip,
              borderCurve: "continuous",
              backgroundColor: copied ? colors.okSoft : colors.fill,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Text style={[type.caption, { fontWeight: "600", color: copied ? colors.ok : colors.secondaryLabel }]}>
              {copied ? t("common.copied") : t("common.copy")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function UninstalledAgentsCatalog({ agents }: { agents: AgentInfo[] }) {
  const { pick } = useLocale();
  const [open, setOpen] = useState(false);
  const domestic = useMemo(() => agents.filter((agent) => agentLook(agent.id, agent.label).group === "domestic"), [agents]);
  const global = useMemo(() => agents.filter((agent) => agentLook(agent.id, agent.label).group !== "domestic"), [agents]);
  const preview = useMemo(() => [...domestic, ...global].slice(0, 6), [domestic, global]);

  if (!agents.length) return null;

  return (
    <View>
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          haptics.selection();
          setOpen((value) => !value);
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 46,
          paddingVertical: 10,
          opacity: pressed ? 0.65 : 1,
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={[type.subhead, { fontWeight: "500", color: colors.secondaryLabel }]}>
            {pick({
              zh: `更多支持的 Agent（未安装 ${agents.length}）`,
              en: `More Supported Agents (${agents.length})`,
              ja: `その他の対応 Agent（未導入 ${agents.length}）`,
            })}
          </Text>
          {!open ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 }}>
              {preview.map((agent) => (
                <AgentTile key={agent.id} agent={agent.id} size={20} dimmed />
              ))}
              {agents.length > preview.length ? (
                <Text style={[type.caption, { color: colors.tertiaryLabel, marginLeft: 2, fontVariant: ["tabular-nums"] }]}>
                  +{agents.length - preview.length}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
        <Icon sf={open ? "chevron.up" : "chevron.down"} md={open ? "expand_less" : "expand_more"} size={12} color={colors.tertiaryLabel} weight="semibold" />
      </Pressable>

      {open ? (
        <View style={{ paddingBottom: 8, gap: 10 }}>
          {domestic.length > 0 ? (
            <View style={{ gap: 2 }}>
              <Text style={[type.caption, { fontWeight: "600", color: colors.tertiaryLabel, paddingTop: 2, paddingBottom: 4 }]}>
                {pick({ zh: "国产主流", en: "Chinese Coding Agents", ja: "中国主要 Agent" })}
              </Text>
              {domestic.map((agent, index) => (
                <CatalogAgentRow key={agent.id} agent={agent} first={index === 0} />
              ))}
            </View>
          ) : null}
          {global.length > 0 ? (
            <View style={{ gap: 2 }}>
              <Text style={[type.caption, { fontWeight: "600", color: colors.tertiaryLabel, paddingTop: 4, paddingBottom: 4 }]}>
                {pick({ zh: "国际与开源", en: "Global & Open Source", ja: "グローバル / OSS" })}
              </Text>
              {global.map((agent, index) => (
                <CatalogAgentRow key={agent.id} agent={agent} first={index === 0} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function WorkspaceToolsSection({ roiDetail, portsCount }: { roiDetail: string; portsCount: number }) {
  const { t, pick } = useLocale();
  const { ports } = usePorts();
  const web = ports ?? [];
  const shown = web.slice(0, 2);
  const portsSubtitle = shown.length
    ? web.length > shown.length
      ? pick({ zh: `全部 ${web.length} 个端口，或输入端口号`, en: `All ${web.length} ports, or enter port`, ja: `全 ${web.length} 件、またはポート番号入力` })
      : pick({ zh: "查看全部或输入其他端口", en: "Open or enter another port", ja: "別のポートを開く" })
    : t("ports.openPreview");

  return (
    <View style={{ gap: 7 }}>
      <Text style={[type.footnote, { fontWeight: "600", color: colors.secondaryLabel, paddingHorizontal: 12 }]}>
        {pick({ zh: "屏幕与工具", en: "Screen & Tools", ja: "画面とツール" })}
      </Text>
      <View>
        <ListRow
          leading={<Icon sf="display" md="desktop_windows" size={20} color={colors.accent} />}
          title={t("nav.screen")}
          time=""
          detail={pick({
            zh: "实时查看与操控桌面",
            en: "Live low-latency desktop view & control",
            ja: "リアルタイム画面表示・操作",
          })}
          position="first"
          onPress={() => router.push("/screen")}
          accessibilityLabel={t("nav.screen")}
        />
        {shown.map((entry) => (
          <PortRow key={entry.port} entry={entry} position="middle" />
        ))}
        <ListRow
          leading={<Icon sf="globe" md="language" size={20} color={colors.accent} />}
          title={portsCount > 0 ? `${t("nav.ports")} (${portsCount})` : t("nav.ports")}
          time=""
          detail={portsSubtitle}
          position="middle"
          onPress={() => router.push("/ports")}
          accessibilityLabel={t("nav.ports")}
        />
        <ListRow
          leading={<Icon sf="chart.bar" md="bar_chart" size={20} color={colors.accent} />}
          title={t("nav.usage")}
          time=""
          detail={roiDetail}
          position="last"
          onPress={() => router.push("/usage")}
          accessibilityLabel={t("nav.usage")}
        />
      </View>
    </View>
  );
}

type PairedDevice = GatewayStatus["devices"][number];

function DeviceRow({ device, own, onRemove }: { device: PairedDevice; own: boolean; onRemove: () => void }) {
  const { t, pick } = useLocale();
  return (
    <View>
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 44 }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}>
        <View
          style={{ width: 32, height: 32, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="iphone" md="smartphone" size={16} color={colors.label} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={[type.callout, { flexShrink: 1, fontWeight: "500", color: colors.label }]}>
              {device.name || pick({ zh: "手机", en: "Device", ja: "デバイス" })}
            </Text>
            {own ? (
              <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: colors.fill }}>
                <Text style={[type.caption, { color: colors.label, fontWeight: "600" }]}>
                  {pick({ zh: "本机", en: "This device", ja: "この端末" })}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <LinkDot health={device.online ? "online" : "offline"} />
            <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
              {device.online ? t("connection.online") : t("connection.offline")} · {relativeTime(device.pairedAt)}
            </Text>
          </View>
        </View>
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={t("session.delete")}
          hitSlop={10}
          style={({ pressed }) => ({ paddingHorizontal: 6, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={[type.subhead, { color: colors.danger }]}>{pick({ zh: "移除", en: "Remove", ja: "削除" })}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ComputerPanel({
  title,
  children,
  expanded = true,
  onToggle,
  onAdd,
  detail,
}: {
  title: string;
  children: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  onAdd?: () => void;
  detail?: string;
}) {
  const control = (icon: ReactNode) => (
    <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
      {icon}
    </View>
  );

  if (onToggle && !expanded) {
    return (
      <View style={{ backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", minHeight: 48, paddingHorizontal: 16, gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            onPress={onToggle}
            style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, opacity: pressed ? 0.6 : 1 })}
          >
            <Text accessibilityRole="header" style={[type.callout, { flex: 1, fontWeight: "500", color: colors.label }]}>
              {title}
            </Text>
            {detail ? (
              <Text style={[type.subhead, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>{detail}</Text>
            ) : null}
            <Icon sf="chevron.down" md="expand_more" size={12} color={colors.tertiaryLabel} weight="semibold" />
          </Pressable>
          {onAdd ? (
            <Pressable accessibilityRole="button" onPress={onAdd} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              {control(<Icon sf="plus" md="add" size={14} color={colors.accent} weight="semibold" />)}
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 7 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 }}>
        <Pressable
          accessibilityRole={onToggle ? "button" : "header"}
          accessibilityState={onToggle ? { expanded } : undefined}
          disabled={!onToggle}
          onPress={onToggle}
          hitSlop={6}
          style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, opacity: onToggle && pressed ? 0.6 : 1 })}
        >
          <Text style={[type.footnote, { flex: 1, fontWeight: "600", color: colors.secondaryLabel }]}>{title}</Text>
          {detail ? <Text style={[type.footnote, { color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{detail}</Text> : null}
          {onToggle ? <Icon sf="chevron.up" md="expand_less" size={11} color={colors.tertiaryLabel} weight="semibold" /> : null}
        </Pressable>
        {onAdd ? (
          <Pressable accessibilityRole="button" onPress={onAdd} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            {control(<Icon sf="plus" md="add" size={14} color={colors.accent} weight="semibold" />)}
          </Pressable>
        ) : null}
      </View>
      <View style={{ backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", paddingHorizontal: 16, paddingVertical: 4 }}>
        {children}
      </View>
    </View>
  );
}

function DevicesSection({ defaultExpanded }: { defaultExpanded: boolean }) {
  const { link } = useConnection();
  const { t, pick } = useLocale();
  const online = useClient((state) => state.status === "online");
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    link
      .call("gateway.status", {})
      .then((status) => !cancelled && setGateway(status))
      .catch(() => {});
    const off = link.on("gateway.changed", setGateway);
    return () => {
      cancelled = true;
      off();
    };
  }, [link, online]);

  if (!gateway) return null;
  const off = gateway.status === "off";
  const up = gateway.status === "online";
  const own = deviceIdentity().id;
  const state = up
    ? t("connection.online")
    : gateway.status === "connecting"
      ? t("connection.connecting")
      : `${t("connection.offline")}${gateway.error ? ` · ${gateway.error.message}` : ""}`;

  const remove = (device: PairedDevice) => {
    Alert.alert(
      pick({
        zh: `移除「${device.name || "手机"}」？`,
        en: `Remove "${device.name || "Device"}"?`,
        ja: `「${device.name || "デバイス"}」を削除しますか？`,
      }),
      pick({
        zh: "移除后这台设备将无法再连接这台电脑。",
        en: "This device will no longer be able to connect to this computer.",
        ja: "削除すると、この端末からこの PC へ接続できなくなります。",
      }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: pick({ zh: "移除", en: "Remove", ja: "削除" }),
          style: "destructive",
          onPress: () => {
            setRemoving(device.id);
            link
              .call("devices.revoke", { deviceId: device.id })
              .then(() => link.call("gateway.status", {}).then(setGateway))
              .then(() => haptics.success())
              .catch((reason: unknown) => {
                haptics.error();
                Alert.alert(
                  pick({ zh: "移除失败", en: "Remove failed", ja: "削除に失敗しました" }),
                  reason instanceof Error ? reason.message : String(reason),
                );
              })
              .finally(() => setRemoving(null));
          },
        },
      ],
    );
  };

  return (
    <ComputerPanel
      title={pick({ zh: "连接与配对设备", en: "Relay & Paired Devices", ja: "中継とペアリング端末" })}
      expanded={expanded}
      onToggle={() => {
        haptics.selection();
        setExpanded((value) => !value);
      }}
      detail={gateway.devices.length > 0 ? String(gateway.devices.length) : state}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}>
        <View
          style={{ width: 32, height: 32, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="antenna.radiowaves.left.and.right" md="cell_tower" size={16} color={off ? colors.tertiaryLabel : colors.label} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text numberOfLines={1} style={[type.callout, { fontWeight: "500", color: colors.label }]}>
            {off ? t("connection.lanDirect") : hostOf(gateway.url ?? "")}
          </Text>
          {off ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
              {pick({ zh: "仅限同一局域网直连", en: "Local Wi-Fi only", ja: "同一ネットワーク内のみ" })}
            </Text>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <LinkDot health={up ? "online" : gateway.status === "connecting" ? "connecting" : gateway.error ? "error" : "offline"} />
              <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
                {state}
              </Text>
            </View>
          )}
        </View>
      </View>
      {gateway.devices.length > 0
        ? gateway.devices.map((device) => (
            <View key={device.id} style={{ opacity: removing === device.id ? 0.4 : 1 }}>
              <DeviceRow device={device} own={device.id === own} onRemove={() => remove(device)} />
            </View>
          ))
        : null}
    </ComputerPanel>
  );
}

export function ComputerScreen() {
  const insets = usePageInsets();
  const systemInsets = useSafeAreaInsets();
  const { t, pick } = useLocale();
  const inlineControls = Platform.OS !== "ios" || !hasSideToolbar(systemInsets);
  const contentWidth = useContentWidth();
  const [dashboardWidth, setDashboardWidth] = useState<number | null>(null);
  const availableWidth = dashboardWidth ?? Math.max(0, contentWidth - 32);
  const minimumColumn = 360;
  const wide = availableWidth >= minimumColumn * 2 + 20;
  const columnWidth = wide ? (availableWidth - 20) / 2 : "100%";
  const tabInset = useFloatingTabInset();
  const machine = useClient((state) => state.machine);
  const status = useConnectionStatus();
  const detail = useClient((state) => state.statusDetail);
  const { refresh } = useActions();
  const { url, computer, link } = useConnection();
  const { ports } = usePorts();
  const savedComputers = useComputers((state) => state.saved);
  const liveComputers = useComputers((state) => state.live);
  const computersCount = useMemo(
    () => listComputers({ saved: savedComputers, live: liveComputers }).length,
    [savedComputers, liveComputers],
  );
  const account = useAccount((state) => state.session);
  const accountAction: PageAction = {
    key: "account",
    icon: account ? { sf: "person.crop.circle.fill", md: "account_circle" } : { sf: "person.crop.circle", md: "account_circle" },
    label: t("nav.account"),
    onPress: () => router.push("/account"),
  };
  const [computersExpanded, setComputersExpanded] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [usageSummary, setUsageSummary] = useState<UsageReport | null>(null);
  const hasComputer = useHasComputer();
  const online = status === "online";
  const platform = platformName(machine?.platform ?? "");
  const names = useComputerNames((state) => state.names);
  const title = computerDisplayName(computer, names);
  const agents = useMemo(() => [...(machine?.agents ?? [])].sort((a, b) => Number(b.installed) - Number(a.installed)), [machine]);
  const installedAgents = useMemo(() => agents.filter((agent) => agent.installed), [agents]);
  const uninstalledAgents = useMemo(() => agents.filter((agent) => !agent.installed), [agents]);
  const portsCount = ports?.length ?? 0;

  useEffect(() => {
    setUsageSummary(null);
    if (!online) return;
    let cancelled = false;
    link
      .call("usage.summary", { days: 7, agent: "all" }, 25_000)
      .then((res) => {
        if (!cancelled) setUsageSummary(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [link, online, computer.key]);

  const roiDetail = usageSummary
    ? `${formatApiComputeValue(usageSummary.estimatedCostUsd ?? usageSummary.totals.estimatedCostUsd)} · ${t("usage.remoteApprovals")} ${usageSummary.remoteStats?.remoteApprovals ?? 0}`
    : t("usage.subscriptionReferenceNote");

  const statusSummary = online
    ? [t("connection.online"), machine ? platform.label : undefined, machine?.hostVersion ? `v${machine.hostVersion}` : undefined]
        .filter(Boolean)
        .join(" · ")
    : status === "connecting"
      ? t("connection.connecting")
      : status === "locked"
        // Reached, and waiting for its password: not "未连接".
        ? pick({ zh: "需要访问密码", en: "Access password needed", ja: "アクセスパスワードが必要です" })
        : `${t("connection.offline")}${formatConnectionDetail(detail) ? ` · ${formatConnectionDetail(detail)}` : ""}`;

  const transportSummary =
    computer.kind === "relay"
      ? `${computer.lanUrl ? `${t("connection.lanDirect")} + ` : ""}${t("connection.gatewayRelay")}${
          hostOf(computer.gateway) !== "gateway.itool.tech" ? ` · ${hostOf(computer.gateway)}` : ""
        }`
      : `${t("connection.lanDirect")} · ${url.replace(/^wss?:\/\//, "")}`;

  const agentPanel = (
    <ComputerPanel
      title="Agent"
      expanded={agentsExpanded}
      onToggle={() => {
        haptics.selection();
        setAgentsExpanded((value) => !value);
      }}
      detail={
        installedAgents.length > 0
          ? pick({
              zh: `已安装 ${installedAgents.length}`,
              en: `${installedAgents.length} ready`,
              ja: `${installedAgents.length} 件利用可`,
            })
          : online
            ? "0"
            : t("connection.offline")
      }
    >
      {installedAgents.length === 0 ? (
        <Text style={[type.subhead, { color: colors.secondaryLabel, paddingTop: 10, paddingBottom: 14 }]}>
          {online
            ? pick({
                zh: "这台电脑上还没有检测到已安装的 Agent，可展开下方列表复制安装命令。",
                en: "No coding agents detected yet. Expand the list below for install commands.",
                ja: "導入済み Agent がありません。下の一覧からインストールコマンドをコピーできます。",
              })
            : t("connection.offline")}
        </Text>
      ) : (
        installedAgents.map((agent, index) => <AgentRow key={agent.id} agent={agent} first={index === 0} online={online} />)
      )}

      <UninstalledAgentsCatalog agents={uninstalledAgents} />

      {online ? (
        <View>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              haptics.selection();
              router.push("/acp");
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              paddingVertical: 10,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Icon sf="plus.circle" md="add_circle_outline" size={18} color={colors.accent} />
            <Text style={[type.subhead, { flex: 1, fontWeight: "500", color: colors.accent }]}>
              {pick({ zh: "自定义 ACP 连接", en: "Custom ACP Agents", ja: "カスタム ACP 設定" })}
            </Text>
            <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} weight="semibold" />
          </Pressable>
        </View>
      ) : null}
    </ComputerPanel>
  );

  return (
    <>
      <Stack.Screen options={{ title: "", headerShown: !inlineControls, headerTransparent: true, headerLargeTitleEnabled: false }} />
      <ScrollView
        contentInsetAdjustmentBehavior={!inlineControls && Platform.OS === "ios" ? "automatic" : "never"}
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: inlineControls ? Math.max(insets.top, systemInsets.top) + 8 : 16,
          paddingBottom: 40 + tabInset + (inlineControls && Platform.OS === "ios" ? Math.max(insets.bottom, systemInsets.bottom) : 0),
          gap: 16,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              // Out of reach, the calls would wait half a minute for the link: reconnect instead.
              if (link.status !== "online") {
                link.reconnectNow(true);
                return;
              }
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
      >
        {!inlineControls ? <HeaderActions actions={[{ ...accountAction, kind: "button" }]} /> : null}
        {hasComputer ? (
          <View
            onLayout={(event) => setDashboardWidth(event.nativeEvent.layout.width)}
            style={{ width: "100%", flexDirection: wide ? "row" : "column", alignItems: "flex-start", gap: 16 }}
          >
            <View style={{ width: columnWidth, flexGrow: 0, flexShrink: 0, minWidth: 0, gap: 16 }}>
              <View
                style={{
                  backgroundColor: colors.card,
                  borderRadius: radius.card,
                  borderCurve: "continuous",
                  overflow: "hidden",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 }}>
                  <ComputerArt name={machine?.hostname ?? (computer.kind === "relay" ? computer.machine.name : computer.name)} size={42} />
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("nav.computers")}
                      onPress={() => {
                        haptics.selection();
                        router.push("/computers");
                      }}
                      hitSlop={6}
                      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, opacity: pressed ? 0.6 : 1 })}
                    >
                      <Text numberOfLines={1} style={[type.headline, { color: colors.label, flexShrink: 1 }]}>
                        {title}
                      </Text>
                      <Icon sf="chevron.up.chevron.down" md="unfold_more" size={12} color={colors.tertiaryLabel} weight="semibold" />
                    </Pressable>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <LinkDot health={online ? "online" : status === "connecting" ? "connecting" : status === "locked" ? "offline" : detail ? "error" : "offline"} />
                      <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel, flex: 1 }]}>
                        {statusSummary}
                      </Text>
                    </View>
                  </View>
                  {!online && status !== "connecting" ? (
                    <Button
                      title={pick({ zh: "重连", en: "Retry", ja: "再接続" })}
                      size="small"
                      variant="plain"
                      onPress={() => {
                        haptics.selection();
                        link.reconnectNow(true);
                      }}
                    />
                  ) : null}
                </View>

                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 16 }} />

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("nav.account")}
                  onPress={() => {
                    haptics.selection();
                    router.push("/account");
                  }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 16, paddingVertical: 9 }}
                >
                  {({ pressed }) => (
                    <>
                      <PressedWash pressed={pressed} />
                      <Icon
                        sf={account ? "person.crop.circle.fill" : "person.crop.circle"}
                        md="account_circle"
                        size={18}
                        color={colors.accent}
                      />
                      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <Text numberOfLines={1} style={[type.subhead, { color: colors.label, fontWeight: "500", flexShrink: 1 }]}>
                          {account?.email ?? t("nav.account")}
                        </Text>
                        <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                          {transportSummary}
                        </Text>
                      </View>
                      <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} weight="semibold" />
                    </>
                  )}
                </Pressable>
              </View>

              {online ? (
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <QuickActionTile
                    icon={{ sf: "plus.bubble", md: "add_comment" }}
                    label={pick({ zh: "新会话", en: "New", ja: "新規" })}
                    onPress={() => router.push("/new")}
                  />
                  <QuickActionTile
                    icon={{ sf: "display", md: "desktop_windows" }}
                    label={t("nav.screen")}
                    onPress={() => router.push("/screen")}
                  />
                  <QuickActionTile
                    icon={{ sf: "globe", md: "language" }}
                    label={t("nav.ports")}
                    badge={portsCount > 0 ? String(portsCount) : undefined}
                    onPress={() => router.push("/ports")}
                  />
                  <QuickActionTile
                    icon={{ sf: "chart.bar", md: "bar_chart" }}
                    label={t("nav.usage")}
                    onPress={() => router.push("/usage")}
                  />
                </View>
              ) : null}

              {!wide ? agentPanel : null}
              {online ? <WorkspaceToolsSection roiDetail={roiDetail} portsCount={portsCount} /> : null}
              <ComputerMetrics key={computer.key} />
            </View>

            <View style={{ width: columnWidth, flexGrow: 0, flexShrink: 0, minWidth: 0, gap: 12 }}>
              {wide ? agentPanel : null}
              <ComputerPanel
                title={t("nav.computers")}
                expanded={wide || computersExpanded}
                onToggle={
                  wide
                    ? undefined
                    : () => {
                        haptics.selection();
                        setComputersExpanded((value) => !value);
                      }
                }
                detail={computersCount > 0 ? String(computersCount) : undefined}
                onAdd={() => {
                  haptics.selection();
                  router.push("/pair");
                }}
              >
                <ComputerList background={colors.card} />
              </ComputerPanel>

              {online ? <DevicesSection defaultExpanded={wide} /> : null}
            </View>
          </View>
        ) : (
          <View>
            <Welcome />
            {inlineControls ? (
              <View style={{ position: "absolute", top: 0, right: 0 }}>
                <PageActionButton action={accountAction} />
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
      {Platform.OS !== "ios" || inlineControls ? <StatusBarFade /> : null}
    </>
  );
}
