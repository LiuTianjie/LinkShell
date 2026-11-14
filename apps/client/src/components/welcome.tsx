import * as Clipboard from "expo-clipboard";
import { Link, router } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import { MOBILE_LOCALE_OPTIONS, useLocale } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";
import { Button } from "./button";
import { Icon } from "./icon";
import { EmptyState, LoadingState } from "./state-views";
import { useAccount } from "@/lib/account";
import { useConnectionRecovering } from "@/lib/client";
import { listComputers, retryComputerDiscovery, useComputerDiscovery, useComputers } from "@/lib/computers";

const SETUP = "npm i -g linkshell-cli\nlinkshell host --daemon";

const DESKTOP_INSTALL = "https://liutianjie.github.io/LinkShell/#install";

/** Onboarding only after the account's computer list has finished restoring. */
export function Welcome() {
  const { locale, preference, setPreference, t } = useLocale();
  const discovery = useComputerDiscovery();
  const recovering = useConnectionRecovering();
  const account = useAccount((state) => state.session);
  const discovered = useComputers((state) => listComputers(state).length > 0);
  if (discovered || discovery === "loading" || (discovery === "failed" && recovering)) {
    return <LoadingState label={t("welcome.restoringComputers")} />;
  }
  if (discovery === "failed" || discovery === "refused") {
    return (
      <View style={{ gap: 8 }}>
        <EmptyState
          icon={{ sf: "wifi.exclamationmark", md: "wifi_off" }}
          title={discovery === "refused" ? t("welcome.checkConnection") : t("welcome.cannotLoadComputers")}
          message={discovery === "refused" ? t("welcome.connectionRefusedHint") : t("welcome.offlineSavedHint")}
          action={{ title: t("connection.reconnect"), onPress: retryComputerDiscovery }}
        />
        <Button title={t("welcome.accountAndComputers")} variant="plain" onPress={() => router.push("/account")} />
      </View>
    );
  }
  return (
    <View style={{ paddingTop: 16, gap: 18 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>
        {MOBILE_LOCALE_OPTIONS.map((option) => {
          const active = preference === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => {
                haptics.selection();
                setPreference(option.value);
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: active ? colors.accentSoft : colors.fill,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={[type.caption, { color: active ? colors.accent : colors.secondaryLabel, fontWeight: active ? "600" : "500" }]}>
                {option.label(locale)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ alignItems: "center", gap: 10, paddingHorizontal: 12 }}>
        <Icon sf="laptopcomputer" md="laptop_mac" size={40} color={colors.secondaryLabel} />
        <Text style={[type.title3, { color: colors.label, textAlign: "center" }]}>{t("welcome.connectComputerTitle")}</Text>
        <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
          {t("welcome.connectComputerSubtitle")}
        </Text>
      </View>

      <View style={{ backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", padding: 16, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon sf="desktopcomputer" md="desktop_windows" size={20} color={colors.label} />
          <Text style={[type.headline, { color: colors.label }]}>{t("welcome.desktopTitle")}</Text>
        </View>
        <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{t("welcome.desktopDesc")}</Text>
        <Link href={DESKTOP_INSTALL} asChild>
          <Pressable accessibilityRole="link" accessibilityLabel={t("welcome.desktopInstallGuide")} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <View style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[type.subhead, { color: colors.accent, fontWeight: "600" }]}>{t("welcome.desktopInstallGuide")}</Text>
              <Icon sf="arrow.up.right" md="open_in_new" size={15} color={colors.accent} />
            </View>
          </Pressable>
        </Link>
      </View>

      <Pressable
        onPress={() => {
          void Clipboard.setStringAsync(SETUP);
          haptics.success();
        }}
        accessibilityRole="button"
        accessibilityLabel={t("common.copy")}
        style={({ pressed }) => ({ backgroundColor: colors.card, borderRadius: radius.card, borderCurve: "continuous", padding: 16, gap: 10, opacity: pressed ? 0.6 : 1 })}
      >
        <Text style={[type.headline, { color: colors.label }]}>{t("welcome.cliTitle")}</Text>
        <Text selectable style={{ fontFamily: mono, fontSize: 13.5, lineHeight: 21, color: colors.label }}>
          {SETUP}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon sf="doc.on.doc" md="content_copy" size={12} color={colors.tertiaryLabel} />
          <Text style={[type.caption, { flex: 1, color: colors.tertiaryLabel }]}>{t("welcome.cliTapToCopy")}</Text>
        </View>
      </Pressable>

      <View style={{ gap: 10 }}>
        <Button title={t("welcome.scanQrToAdd")} variant="primary" size="large" wide onPress={() => router.push("/pair")} />
        <Button title={account ? t("welcome.accountAndComputers") : t("welcome.signInAccount")} variant="tonal" size="large" wide onPress={() => router.push("/account")} />
        <Button title={t("connection.lanDirect")} variant="plain" onPress={() => router.push("/connect")} />
        <Text style={[type.footnote, { color: colors.tertiaryLabel, textAlign: "center", paddingHorizontal: 12 }]}>
          {t("welcome.footerHint")}
        </Text>
      </View>
    </View>
  );
}
