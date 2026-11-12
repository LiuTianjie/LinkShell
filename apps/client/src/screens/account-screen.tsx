import { router, Stack } from "expo-router";
import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { usePageInsets } from "@/components/adaptive-page";
import Svg, { Path } from "react-native-svg";
import { Icon, type IconProps } from "@/components/icon";
import { AccountMembership } from "@/components/account-membership";
import { SIGN_UP_URL, useAccount, type OAuthProvider } from "@/lib/account";
import { checkForAndroidAppUpdate, currentAppVersion, openAndroidUpdateUrl } from "@/lib/app-update";
import { useContentWidth } from "@/lib/content-width";
import { useConnection } from "@/lib/client";
import { listComputers, useComputers, type Computer } from "@/lib/computers";
import { ComputerSwipe, computerRemovable } from "@/components/computer-swipe";
import { LinkDot } from "@/components/status";
import { haptics } from "@/lib/haptics";
import { MOBILE_LOCALE_OPTIONS, useLocale, type Locale } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

// Account, preferences, and computers on one clean grouped page:
// who you are signed in as, membership state, UI language, and every computer this phone can reach.

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^ws/, "http")).host;
  } catch {
    return url;
  }
}

function localizedSignUpUrl(locale: Locale): string {
  return locale === "zh" ? SIGN_UP_URL : SIGN_UP_URL.replace("/zh/register", "/en/register");
}

