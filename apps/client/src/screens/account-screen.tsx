import { Image } from "expo-image";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconProps } from "@/components/icon";
import { SIGN_UP_URL, useAccount } from "@/lib/account";
import { useConnection } from "@/lib/client";
import { listComputers, useComputers, type Computer } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

// Account and computers, in one sheet: who you are signed in as (which
// brings that account's computers in without pairing), and every computer
// this phone can reach.

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^ws/, "http")).host;
  } catch {
    return url;
  }
}

function Section({ title, footer, children }: { title?: string; footer?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 7 }}>
      {title ? <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 16 }]}>{title}</Text> : null}
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: 16, borderCurve: "continuous", overflow: "hidden" }}>{children}</View>
      {footer ? <Text style={[type.footnote, { color: colors.tertiaryLabel, paddingHorizontal: 16 }]}>{footer}</Text> : null}
    </View>
  );
}

function Separator({ inset = 16 }: { inset?: number }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: inset }} />;
}

function Row({
  icon,
  iconTint = colors.secondaryLabel,
  iconBackground = colors.fill,
  title,
  detail,
  tint = colors.label,
  accessory,
  onPress,
  onLongPress,
}: {
  icon?: Pick<IconProps, "sf" | "md">;
  iconTint?: IconProps["color"];
  iconBackground?: IconProps["color"];
  title: string;
  detail?: string;
  tint?: IconProps["color"];
  accessory?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 52,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: pressed ? colors.fill : undefined,
      })}
    >
      {icon ? (
        <View style={{ width: 30, height: 30, borderRadius: 8, borderCurve: "continuous", backgroundColor: iconBackground, alignItems: "center", justifyContent: "center" }}>
          <Icon {...icon} size={15} color={iconTint} weight="medium" />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={[type.body, { fontSize: 16, color: tint }]}>
          {title}
        </Text>
        {detail ? (
          <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      {accessory}
    </Pressable>
  );
}

function SignInForm() {
  const signIn = useAccount((state) => state.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const ready = /\S+@\S+\.\S+/.test(email) && password.length > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      haptics.success();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const field = { fontSize: 17, color: colors.label, paddingHorizontal: 16, height: 50 };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ alignItems: "center", gap: 8, paddingVertical: 8 }}>
        <Image source={require("../../assets/mark.png")} style={{ width: 68, height: 68 }} contentFit="contain" />
        <Text style={[type.title3, { color: colors.label, marginTop: 4 }]}>登录 LinkShell</Text>
        <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center", paddingHorizontal: 12 }]}>
          电脑上用同一账号运行 linkshell login，它就会自动出现，不用扫码配对
        </Text>
      </View>
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: 16, borderCurve: "continuous", overflow: "hidden" }}>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="邮箱"
          placeholderTextColor={colors.placeholder as string}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          style={field}
        />
        <Separator />
        <TextInput
          ref={passwordRef}
          value={password}
          onChangeText={setPassword}
          placeholder="密码"
          placeholderTextColor={colors.placeholder as string}
          secureTextEntry
          textContentType="password"
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          style={field}
        />
      </View>
      {error ? <Text style={[type.footnote, { color: colors.danger, paddingHorizontal: 16 }]}>{error}</Text> : null}
      <Pressable
        onPress={() => void submit()}
        disabled={!ready}
        style={({ pressed }) => ({
          height: 50,
          borderRadius: 14,
          borderCurve: "continuous",
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
          opacity: !ready ? 0.4 : pressed ? 0.85 : 1,
        })}
      >
        {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={[type.headline, { color: "#ffffff" }]}>登录</Text>}
      </Pressable>
      <Pressable onPress={() => void Linking.openURL(SIGN_UP_URL)} hitSlop={8} style={{ alignSelf: "center", paddingVertical: 4 }}>
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
          还没有账号？<Text style={{ color: colors.accent, fontWeight: "600" }}>在 iTool 注册</Text>
        </Text>
      </Pressable>
    </View>
  );
}

