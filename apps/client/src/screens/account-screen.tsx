import { Image } from "expo-image";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Icon, type IconProps } from "@/components/icon";
import { SIGN_UP_URL, useAccount, type OAuthProvider } from "@/lib/account";
import { useConnection } from "@/lib/client";
import { listComputers, useComputers, type Computer } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

// Account and computers, on one page: who you are signed in as (which
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

const GITHUB_PATH =
  "M12 2C6.477 2 2 6.486 2 12.021c0 4.424 2.865 8.17 6.839 9.504.5.093.682-.217.682-.483 0-.237-.009-.866-.013-1.7-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.622.069-.609.069-.609 1.004.071 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.833.091-.647.35-1.088.636-1.339-2.22-.253-4.555-1.113-4.555-4.952 0-1.093.39-1.988 1.029-2.688-.103-.254-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.56 9.56 0 0 1 2.504.337c1.909-1.296 2.748-1.026 2.748-1.026.546 1.378.202 2.396.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.31.679.922.679 1.859 0 1.34-.012 2.419-.012 2.748 0 .268.18.58.688.481A10.019 10.019 0 0 0 22 12.021C22 6.486 17.523 2 12 2Z";

function ProviderMark({ provider, color }: { provider: OAuthProvider; color: string }) {
  if (provider === "github") {
    return (
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path fill={color} d={GITHUB_PATH} />
      </Svg>
    );
  }
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24">
      <Path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <Path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <Path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <Path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </Svg>
  );
}

function ProviderButton({ provider, busy, disabled, onPress }: { provider: OAuthProvider; busy: boolean; disabled: boolean; onPress: () => void }) {
  const dark = useColorScheme() === "dark";
  // GitHub's own button is its mark on near-black (white in dark mode); Google's is plain.
  const github = provider === "github";
  const background = github ? (dark ? "#f3f3f6" : "#18181b") : colors.sheetCard;
  const foreground = github ? (dark ? "#18181b" : "#ffffff") : (colors.label as string);
  const title = github ? "使用 GitHub 登录" : "使用 Google 登录";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => ({
        height: 50,
        borderRadius: 14,
        borderCurve: "continuous",
        backgroundColor: background,
        borderWidth: github ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors.separator,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        opacity: disabled && !busy ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={foreground} /> : <ProviderMark provider={provider} color={foreground} />}
      <Text style={[type.headline, { color: foreground }]}>{title}</Text>
    </Pressable>
  );
}

function SignInForm() {
  const signIn = useAccount((state) => state.signIn);
  const signInWith = useAccount((state) => state.signInWith);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const working = busy || provider !== null;
  const ready = /\S+@\S+\.\S+/.test(email) && password.length > 0 && !working;

  const continueWith = async (next: OAuthProvider) => {
    if (working) return;
    haptics.selection();
    setProvider(next);
    setError(null);
    try {
      if (await signInWith(next)) haptics.success();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProvider(null);
    }
  };

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
          iTool 账号。电脑上用同一账号运行 linkshell login，它就会自动出现，不用扫码配对
        </Text>
      </View>
      <View style={{ gap: 10 }}>
        <ProviderButton provider="github" busy={provider === "github"} disabled={working} onPress={() => void continueWith("github")} />
        <ProviderButton provider="google" busy={provider === "google"} disabled={working} onPress={() => void continueWith("google")} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 }}>
        <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
        <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>或用邮箱登录</Text>
        <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
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
          还没有账号？<Text style={{ color: colors.accent, fontWeight: "600" }}>在 iTool 注册</Text>，GitHub 和 Google 不用注册
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
        <KeyboardAwareScrollView
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
          // The scroll view is the screen's root, so the large title collapses with it.
          contentInsetAdjustmentBehavior="automatic"
          style={{ flex: 1, backgroundColor: colors.sheet }}
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
  );
}
