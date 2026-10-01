import type { AgentInfo, GatewayStatus } from "@linkshell/wire";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { AgentTile } from "@/components/agent-tile";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { LiveDot } from "@/components/status";
import { useAccount } from "@/lib/account";
import { useActions, useClient, useConnection, useHasComputer } from "@/lib/client";
import { Welcome } from "@/components/welcome";
import { listComputers, useComputers } from "@/lib/computers";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { deviceIdentity } from "@/lib/identity";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { AppMenu } from "@/components/app-menu";
import { PortRow } from "@/components/port-row";
import { ListRow } from "@/components/session-row";
import { usePorts } from "@/lib/ports";
import { PageHeader, StatusBarFade } from "@/components/page-header";

const authMethod: Record<string, string> = {
  "claude.ai": "Claude 账号",
  api_key: "API Key",
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

export function ComputerScreen() {
  const tabInset = useFloatingTabInset();
  const machine = useClient((state) => state.machine);
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const { refresh } = useActions();
  const { url, computer } = useConnection();
  const account = useAccount((state) => state.session);
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const computers = useMemo(() => listComputers({ saved, live }), [saved, live]);
  const [refreshing, setRefreshing] = useState(false);
  const hasComputer = useHasComputer();
  const online = status === "online";
  const platform = platformName(machine?.platform ?? "");
  const agents = [...(machine?.agents ?? [])].sort((a, b) => Number(b.installed) - Number(a.installed));

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 40 + tabInset,
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
        <PageHeader
          title="电脑"
          actions={[
            {
              key: "account",
              icon: account ? { sf: "person.crop.circle.fill", md: "account_circle" } : { sf: "person.crop.circle", md: "account_circle" },
              label: "账号与电脑",
              onPress: () => router.push("/account"),
            },
          ]}
        />
        {hasComputer ? (
        <>
        <View
          style={{
            backgroundColor: colors.card,
            borderRadius: 24,
            borderCurve: "continuous",
            padding: 16,
            gap: 14,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 13,
                borderCurve: "continuous",
                backgroundColor: colors.fill,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon sf={platform.sf} md="laptop_mac" size={22} color={colors.label} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <AppMenu
                title="切换电脑"
                actions={[
                  ...computers.map((entry) => ({
                    id: entry.key,
                    title: entry.kind === "relay" ? entry.machine.name : entry.name,
                    subtitle:
                      entry.kind === "relay"
                        ? `${entry.machine.via === "account" ? "同一账号" : "已配对"} · ${entry.machine.online ? "在线" : "离线"}`
                        : "局域网",
                    state: entry.key === computer.key ? ("on" as const) : ("off" as const),
                  })),
                  { id: "add", title: "添加电脑…" },
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "add") router.push("/pair");
                  else useComputers.getState().select(nativeEvent.event);
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text numberOfLines={1} style={[type.title3, { color: colors.label, flexShrink: 1 }]}>
                    {machine ? machine.hostname.replace(/\.local$/, "") : computer.kind === "relay" ? computer.machine.name : "我的电脑"}
                  </Text>
                  <Icon sf="chevron.up.chevron.down" md="unfold_more" size={12} color={colors.tertiaryLabel} weight="semibold" />
                </View>
              </AppMenu>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <LiveDot size={7} color={online ? colors.ok : colors.tertiaryLabel} live={online} />
                <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel, flexShrink: 1 }]}>
                  {online ? "在线" : status === "connecting" ? "正在连接…" : `连不上${detail ? ` · ${detail}` : ""}`}
                  {machine ? ` · ${platform.label} · LinkShell ${machine.hostVersion}` : ""}
                </Text>
              </View>
            </View>
          </View>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Icon
              sf={computer.kind === "relay" ? "lock.fill" : "wifi"}
              md={computer.kind === "relay" ? "lock" : "wifi"}
              size={12}
              color={computer.kind === "relay" ? colors.ok : colors.tertiaryLabel}
            />
            <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
              {computer.kind === "relay"
                ? `端到端加密 · ${computer.machine.via === "account" ? "同一账号" : "已配对"} · ${hostOf(computer.gateway)}`
                : `局域网直连 · ${url.replace(/^wss?:\/\//, "")}`}
            </Text>
          </View>
        </View>

        {online ? <PreviewSection /> : null}

        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.secondaryLabel, paddingHorizontal: 6 }}>Agent</Text>
          <View
            style={{
              backgroundColor: colors.card,
              borderRadius: 24,
              borderCurve: "continuous",
              paddingHorizontal: 16,
              paddingVertical: 2,
            }}
          >
            {agents.length === 0 ? (
              <Text style={[type.subhead, { color: colors.secondaryLabel, paddingVertical: 14 }]}>
                {online ? "这台电脑上还没有检测到 Agent" : "连上电脑后显示"}
              </Text>
            ) : (
              agents.filter((agent) => agent.installed).map((agent, index) => <AgentRow key={agent.id} agent={agent} first={index === 0} />)
            )}
          </View>
          {agents.some((agent) => !agent.installed) ? (
            <Text style={[type.footnote, { color: colors.tertiaryLabel, paddingHorizontal: 6 }]}>
              未安装：
              {agents
                .filter((agent) => !agent.installed)
                .map((agent) => agentLook(agent.id, agent.label).name)
                .join("、")}
            </Text>
          ) : null}
        </View>

        {online ? <DevicesSection /> : null}
        </>
        ) : (
          <Welcome />
        )}
      </ScrollView>
      <StatusBarFade />
    </>
  );
}
