import type { AgentInfo, GatewayStatus } from "@linkshell/wire";
import * as Clipboard from "expo-clipboard";
import { router, Stack } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePageInsets } from "@/components/adaptive-page";
import { HeaderActions } from "@/components/header-actions";
import { hasSideToolbar } from "@/lib/home-layout";
import { Text } from "@/components/fixed-text";
import { AgentTile } from "@/components/agent-tile";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { LiveDot } from "@/components/status";
import { useAccount } from "@/lib/account";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { useActions, useClient, useConnection, useHasComputer } from "@/lib/client";
import { Welcome } from "@/components/welcome";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { deviceIdentity } from "@/lib/identity";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { ComputerList } from "@/components/computer-list";
import { ComputerArt } from "@/components/computer-art";
import { PortRow } from "@/components/port-row";
import { ListRow } from "@/components/session-row";
import { usePorts } from "@/lib/ports";
import { PageActionButton, StatusBarFade, type PageAction } from "@/components/page-header";
import { useContentWidth } from "@/lib/content-width";

const authMethod: Record<string, string> = {
  "claude.ai": "Claude 账号",
  api_key: "API Key",
  provider: "服务商配置",
  access_token: "访问令牌",
  oauth_token: "OAuth 令牌",
  chatgpt: "ChatGPT 账号",
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

function AgentRow({ agent, first }: { agent: AgentInfo; first: boolean }) {
  const pending = useClient((state) => state.interactions[agent.id]?.length ?? 0);
  const look = agentLook(agent.id, agent.label);
  const missing = agent.auth?.state === "missing";
  const login = look.login;
  const [copied, setCopied] = useState(false);
  // One quiet line: version and how it's signed in. Colour only when it needs you.
  const auth = agent.auth?.state === "ok" && agent.auth.method ? (authMethod[agent.auth.method] ?? agent.auth.method) : null;
  const detail = missing ? (agent.auth?.hint ?? "还没登录") : [agent.version, auth].filter(Boolean).join(" · ") || "可用";

  return (
    <View>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 44 }} />}
      <View style={{ paddingVertical: 11, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <AgentTile agent={agent.id} size={32} dimmed={!agent.installed} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 21, fontWeight: "500", color: colors.label }}>
              {look.name}
            </Text>
            <Text numberOfLines={2} style={[type.footnote, { color: missing ? colors.waiting : colors.secondaryLabel }]}>
              {detail}
            </Text>
          </View>
          {missing ? <Icon sf="exclamationmark.circle.fill" md="error" size={16} color={colors.waiting} /> : null}
          {agent.capabilities.acp ? <Button title={pending ? `待处理 ${pending}` : "设置"} size="small" variant={pending ? "warning" : "plain"} onPress={() => router.push({ pathname: "/acp", params: { agent: agent.id } })} /> : null}
        </View>
        {missing && login ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginLeft: 48,
              padding: 10,
              borderRadius: 12,
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
              title={copied ? "已复制" : "复制"}
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

/** Web servers running on the computer, a tap away; everything else in the sheet. */
function PreviewSection() {
  const { ports } = usePorts();
  const web = ports ?? [];
  const shown = web.slice(0, 3);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.secondaryLabel, paddingHorizontal: 6 }}>预览</Text>
      <View>
        <ListRow
          leading={<Icon sf="display" md="desktop_windows" size={20} color={colors.accent} />}
          title="电脑屏幕"
          time=""
          detail="实时查看，经加密通道传输"
          position="first"
          onPress={() => router.push("/screen")}
          accessibilityLabel="查看电脑屏幕"
        />
        {shown.map((entry) => (
          <PortRow key={entry.port} entry={entry} position="middle" />
        ))}
        {/* One quiet line under the servers: everything else lives in the sheet. */}
        <Pressable
          onPress={() => router.push("/ports")}
          accessibilityRole="button"
          accessibilityLabel="其他端口"
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 46,
            paddingHorizontal: 14,
            backgroundColor: pressed ? colors.fill : colors.card,
            borderBottomLeftRadius: 20,
            borderBottomRightRadius: 20,
            borderCurve: "continuous",
          })}
        >
          <Icon sf="plus.circle" md="add_circle" size={18} color={colors.accent} />
          <Text style={[type.subhead, { flex: 1, color: colors.accent }]}>
            {shown.length ? (web.length > shown.length ? `全部 ${web.length} 个，或输入端口` : "输入其他端口") : "打开电脑上的网页"}
          </Text>
          <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} weight="semibold" />
        </Pressable>
      </View>
    </View>
  );
}

