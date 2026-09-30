import type { PendingPermission } from "@linkshell/client-core";
import type { AgentInfo, ContentBlock, QueuedMessage, SessionConfigOption, SessionDriver } from "@linkshell/wire";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Button } from "./button";
import { ConfigMenus } from "./config-menu";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { PermissionActions } from "./permission-actions";
import { PlusMenu } from "./plus-menu";
import { UsageRing } from "./usage-ring";

interface Attachment {
  uri: string;
  mimeType: string;
  data: string;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ComposerProps {
  agent: string;
  agentInfo?: AgentInfo;
  online: boolean;
  turnActive: boolean;
  driver?: SessionDriver;
  permission?: PendingPermission;
  permissionCount: number;
  config: SessionConfigOption[];
  commands: { name: string; description: string; hint?: string }[];
  usage?: { usedTokens?: number; contextWindow?: number };
  bottomInset: number;
  onLayout: (event: LayoutChangeEvent) => void;
  onSend: (content: ContentBlock[]) => Promise<"started" | "steered" | "queued" | "duplicate" | "failed">;
  onStop: () => Promise<void>;
  onRespond: (requestId: string, optionId: string) => Promise<void>;
  onTakeover: () => Promise<void>;
  onConfig: (optionId: string, value: string) => void;
  /** Messages the computer holds until the current turn ends. */
  queue?: QueuedMessage[];
  onUnqueue: (clientMessageId: string) => void;
}

type Blocked = { title: string; detail?: string } | null;

function blockedReason(props: ComposerProps): Blocked {
  const name = agentLook(props.agent).short;
  if (!props.online) return { title: "电脑离线", detail: "内容还能查看，电脑连上后才能继续" };
  const info = props.agentInfo;
  if (info && !info.installed) return { title: `这台电脑上没有 ${name}`, detail: info.problem };
  if (info?.auth?.state === "missing") return { title: `${name} 还没登录`, detail: info.auth.hint };
  if (info?.tier === "terminal") return { title: "这个 Agent 只有终端", detail: "请在终端里输入" };
  return null;
}

export function Composer(props: ComposerProps) {
  const { agent, turnActive, driver, permission, permissionCount, config, bottomInset } = props;
  const [text, setText] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const name = agentLook(agent).short;
  const blocked = blockedReason(props);
  const tier = props.agentInfo?.tier;
  const desktopDriving = tier === "handoff" && driver === "desktop";
  const canSteer = props.agentInfo?.capabilities.steer ?? false;
  const trimmed = text.trim();
  const canAttachImages = props.agentInfo?.capabilities.images ?? false;
  const hasContent = trimmed.length > 0 || attachments.length > 0;
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const suggestions =
    slashQuery === undefined
      ? []
      : props.commands.filter((command) => command.name.toLowerCase().startsWith(slashQuery.toLowerCase())).slice(0, 6);

  const addImage = async (camera: boolean) => {
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.8, allowsMultipleSelection: !camera, selectionLimit: 4 };
    try {
      if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("没有相机权限", "可以在系统设置里允许 LinkShell 使用相机。");
          return;
        }
      }
      const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return;
      const picked = result.assets
        .filter((asset) => asset.base64 && asset.base64.length * 0.75 <= MAX_IMAGE_BYTES)
        .map((asset) => ({ uri: asset.uri, mimeType: asset.mimeType ?? "image/jpeg", data: asset.base64! }));
      if (picked.length < result.assets.length) Alert.alert("有图片太大", "单张图片不能超过 5 MB。");
      setAttachments((current) => [...current, ...picked].slice(0, 4));
      haptics.selection();
    } catch (error) {
      Alert.alert("没能添加图片", error instanceof Error ? error.message : String(error));
    }
  };
  const inputDisabled = !!blocked || desktopDriving;

  const showFlash = (message: string) => {
    setFlash(message);
    setTimeout(() => setFlash((current) => (current === message ? null : current)), 2600);
  };

  const send = async () => {
    if (!hasContent || inputDisabled) return;
    haptics.light();
    const content: ContentBlock[] = [
      ...attachments.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
      ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
    ];
    setText("");
    setAttachments([]);
    const delivery = await props.onSend(content);
    if (delivery === "queued") showFlash(`排队中：${name} 忙完这一轮就发`);
    else if (delivery === "steered") showFlash("已插话，正在调整方向");
    else if (delivery === "failed") haptics.error();
  };

  const stop = async () => {
    haptics.medium();
    // Stopping drops what's queued; its text comes back here, like the terminal does.
    const queued = (props.queue ?? []).map((entry) => entry.text).filter(Boolean);
    if (queued.length) setText((current) => [...queued, current].filter(Boolean).join("\n\n"));
    setStopping(true);
    try {
      await props.onStop();
    } finally {
      setStopping(false);
    }
  };

  const placeholder = permission
    ? "或者直接告诉它该怎么做…"
    : turnActive
      ? canSteer
        ? `插话：${name} 会立刻调整…`
        : `排队一条消息，${name} 忙完后处理`
      : `给 ${name} 发消息`;

  const order = { model: 0, effort: 1, mode: 2, other: 3 } as const;
  const configShown = config
    .filter((option) => option.values.length > 1)
    .sort((a, b) => order[a.category] - order[b.category])
    .slice(0, 4);

  return (
    <View onLayout={props.onLayout} style={{ paddingHorizontal: 10, paddingBottom: bottomInset + 8, paddingTop: 6, gap: 8 }}>
      {permission ? (
        <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(220)}>
          <Glass style={{ borderRadius: 26, padding: 14, gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 9,
                  borderCurve: "continuous",
                  backgroundColor: colors.waitingSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon sf="hand.raised.fill" md="front_hand" size={13} color={colors.waiting} />
              </View>
              <Text numberOfLines={2} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
                {permission.title}
              </Text>
              {permissionCount > 1 ? (
                <Text style={[type.caption, { color: colors.waiting, fontWeight: "600" }]}>1/{permissionCount}</Text>
              ) : null}
            </View>
            {permission.detail ? (
              <View style={{ backgroundColor: colors.code, borderRadius: 12, borderCurve: "continuous", padding: 10 }}>
                <Text selectable numberOfLines={6} style={{ fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.codeText }}>
                  {permission.detail}
                </Text>
              </View>
            ) : null}
            <PermissionActions
              key={permission.requestId}
              options={permission.options}
              disabled={!props.online}
              size="large"
              onChoose={(optionId) => props.onRespond(permission.requestId, optionId)}
            />
            {tier === "multi_client" || tier === "handoff" ? (
              <Text style={[type.caption, { color: colors.tertiaryLabel, textAlign: "center" }]}>在哪边回答都行，另一边会同步收起</Text>
            ) : null}
          </Glass>
        </Animated.View>
      ) : null}

      {desktopDriving && !blocked ? (
        <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)}>
          <TakeoverPanel onTakeover={props.onTakeover} />
        </Animated.View>
      ) : (
        <Glass style={{ borderRadius: 26, paddingTop: 4, paddingBottom: 8, paddingHorizontal: 8 }}>
          {flash ? (
            <Animated.Text
              entering={FadeIn.duration(180)}
              exiting={FadeOut.duration(180)}
              style={[type.caption, { color: colors.accent, paddingHorizontal: 8, paddingTop: 6, fontWeight: "600" }]}
            >
              {flash}
            </Animated.Text>
          ) : tier === "handoff" && driver === "remote" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingTop: 6 }}>
              <Icon sf="iphone" md="smartphone" size={11} color={colors.accent} />
              <Text style={[type.caption, { color: colors.secondaryLabel }]}>你在操作 · 电脑终端按任意键可收回</Text>
            </View>
          ) : null}
          {suggestions.length ? (
            <View style={{ paddingTop: 6, paddingHorizontal: 4, gap: 2 }}>
              {suggestions.map((command) => (
                <Pressable
                  key={command.name}
                  onPress={() => {
                    haptics.selection();
                    setText(`/${command.name} `);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "baseline",
                    gap: 8,
                    paddingHorizontal: 8,
                    paddingVertical: 7,
                    borderRadius: 10,
                    backgroundColor: pressed ? colors.fill : "transparent",
                  })}
                >
                  <Text style={{ fontFamily: mono, fontSize: 14, color: colors.accent, fontWeight: "600" }}>/{command.name}</Text>
                  <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
                    {command.description}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {props.queue?.length ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8, gap: 4 }}>
              {props.queue.map((entry, index) => (
                <View
                  key={entry.clientMessageId}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    minHeight: 34,
                    paddingLeft: 10,
                    paddingRight: 4,
                    borderRadius: 12,
                    borderCurve: "continuous",
                    backgroundColor: colors.fill,
                  }}
                >
                  <Icon sf="clock" md="schedule" size={12} color={colors.secondaryLabel} />
                  <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.label }]}>
                    {entry.text || (entry.images ? `${entry.images} 张图片` : "")}
                    {entry.text && entry.images ? <Text style={{ color: colors.secondaryLabel }}> · {entry.images} 张图片</Text> : null}
                  </Text>
                  <Text style={[type.caption, { color: colors.tertiaryLabel }]}>{index === 0 ? "下一条" : "排队中"}</Text>
                  <Pressable
                    onPress={() => {
                      haptics.selection();
                      props.onUnqueue(entry.clientMessageId);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="取消这条排队消息"
                    hitSlop={6}
                    style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
                  >
                    <Icon sf="xmark.circle.fill" md="cancel" size={16} color={colors.tertiaryLabel} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {attachments.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 6, paddingTop: 8 }}>
              {attachments.map((image, index) => (
                <View key={`${image.uri}-${index}`}>
                  <Image source={{ uri: image.uri }} style={{ width: 64, height: 64, borderRadius: 14 }} contentFit="cover" />
                  <Pressable
                    onPress={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                    accessibilityLabel="移除图片"
                    hitSlop={8}
                    style={{
                      position: "absolute",
                      top: -5,
                      right: -5,
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: "rgba(0,0,0,0.65)",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon sf="xmark" md="close" size={9} color="#ffffff" weight="bold" />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          <TextInput
            value={text}
            onChangeText={setText}
            editable={!inputDisabled}
            multiline
            placeholder={blocked ? blocked.title : placeholder}
            placeholderTextColor={colors.placeholder as string}
            selectionColor={colors.accent}
            style={[type.callout, { color: colors.label, maxHeight: 150, minHeight: 40, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 6 }]}
            accessibilityLabel="消息"
            submitBehavior="newline"
          />
          {blocked?.detail ? (
            <Text numberOfLines={2} style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 8, paddingBottom: 4 }]}>
              {blocked.detail}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingLeft: 2 }}>
            <PlusMenu
              canAttachImages={canAttachImages}
              commands={props.commands}
              disabled={inputDisabled || (!canAttachImages && props.commands.length === 0)}
              onPickPhoto={() => void addImage(false)}
              onTakePhoto={() => void addImage(true)}
              onCommand={(name) => setText(`/${name} `)}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flex: 1 }}
              contentContainerStyle={{ gap: 6, alignItems: "center" }}
            >
              <ConfigMenus options={configShown} disabled={!props.online || !!blocked} onChange={props.onConfig} />
            </ScrollView>
            <UsageRing used={props.usage?.usedTokens} window={props.usage?.contextWindow} />
            {turnActive && !hasContent ? (
              <RoundButton label="停止" onPress={() => void stop()} busy={stopping} tone="stop" />
            ) : (
              <RoundButton
                label={turnActive ? (canSteer ? "插话" : "排队") : "发送"}
                wide={turnActive}
                onPress={() => void send()}
                disabled={!hasContent || inputDisabled}
                tone="send"
              />
            )}
          </View>
        </Glass>
      )}
    </View>
  );
}

function RoundButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  wide = false,
  tone,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  wide?: boolean;
  tone: "send" | "stop";
}) {
  const background = tone === "stop" ? colors.label : disabled ? colors.fillStrong : colors.accent;
  const foreground = tone === "stop" ? colors.plain : disabled ? colors.tertiaryLabel : colors.onAccent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({
        height: 34,
        minWidth: 34,
        paddingHorizontal: wide ? 12 : 0,
        borderRadius: 17,
        backgroundColor: background,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : tone === "stop" ? (
        <Icon sf="stop.fill" md="stop" size={12} color={foreground} />
      ) : (
        <Icon sf="arrow.up" md="arrow_upward" size={15} color={foreground} weight="bold" />
      )}
      {wide ? <Text style={[type.footnote, { color: foreground, fontWeight: "700" }]}>{label}</Text> : null}
    </Pressable>
  );
}

function TakeoverPanel({ onTakeover }: { onTakeover: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takeover = async () => {
    haptics.medium();
    setBusy(true);
    setError(null);
    try {
      await onTakeover();
      haptics.success();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Glass style={{ borderRadius: 26, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 13,
            borderCurve: "continuous",
            backgroundColor: colors.fill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon sf="laptopcomputer" md="laptop_mac" size={20} color={colors.label} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>电脑正在操作这个会话</Text>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>接管后在手机上继续，电脑随时能收回</Text>
        </View>
        <Button title="接管" variant="primary" busy={busy} onPress={() => void takeover()} icon={{ sf: "iphone", md: "smartphone" }} />
      </View>
      {error ? (
        <Text selectable style={[type.footnote, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}
    </Glass>
  );
}
