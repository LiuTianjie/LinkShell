import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { usePageInsets } from "@/components/adaptive-page";
import { Text, TextInput } from "@/components/fixed-text";
import { Icon } from "@/components/icon";
import { SheetHeader } from "@/components/sheet-header";
import { useClient, useConnection } from "@/lib/client";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

/** Asks for the current computer's access password (its status is `locked`). */
export function UnlockScreen() {
  const insets = usePageInsets();
  const { computer } = useConnection();
  const names = useComputerNames((state) => state.names);
  const status = useClient((state) => state.status);
  const unlock = useClient((state) => state.unlock);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const name = computerDisplayName(computer, names);

  // Unlocked (here, or by a saved token on reconnect), or switched away: nothing left to ask.
  useEffect(() => {
    if (status === "online") router.back();
  }, [status]);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      await unlock(password);
      haptics.success();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAwareScrollView contentInsetAdjustmentBehavior="never" style={{ flex: 1, backgroundColor: colors.sheet }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: insets.bottom + 24, gap: 14 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" bottomOffset={20}>
      <SheetHeader title="访问密码" actions={[{ key: "unlock", label: busy ? "正在解锁" : "解锁", icon: { sf: "lock.open", md: "lock_open" }, onPress: () => void submit(), disabled: !password || busy || status !== "locked", prominent: true }]} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 }}>
        <Icon sf="lock.fill" md="lock" size={16} color={colors.secondaryLabel} />
        <Text style={[type.subhead, { flex: 1, color: colors.secondaryLabel }]}>{name} 设置了访问密码，输入后继续。</Text>
      </View>
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: 16, borderCurve: "continuous", paddingHorizontal: 16, borderWidth: error ? 1 : 0, borderColor: colors.danger }}>
        <TextInput value={password} onChangeText={(text) => { setPassword(text); setError(""); }} autoFocus secureTextEntry
          textContentType="password" autoComplete="current-password" autoCapitalize="none" autoCorrect={false}
          accessibilityLabel="访问密码" placeholder="访问密码" placeholderTextColor={colors.placeholder as string}
          returnKeyType="go" onSubmitEditing={() => void submit()} maxLength={128} editable={!busy}
          style={[type.body, { fontSize: 17, minHeight: 52, color: colors.label, paddingVertical: 13 }]} />
      </View>
      {error ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}
      <Text style={[type.footnote, { color: colors.tertiaryLabel, paddingHorizontal: 4 }]}>密码在那台电脑上设置。解锁后这台手机会记住 7 天，期间重新连接不用再输。</Text>
    </KeyboardAwareScrollView>
  );
}