type PairedDevice = GatewayStatus["devices"][number];

function DeviceRow({ device, own, first, onRemove }: { device: PairedDevice; own: boolean; first: boolean; onRemove: () => void }) {
  return (
    <View>
      {first ? null : <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 44 }} />}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11 }}>
        <View
          style={{ width: 32, height: 32, borderRadius: 10, borderCurve: "continuous", backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="iphone" md="smartphone" size={16} color={colors.label} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, lineHeight: 21, fontWeight: "500", color: colors.label }}>
              {device.name || "手机"}
            </Text>
            {own ? (
              <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, borderCurve: "continuous", backgroundColor: colors.accentSoft }}>
                <Text style={[type.caption2, { color: colors.accent, fontWeight: "600" }]}>本机</Text>
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <LiveDot size={6} color={device.online ? colors.ok : colors.tertiaryLabel} live={device.online} />
            <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
              {device.online ? "在线" : "不在线"} · {relativeTime(device.pairedAt)}配对
            </Text>
          </View>
        </View>
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`移除 ${device.name || "手机"}`}
          hitSlop={10}
          style={({ pressed }) => ({ paddingHorizontal: 6, paddingVertical: 6, opacity: pressed ? 0.5 : 1 })}
        >
          <Text style={[type.subhead, { color: colors.danger }]}>移除</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * How the computer is reached from outside its network (its gateway), and the
 * phones paired with it. Any of them can be removed here: it then can't
 * connect to this computer any more.
 */
function DevicesSection() {
  const { link } = useConnection();
  const online = useClient((state) => state.status === "online");
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

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
  const account = gateway.account ? (gateway.account.email ?? "已登录账号") : null;
  const state = up ? "已连接" : gateway.status === "connecting" ? "正在连接…" : `连不上${gateway.error ? ` · ${gateway.error.message}` : ""}`;

  const remove = (device: PairedDevice) => {
    Alert.alert(`移除「${device.name || "手机"}」？`, "移除后这台手机将无法再连接这台电脑。", [
      { text: "取消", style: "cancel" },
      {
        text: "移除",
        style: "destructive",
        onPress: () => {
          setRemoving(device.id);
          link
            .call("devices.revoke", { deviceId: device.id })
            // The host says so too (gateway.changed); this covers a host that doesn't.
            .then(() => link.call("gateway.status", {}).then(setGateway))
            .then(() => haptics.success())
            .catch((reason: unknown) => {
              haptics.error();
              Alert.alert("移除失败", reason instanceof Error ? reason.message : String(reason));
            })
            .finally(() => setRemoving(null));
        },
      },
    ]);
  };

  const heading = { fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.secondaryLabel, paddingHorizontal: 6 } as const;
  const card = { backgroundColor: colors.card, borderRadius: 24, borderCurve: "continuous", paddingHorizontal: 16, paddingVertical: 2 } as const;
  return (
    <>
      <View style={{ gap: 8 }}>
        <Text style={heading}>网关</Text>
        <View style={card}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11 }}>
            <View
              style={{ width: 32, height: 32, borderRadius: 10, borderCurve: "continuous", backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
            >
              <Icon sf="antenna.radiowaves.left.and.right" md="cell_tower" size={16} color={off ? colors.tertiaryLabel : colors.label} />
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 21, fontWeight: "500", color: colors.label }}>
                {off ? "未使用网关" : hostOf(gateway.url ?? "")}
              </Text>
              {off ? (
                <Text style={[type.footnote, { color: colors.secondaryLabel }]}>只能在同一网络里直连这台电脑</Text>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <LiveDot size={6} color={up ? colors.ok : colors.tertiaryLabel} live={up} />
                  <Text numberOfLines={2} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
                    {state}
                    {account ? ` · ${account}` : ""}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={heading}>已配对的设备</Text>
        <View style={card}>
          {gateway.devices.length === 0 ? (
            <Text style={[type.subhead, { color: colors.secondaryLabel, paddingVertical: 14 }]}>
              {off ? "没有使用网关，所以没有配对的设备" : "还没有配对的设备"}
            </Text>
          ) : (
            gateway.devices.map((device, index) => (
              <View key={device.id} style={{ opacity: removing === device.id ? 0.4 : 1 }}>
                <DeviceRow device={device} own={device.id === own} first={index === 0} onRemove={() => remove(device)} />
              </View>
            ))
          )}
        </View>
      </View>
    </>
  );
}