function Section({ title, footer, children }: { title?: string; footer?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 7 }}>
      {title ? (
        <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 14 }]}>
          {title}
        </Text>
      ) : null}
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}>
        {children}
      </View>
      {footer ? (
        <Text style={[type.footnote, { color: colors.tertiaryLabel, paddingHorizontal: 14 }]}>
          {footer}
        </Text>
      ) : null}
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
  detailLines = 1,
  tint = colors.label,
  accessory,
  onPress,
  onRemove,
  removeLabel = "移除",
}: {
  icon?: Pick<IconProps, "sf" | "md">;
  iconTint?: IconProps["color"];
  iconBackground?: IconProps["color"];
  title: string;
  detail?: string;
  detailLines?: number;
  tint?: IconProps["color"];
  accessory?: React.ReactNode;
  onPress?: () => void;
  /** Offered to VoiceOver as an action; sighted people swipe the row. */
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityActions={onRemove ? [{ name: "remove", label: removeLabel }] : undefined}
      onAccessibilityAction={
        onRemove
          ? (event) => {
              if (event.nativeEvent.actionName === "remove") onRemove();
            }
          : undefined
      }
      disabled={!onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 50,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: pressed ? colors.fill : undefined,
      })}
    >
      {icon ? (
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: radius.control,
            borderCurve: "continuous",
            backgroundColor: iconBackground,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon {...icon} size={15} color={iconTint} weight="medium" />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={[type.callout, { color: tint }]}>
          {title}
        </Text>
        {detail ? (
          <Text numberOfLines={detailLines} style={[type.footnote, { color: colors.secondaryLabel }]}>
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
  const github = provider === "github";
  const background = colors.sheetCard;
  const foreground = dark ? "#f3f3f6" : "#18181b";
  const title = github ? "GitHub" : "Google";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: 14,
        paddingVertical: 11,
        borderRadius: 24,
        borderCurve: "continuous",
        backgroundColor: background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.separator,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        opacity: disabled && !busy ? 0.5 : pressed ? 0.6 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={foreground} /> : <ProviderMark provider={provider} color={foreground} />}
      <Text style={[type.callout, { color: foreground, fontWeight: "600", flexShrink: 1, textAlign: "center" }]}>{title}</Text>
    </Pressable>
  );
}

function PreferencesSection() {
  const { locale, preference, setPreference, t, pick } = useLocale();
  const [languageExpanded, setLanguageExpanded] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatusText, setUpdateStatusText] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const currentOption = MOBILE_LOCALE_OPTIONS.find((opt) => opt.value === preference) ?? MOBILE_LOCALE_OPTIONS[0]!;

  const checkAndroidUpdate = async () => {
    if (Platform.OS !== "android" || updateBusy) return;
    setUpdateBusy(true);
    try {
      const res = await checkForAndroidAppUpdate();
      if (!res.upToDate && res.latestVersion && res.downloadUrl) {
        setUpdateStatusText(t("android.updateAvailable", { version: `v${res.latestVersion}` }));
        setDownloadUrl(res.downloadUrl);
        Alert.alert(
          t("android.updateAvailable", { version: `v${res.latestVersion}` }),
          res.notes ||
            pick({
              zh: "发现新的 Android 安装包，是否前往下载？",
              en: "A new Android release is available. Open download page?",
              ja: "新しい Android 版が利用可能です。ダウンロードページを開きますか？",
            }),
          [
            { text: t("common.cancel"), style: "cancel" },
            { text: pick({ zh: "下载更新", en: "Download", ja: "ダウンロード" }), onPress: () => void openAndroidUpdateUrl(res.downloadUrl!) },
          ],
        );
      } else {
        setUpdateStatusText(`${t("android.upToDate")} (v${res.currentVersion})`);
        setDownloadUrl(null);
      }
    } catch {
      setUpdateStatusText(pick({ zh: "检查更新失败，请稍后重试", en: "Failed to check for updates", ja: "更新の確認に失敗しました" }));
    } finally {
      setUpdateBusy(false);
    }
  };

  return (
    <Section title={pick({ zh: "偏好设置", en: "Preferences", ja: "設定" })}>
      <Row
        icon={{ sf: "globe", md: "language" }}
        iconTint={colors.secondaryLabel}
        title={t("locale.label")}
        accessory={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{currentOption.label(locale)}</Text>
            <Icon
              sf={languageExpanded ? "chevron.up" : "chevron.down"}
              md={languageExpanded ? "expand_less" : "expand_more"}
              size={12}
              color={colors.tertiaryLabel}
              weight="semibold"
            />
          </View>
        }
        onPress={() => {
          haptics.selection();
          setLanguageExpanded((value) => !value);
        }}
      />
      {languageExpanded
        ? MOBILE_LOCALE_OPTIONS.map((option) => {
            const selected = preference === option.value;
            return (
              <View key={option.value}>
                <Separator inset={58} />
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    haptics.selection();
                    setPreference(option.value);
                    setLanguageExpanded(false);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    minHeight: 44,
                    paddingLeft: 58,
                    paddingRight: 16,
                    backgroundColor: pressed ? colors.fill : undefined,
                  })}
                >
                  <Text style={[type.subhead, { color: selected ? colors.accent : colors.label, fontWeight: selected ? "600" : "400" }]}>
                    {option.label(locale)}
                  </Text>
                  {selected ? <Icon sf="checkmark" md="check" size={14} color={colors.accent} weight="bold" /> : null}
                </Pressable>
              </View>
            );
          })
        : null}
      {Platform.OS === "android" ? (
        <>
          <Separator inset={58} />
          <Row
            icon={{ sf: "arrow.down.circle", md: "system_update" }}
            iconTint={colors.accent}
            title={t("android.checkForUpdate")}
            detail={updateStatusText ?? `v${currentAppVersion()}`}
            accessory={
              updateBusy ? (
                <ActivityIndicator size="small" color={colors.secondaryLabel} />
              ) : downloadUrl ? (
                <Icon sf="arrow.up.right" md="open_in_new" size={14} color={colors.accent} />
              ) : (
                <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} />
              )
            }
            onPress={() => {
              if (downloadUrl) void openAndroidUpdateUrl(downloadUrl);
              else void checkAndroidUpdate();
            }}
          />
        </>
      ) : null}
    </Section>
  );
}