function SignedIn() {
  const session = useAccount((state) => state.session)!;
  const initial = (session.email ?? "?").slice(0, 1).toUpperCase();
  return (
    <Section>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 16 }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 22, fontWeight: "600", color: "#ffffff" }}>{initial}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
            {session.email ?? "已登录"}
          </Text>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>iTool 账号 · 同一账号的电脑自动出现</Text>
        </View>
      </View>
      <Separator inset={0} />
      <Row
        title="退出登录"
        tint={colors.danger}
        onPress={() =>
          Alert.alert("退出登录？", "同一账号下的电脑会从列表里消失，配对过的电脑不受影响。", [
            { text: "取消", style: "cancel" },
            { text: "退出登录", style: "destructive", onPress: () => void useAccount.getState().signOut() },
          ])
        }
      />
    </Section>
  );
}

function ComputerRow({ computer, current }: { computer: Computer; current: boolean }) {
  const relayStatus = useComputers((state) => (computer.kind === "relay" ? state.relayStatus[computer.gateway] : undefined));
  const name = computer.kind === "relay" ? computer.machine.name : computer.name;
  const online = computer.kind === "relay" ? computer.machine.online && relayStatus === "online" : undefined;
  const detail =
    computer.kind === "relay"
      ? `${computer.machine.via === "account" ? "同一账号" : "已配对"} · ${online ? "在线" : relayStatus === "connecting" ? "连接中" : "离线"} · ${hostOf(computer.gateway)}`
      : `局域网 · ${computer.url.replace(/^wss?:\/\//, "")}`;
  const viaAccount = computer.kind === "relay" && computer.machine.via === "account";
  // One that is online and signed in would only come straight back.
  const removable = !viaAccount || !online;
  return (
    <Row
      icon={computer.kind === "relay" ? { sf: "laptopcomputer", md: "laptop_mac" } : { sf: "wifi", md: "wifi" }}
      iconTint={current ? colors.accent : colors.secondaryLabel}
      iconBackground={current ? colors.accentSoft : colors.fill}
      title={name}
      detail={detail}
      accessory={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {online !== undefined ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? colors.ok : colors.tertiaryLabel }} /> : null}
          {current ? <Icon sf="checkmark" md="check" size={14} color={colors.accent} weight="bold" /> : null}
        </View>
      }
      onPress={() => {
        haptics.selection();
        useComputers.getState().select(computer.key);
        router.back();
      }}
      onLongPress={
        removable
          ? () =>
              Alert.alert(`移除「${name}」？`, viaAccount ? "它会从你的账号下移除。如果这台电脑以后重新上线并登录同一账号，会再次出现。" : "之后要重新配对才能连接。", [
                { text: "取消", style: "cancel" },
                {
                  text: "移除",
                  style: "destructive",
                  onPress: () =>
                    void useComputers
                      .getState()
                      .remove(computer.key)
                      .then((removed) => {
                        if (!removed) Alert.alert("没能移除", "这个网关的版本还不支持移除同一账号下的电脑，升级网关后再试。");
                      }),
                },
              ])
          : undefined
      }
    />
  );
}

export function AccountScreen() {
  const insets = useSafeAreaInsets();
  const account = useAccount((state) => state.session);
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const computers = useMemo(() => listComputers({ saved, live }), [saved, live]);
  const { computer: current } = useConnection();

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 22, paddingBottom: 6 }}>
        <Text style={[type.title, { flex: 1, color: colors.label }]}>账号与电脑</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="关闭"
          hitSlop={10}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="xmark" md="close" size={13} color={colors.secondaryLabel} weight="bold" />
        </Pressable>
      </View>
      <View style={{ flex: 1, overflow: "hidden" }}>
        <KeyboardAwareScrollView
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: insets.bottom + 24, gap: 28 }}
        >
          {account ? <SignedIn /> : <SignInForm />}

          <Section title="我的电脑" footer="长按可以移除配对的电脑，或账号下已经离线的电脑。连接始终端到端加密，网关看不到内容。">
            {computers.map((computer, index) => (
              <View key={computer.key}>
                {index > 0 ? <Separator inset={58} /> : null}
                <ComputerRow computer={computer} current={computer.key === current.key} />
              </View>
            ))}
            {computers.length > 0 ? <Separator inset={58} /> : null}
            <Row
              icon={{ sf: "plus", md: "add" }}
              iconTint={colors.accent}
              iconBackground={colors.accentSoft}
              title="添加电脑"
              tint={colors.accent}
              accessory={<Icon sf="qrcode.viewfinder" md="qr_code_scanner" size={16} color={colors.tertiaryLabel} />}
              onPress={() => router.push("/pair")}
            />
          </Section>
        </KeyboardAwareScrollView>
      </View>
    </View>
  );
}
