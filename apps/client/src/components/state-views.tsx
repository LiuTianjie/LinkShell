import { router } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { getMobileLocale, pickLocaleText } from "@/lib/locale";
import { Text } from "@/components/fixed-text";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Button } from "./button";
import { Icon, type IconProps } from "./icon";

export function LoadingState({ label }: { label?: string }) {
  return (
    <View style={{ paddingVertical: 64, alignItems: "center", gap: 12 }}>
      <ActivityIndicator color={colors.secondaryLabel} />
      {label ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{label}</Text> : null}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: Pick<IconProps, "sf" | "md">;
  title: string;
  message?: string;
  action?: { title: string; onPress: () => void };
}) {
  return (
    <View style={{ paddingVertical: 56, paddingHorizontal: 32, alignItems: "center", gap: 10 }}>
      {/* The symbol alone, as system empty states draw it: a tinted square behind it reads as decoration. */}
      <View style={{ marginBottom: 4 }}>
        <Icon {...icon} size={40} color={colors.secondaryLabel} />
      </View>
      <Text style={[type.headline, { color: colors.label, textAlign: "center" }]}>{title}</Text>
      {message ? (
        <Text selectable style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center", maxWidth: 300 }]}>
          {message}
        </Text>
      ) : null}
      {action ? <Button title={action.title} onPress={action.onPress} variant="tonal" style={{ marginTop: 8 }} /> : null}
    </View>
  );
}

/**
 * Nothing loaded and the computer out of reach: say what will appear, without
 * a spinner that can't finish (the connection banner says why).
 */
export function WaitingForComputer({ what }: { what: string }) {
  const locale = getMobileLocale();
  return (
    <EmptyState
      icon={{ sf: "laptopcomputer", md: "laptop_mac" }}
      title={pickLocaleText(locale, { zh: "等电脑连上", en: "Waiting for the computer", ja: "PC の接続待ち" })}
      message={pickLocaleText(locale, { zh: `连上之后，这里会显示${what}。`, en: `Once it is connected, ${what} will show here.`, ja: `接続されると、ここに${what}が表示されます。` })}
    />
  );
}

/** True while there is no way to load anything: the link is retrying or stopped. */
export function unreachable(status: string): boolean {
  return status === "reconnecting" || status === "stopped";
}

/**
 * The computer has an access password this phone hasn't given: nothing loads until it does, so
 * a spinner here would never end. Says so and offers the one next step.
 */
export function LockedComputer() {
  const locale = getMobileLocale();
  return (
    <EmptyState
      icon={{ sf: "lock", md: "lock" }}
      title={pickLocaleText(locale, { zh: "这台电脑设置了访问密码", en: "This computer has an access password", ja: "この PC にはアクセスパスワードがあります" })}
      message={pickLocaleText(locale, { zh: "输入密码后才能查看和操作。", en: "Enter it to see and control this computer.", ja: "入力すると表示と操作ができます。" })}
      action={{ title: pickLocaleText(locale, { zh: "输入访问密码", en: "Enter Password", ja: "パスワードを入力" }), onPress: () => router.push("/unlock") }}
    />
  );
}