function SignInForm({ width }: { width: number }) {
  const { locale, pick } = useLocale();
  const { fontScale } = useWindowDimensions();
  const providersInline = width >= 320 * fontScale;
  const signIn = useAccount((state) => state.signIn);
  const signInWith = useAccount((state) => state.signInWith);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const emailRef = useRef<TextInput>(null);
  useEffect(() => {
    if (emailOpen) emailRef.current?.focus();
  }, [emailOpen]);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const working = busy || provider !== null;
  const ready = /\S+@\S+\.\S+/.test(email) && password.length > 0 && !working;
  const loginDisabled = working || (emailOpen && !ready);

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

  const field = { ...type.body, color: colors.label, paddingHorizontal: 16, paddingVertical: 13, minHeight: 50 };
  return (
    <View style={{ gap: 24 }}>
      <View style={{ alignItems: "center", gap: 12, paddingTop: 8, paddingBottom: 12 }}>
        <Image source={require("../../assets/mark.png")} style={{ width: 72, height: 72 }} contentFit="contain" />
        <View style={{ alignItems: "center", gap: 8 }}>
          <Text style={[type.title1, { color: colors.label }]}>LinkShell</Text>
          <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
            {pick({
              zh: "电脑上的 Agent，随时跟进",
              en: "Follow, steer & approve your computer's agents anywhere",
              ja: "PC 上のエージェントをどこからでも操作・承認",
            })}
          </Text>
        </View>
      </View>
      <View style={{ gap: 12 }}>
        <View style={{ display: emailOpen ? "flex" : "none", backgroundColor: colors.sheetCard, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden" }}>
          <TextInput
            ref={emailRef}
            value={email}
            onChangeText={setEmail}
            accessibilityLabel={pick({ zh: "邮箱", en: "Email", ja: "メールアドレス" })}
            placeholder={pick({ zh: "iTool 账号邮箱", en: "iTool account email", ja: "iTool アカウントメール" })}
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
            accessibilityLabel={pick({ zh: "密码", en: "Password", ja: "パスワード" })}
            placeholder={pick({ zh: "密码", en: "Password", ja: "パスワード" })}
            placeholderTextColor={colors.placeholder as string}
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            style={field}
          />
        </View>
        {error ? <Text style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}
        <Pressable
          onPress={() => (emailOpen ? void submit() : setEmailOpen(true))}
          disabled={loginDisabled}
          accessibilityRole="button"
          accessibilityLabel={
            emailOpen
              ? pick({ zh: "使用邮箱登录", en: "Sign in with email", ja: "メールでサインイン" })
              : pick({ zh: "登录 LinkShell", en: "Sign in to LinkShell", ja: "LinkShell にサインイン" })
          }
          accessibilityState={{ disabled: loginDisabled, busy }}
          style={({ pressed }) => ({
            minHeight: 52,
            paddingHorizontal: 18,
            paddingVertical: 14,
            borderRadius: 26,
            borderCurve: "continuous",
            backgroundColor: loginDisabled && !busy ? colors.fillStrong : colors.accentFill,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={[type.headline, { color: loginDisabled ? colors.secondaryLabel : colors.onAccent }]}>
              {emailOpen
                ? pick({ zh: "登录", en: "Sign in", ja: "サインイン" })
                : pick({ zh: "登录 LinkShell", en: "Sign in to LinkShell", ja: "LinkShell にサインイン" })}
            </Text>
          )}
        </Pressable>
      </View>
      <View style={{ gap: 12 }}>
        <Text style={[type.caption, { color: colors.tertiaryLabel, textAlign: "center" }]}>
          {pick({ zh: "或使用以下方式登录", en: "Or continue with", ja: "または以下で続行" })}
        </Text>
        <View style={{ flexDirection: providersInline ? "row" : "column", gap: 10 }}>
          <View style={providersInline ? { flex: 1 } : undefined}>
            <ProviderButton provider="github" busy={provider === "github"} disabled={working} onPress={() => void continueWith("github")} />
          </View>
          <View style={providersInline ? { flex: 1 } : undefined}>
            <ProviderButton provider="google" busy={provider === "google"} disabled={working} onPress={() => void continueWith("google")} />
          </View>
        </View>
      </View>
      {emailOpen ? (
        <Pressable
          onPress={() => void Linking.openURL(localizedSignUpUrl(locale))}
          accessibilityRole="link"
          style={{ alignSelf: "center", minHeight: 44, paddingHorizontal: 12, justifyContent: "center" }}
        >
          <Text style={[type.footnote, { color: colors.secondaryLabel, textAlign: "center" }]}>
            {pick({ zh: "还没有账号？", en: "New here? ", ja: "アカウントをお持ちでないですか？ " })}
            <Text style={{ color: colors.accent }}>
              {pick({ zh: "注册 iTool 账号", en: "Create iTool account", ja: "iTool アカウント作成" })}
            </Text>
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function AccountCard({ userId, email }: { userId: string; email?: string }) {
  const { t, pick } = useLocale();
  const initial = (email ?? "?").slice(0, 1).toUpperCase();
  return (
    <Section>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentFill, alignItems: "center", justifyContent: "center" }}>
          <Text style={[type.headline, { fontWeight: "600", color: colors.onAccent }]}>{initial}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
            {email ?? t("common.signedIn")}
          </Text>
          <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel }]}>
            {pick({
              zh: "iTool 账号 · 同账号电脑自动同步",
              en: "iTool account · Syncs computers automatically",
              ja: "iTool アカウント · 同一アカウントの PC を自動同期",
            })}
          </Text>
        </View>
      </View>
      <Separator inset={16} />
      <AccountMembership key={userId} userId={userId} embedded />
    </Section>
  );
}

function SignOutSection() {
  const { t, pick } = useLocale();
  return (
    <Section>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          Alert.alert(
            pick({ zh: "退出登录？", en: "Sign out?", ja: "サインアウトしますか？" }),
            pick({
              zh: "同一账号下的电脑会从列表里隐藏，配对过的电脑不受影响。",
              en: "Account-discovered computers will be hidden; paired computers stay on this device.",
              ja: "アカウント経由の PC は非表示になりますが、ペアリング済みの PC は残ります。",
            }),
            [
              { text: t("common.cancel"), style: "cancel" },
              { text: t("common.signOut"), style: "destructive", onPress: () => void useAccount.getState().signOut() },
            ],
          )
        }
        style={({ pressed }) => ({
          minHeight: 48,
          paddingHorizontal: 16,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? colors.fill : undefined,
        })}
      >
        <Text style={[type.callout, { color: colors.danger, fontWeight: "500" }]}>{t("common.signOut")}</Text>
      </Pressable>
    </Section>
  );
}

function ComputerRow({ computer, current }: { computer: Computer; current: boolean }) {
  const { t, pick } = useLocale();
  const relayStatus = useComputers((state) => (computer.kind === "relay" ? state.relayStatus[computer.gateway] : undefined));
  const name = computer.kind === "relay" ? computer.machine.name : computer.name;
  const online = computer.kind === "relay" ? computer.machine.online && relayStatus === "online" : undefined;
  const viaLabel =
    computer.kind === "relay"
      ? computer.machine.via === "account"
        ? pick({ zh: "同一账号", en: "Same account", ja: "同一アカウント" })
        : pick({ zh: "已配对", en: "Paired", ja: "ペアリング済み" })
      : "";
  const stateLabel = online ? t("connection.online") : relayStatus === "connecting" ? t("connection.connecting") : t("connection.offline");
  const gatewayHost = computer.kind === "relay" ? hostOf(computer.gateway) : "";
  const customGateway = gatewayHost && gatewayHost !== "gateway.itool.tech" ? ` · ${gatewayHost}` : "";
  const lanBadge = computer.kind === "relay" && computer.lanUrl ? " · LAN" : "";
  const detail =
    computer.kind === "relay"
      ? `${stateLabel} · ${viaLabel}${lanBadge}${customGateway}`
      : `${t("connection.lanDirect")} · ${computer.url.replace(/^wss?:\/\//, "")}`;

  return (
    <ComputerSwipe computer={computer} name={name} enabled={computerRemovable(computer, online)} background={colors.sheetCard}>
      {(remove) => (
        <Row
          icon={computer.kind === "relay" ? { sf: "laptopcomputer", md: "laptop_mac" } : { sf: "wifi", md: "wifi" }}
          iconTint={current ? colors.accent : colors.secondaryLabel}
          title={name}
          detail={detail}
          removeLabel={pick({ zh: "移除", en: "Remove", ja: "削除" })}
          accessory={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {online !== undefined ? <LinkDot health={online ? "online" : relayStatus === "connecting" ? "connecting" : "offline"} /> : null}
              {current ? <Icon sf="checkmark" md="check" size={14} color={colors.accent} weight="bold" /> : null}
            </View>
          }
          onPress={() => {
            haptics.selection();
            useComputers.getState().select(computer.key);
            router.back();
          }}
          onRemove={remove}
        />
      )}
    </ComputerSwipe>
  );
}

export function AccountScreen() {
  const { t, pick } = useLocale();
  const insets = usePageInsets();
  const parentWidth = useContentWidth();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const width = measuredWidth ?? parentWidth;
  const { fontScale } = useWindowDimensions();
  const account = useAccount((state) => state.session);
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const computers = useMemo(() => listComputers({ saved, live }), [saved, live]);
  const { computer: current } = useConnection();
  const showManagement = Boolean(account);
  const columns = showManagement && width >= Math.max(760, 720 * fontScale);
  const columnWidth = columns ? Math.min(440, (width - 64) / 2) : Math.min(account ? 440 : 420, width - 32);

  const computersFooter = pick({
    zh: `${computers.length ? "向左滑动可移除电脑 · " : ""}所有账号、配对与局域网隧道通信均端到端加密。`,
    en: `${computers.length ? "Swipe left to remove · " : ""}All account, paired, and LAN tunnels are end-to-end encrypted.`,
    ja: `${computers.length ? "左スワイプで削除 · " : ""}すべての接続はエンドツーエンドで暗号化されます。`,
  });

  return (
    <KeyboardAwareScrollView
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="never"
      style={{ flex: 1, backgroundColor: colors.sheet }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: showManagement ? "flex-start" : "center",
        paddingHorizontal: 16,
        paddingTop: insets.top + 12,
        paddingBottom: insets.bottom + 28,
      }}
    >
      <Stack.Screen
        options={{
          title: account ? t("nav.account") : "",
          headerLargeTitleEnabled: false,
          headerTransparent: !account,
          headerShadowVisible: false,
        }}
      />
      <View style={{ flexDirection: columns ? "row" : "column", alignItems: columns ? "flex-start" : "center", justifyContent: "center", gap: columns ? 28 : 20 }}>
        <View style={{ width: columnWidth, minWidth: 0, gap: 20 }}>
          {account ? <AccountCard userId={account.userId} email={account.email} /> : <SignInForm width={columnWidth} />}
          <PreferencesSection />
          {!showManagement && computers.length > 0 ? (
            <Section title={`${t("nav.computers")} (${computers.length})`}>
              {computers.map((computer, index) => (
                <View key={computer.key}>
                  {index > 0 ? <Separator inset={58} /> : null}
                  <ComputerRow computer={computer} current={computer.key === current.key} />
                </View>
              ))}
            </Section>
          ) : null}
          {!showManagement ? (
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 16 }}>
              <Pressable
                onPress={() => router.push("/pair")}
                accessibilityRole="button"
                style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}
              >
                <Text style={[type.footnote, { color: colors.secondaryLabel, textAlign: "center" }]}>{t("welcome.scanQrToAdd")}</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push("/connect")}
                accessibilityRole="button"
                style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}
              >
                <Text style={[type.footnote, { color: colors.secondaryLabel, textAlign: "center" }]}>{t("connection.lanDirect")}</Text>
              </Pressable>
            </View>
          ) : null}
          {columns && account ? <SignOutSection /> : null}
        </View>

        {showManagement ? (
          <View style={{ width: columnWidth, minWidth: 0, gap: 20 }}>
            <Section
              title={`${t("nav.computers")}${computers.length > 0 ? ` (${computers.length})` : ""}`}
              footer={computersFooter}
            >
              {computers.length === 0 ? (
                <View style={{ paddingHorizontal: 16, paddingVertical: 16, gap: 4 }}>
                  <Text style={[type.callout, { color: colors.label, fontWeight: "500" }]}>
                    {pick({ zh: "暂无已连接的电脑", en: "No computers yet", ja: "PC がまだありません" })}
                  </Text>
                  <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
                    {pick({
                      zh: "在电脑端登录同一账号即可自动出现，也可通过下方方式添加。",
                      en: "Sign in to the same account on your computer, or add one below.",
                      ja: "PC で同じアカウントにサインインするか、下から追加できます。",
                    })}
                  </Text>
                </View>
              ) : (
                computers.map((computer, index) => (
                  <View key={computer.key}>
                    {index > 0 ? <Separator inset={58} /> : null}
                    <ComputerRow computer={computer} current={computer.key === current.key} />
                  </View>
                ))
              )}
              <Separator inset={16} />
              <Row
                icon={{ sf: "qrcode.viewfinder", md: "qr_code_scanner" }}
                iconTint={colors.accent}
                title={t("welcome.scanQrToAdd")}
                accessory={<Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} weight="semibold" />}
                onPress={() => router.push("/pair")}
              />
              <Separator inset={58} />
              <Row
                icon={{ sf: "wifi", md: "wifi" }}
                iconTint={colors.accent}
                title={t("connection.lanDirect")}
                accessory={<Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} weight="semibold" />}
                onPress={() => router.push("/connect")}
              />
            </Section>
            {!columns && account ? <SignOutSection /> : null}
          </View>
        ) : null}
      </View>
    </KeyboardAwareScrollView>
  );
}