function ComputerPanel({ title, children, expanded = true, onToggle, onAdd, detail }: {
  title: string;
  children: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  onAdd?: () => void;
  detail?: string;
}) {
  // The heading sits above the card, as 预览 and 网关 do: one kind of section on the page.
  const heading = (
    <>
      <Text accessibilityRole="header" style={{ flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.secondaryLabel }}>{title}</Text>
      {detail ? <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>{detail}</Text> : null}
    </>
  );
  const control = (icon: ReactNode) => <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>{icon}</View>;
  return (
    <View style={{ gap: 8 }}>
      {onToggle ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "收起" : "展开"}${/^[A-Za-z]/.test(title) ? " " : ""}${title}`} accessibilityState={{ expanded }} onPress={onToggle} hitSlop={6} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingHorizontal: 6, opacity: pressed ? 0.6 : 1 })}>
          {heading}
          {control(<Icon sf={expanded ? "chevron.up" : "chevron.down"} md={expanded ? "expand_less" : "expand_more"} size={13} color={colors.secondaryLabel} weight="semibold" />)}
        </Pressable>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingHorizontal: 6 }}>
          {heading}
          {onAdd ? <Pressable accessibilityRole="button" accessibilityLabel="添加电脑" onPress={onAdd} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            {control(<Icon sf="plus" md="add" size={15} color={colors.secondaryLabel} weight="semibold" />)}
          </Pressable> : null}
        </View>
      )}
      {expanded ? <View style={{ backgroundColor: colors.card, borderRadius: 24, borderCurve: "continuous", paddingHorizontal: 16, paddingVertical: 4 }}>{children}</View> : null}
    </View>
  );
}

export function ComputerScreen() {
  const insets = usePageInsets();
  const systemInsets = useSafeAreaInsets();
  const inlineControls = Platform.OS !== "ios" || !hasSideToolbar(systemInsets);
  const contentWidth = useContentWidth();
  const [dashboardWidth, setDashboardWidth] = useState<number | null>(null);
  const availableWidth = dashboardWidth ?? Math.max(0, contentWidth - 32);
  const minimumColumn = 360;
  const wide = availableWidth >= minimumColumn * 2 + 20;
  const columnWidth = wide ? (availableWidth - 20) / 2 : "100%";
  const tabInset = useFloatingTabInset();
  const machine = useClient((state) => state.machine);
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const { refresh } = useActions();
  const { url, computer } = useConnection();
  const account = useAccount((state) => state.session);
  const accountAction: PageAction = {
    key: "account",
    icon: account ? { sf: "person.crop.circle.fill", md: "account_circle" } : { sf: "person.crop.circle", md: "account_circle" },
    label: "账号与电脑",
    onPress: () => router.push("/account"),
  };
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const hasComputer = useHasComputer();
  const online = status === "online";
  const platform = platformName(machine?.platform ?? "");
  // The name the user gave it, as the home page and the device list show it; the host name says which machine that is.
  const names = useComputerNames((state) => state.names);
  const title = computerDisplayName(computer, names);
  const hostname = machine?.hostname.replace(/\.local$/, "");
  const agents = [...(machine?.agents ?? [])].sort((a, b) => Number(b.installed) - Number(a.installed));

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
          gap: 20,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
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
          style={{ width: "100%", flexDirection: wide ? "row" : "column", alignItems: "flex-start", gap: 20 }}
        >
        <View style={{ width: columnWidth, flexGrow: 0, flexShrink: 0, minWidth: 0, gap: 20 }}>
        <View
          style={{
            backgroundColor: colors.card,
            borderRadius: 24,
            borderCurve: "continuous",
            padding: 16,
            gap: 14,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
            <ComputerArt name={machine?.hostname ?? (computer.kind === "relay" ? computer.machine.name : computer.name)} size={42} />
            <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="切换电脑"
                accessibilityHint="打开设备列表"
                onPress={() => { haptics.selection(); router.push("/computers"); }}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 }}>
                  <Text numberOfLines={1} style={[type.headline, { color: colors.label, flex: 1, minWidth: 0 }]}>
                    {title}
                  </Text>
                  <Icon sf="chevron.up.chevron.down" md="unfold_more" size={12} color={colors.tertiaryLabel} weight="semibold" />
                </View>
              </Pressable>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <LiveDot size={7} color={online ? colors.ok : colors.tertiaryLabel} live={online} />
                <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel, flexShrink: 1 }]}>
                  {online ? "在线" : status === "connecting" ? "正在连接…" : `连不上${detail ? ` · ${detail}` : ""}`}
                </Text>
              </View>
              {machine ? (
                <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>
                  {hostname && hostname !== title ? hostname : platform.label} · LinkShell {machine.hostVersion}
                </Text>
              ) : null}
            </View>
            {inlineControls ? <PageActionButton action={accountAction} /> : null}
          </View>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Icon
              sf={computer.kind === "relay" ? "lock.fill" : "wifi"}
              md={computer.kind === "relay" ? "lock" : "wifi"}
              size={12}
              color={computer.kind === "relay" ? colors.ok : colors.tertiaryLabel}
            />
            <Text numberOfLines={2} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
              {computer.kind === "relay"
                ? `端到端加密 · ${computer.machine.via === "account" ? "同一账号" : "已配对"} · ${hostOf(computer.gateway)}`
                : `局域网直连 · ${url.replace(/^wss?:\/\//, "")}`}
            </Text>
          </View>
        </View>

        {online ? <ListRow
          leading={<Icon sf="chart.bar" md="bar_chart" size={20} color={colors.accent} />}
          title="用量统计"
          time=""
          detail="Token、缓存与模型分布"
          position="only"
          onPress={() => router.push("/usage")}
          accessibilityLabel="查看这台电脑的用量统计"
        /> : null}
        {online ? <PreviewSection /> : null}
        </View>

        <View style={{ width: columnWidth, flexGrow: 0, flexShrink: 0, minWidth: 0, gap: 20 }}>
        <ComputerPanel title="设备" onAdd={() => { haptics.selection(); router.push("/pair"); }}>
          <ComputerList />
        </ComputerPanel>
        <ComputerPanel
          title="Agent"
          expanded={agentsExpanded}
          onToggle={() => { haptics.selection(); setAgentsExpanded((value) => !value); }}
          detail={agents.some((agent) => agent.installed) ? `${agents.filter((agent) => agent.installed).length} 个` : !agentsExpanded ? (online ? "未检测到" : "未连接") : undefined}
        >
          {!agents.some((agent) => agent.installed) ? (
            <Text style={[type.subhead, { color: colors.secondaryLabel, paddingTop: 6, paddingBottom: 16 }]}>
              {online ? "这台电脑上还没有检测到 Agent" : "连上电脑后显示"}
            </Text>
          ) : (
            agents.filter((agent) => agent.installed).map((agent, index) => <AgentRow key={agent.id} agent={agent} first={index === 0} />)
          )}
          {online ? <Button title="自定义 ACP 连接" variant="plain" onPress={() => router.push("/acp")} /> : null}
          {agents.some((agent) => !agent.installed) ? (
            <Text style={[type.footnote, { color: colors.tertiaryLabel, paddingVertical: 12 }]}>
              未安装：{agents.filter((agent) => !agent.installed).map((agent) => agentLook(agent.id, agent.label).name).join("、")}
            </Text>
          ) : null}
        </ComputerPanel>

        {online ? <DevicesSection /> : null}
        </View>
        </View>
        ) : (
          <View>
            <Welcome />
            {inlineControls ? <View style={{ position: "absolute", top: 0, right: 0 }}><PageActionButton action={accountAction} /></View> : null}
          </View>
        )}
      </ScrollView>
      {/* Without a native bar (iOS draws one only beside a side toolbar), content would run under the clock. */}
      {Platform.OS !== "ios" || inlineControls ? <StatusBarFade /> : null}
    </>
  );
}
