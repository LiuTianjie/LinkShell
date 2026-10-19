import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, View } from "react-native";
import { PRO_CODE_SHOP_URL, type ProMembership } from "@linkshell/client-core";
import { Text, TextInput } from "@/components/fixed-text";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { useAccount } from "@/lib/account";
import { loadAccountMembership, redeemAccountCode } from "@/lib/account-membership";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function AccountMembership({ userId }: { userId: string }) {
  const [membership, setMembership] = useState<ProMembership>();
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const alive = useRef(true);
  const submitting = useRef(false);
  const request = useRef(0);
  const current = useCallback(() => alive.current && useAccount.getState().session?.userId === userId, [userId]);

  useEffect(() => {
    const pending = request;
    alive.current = true;
    return () => { alive.current = false; pending.current++; };
  }, []);

  const refresh = useCallback(async () => {
    if (submitting.current || !current()) return;
    const attempt = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await loadAccountMembership(userId);
      if (current() && attempt === request.current) setMembership(next);
    } catch (reason) {
      if (current() && attempt === request.current) setError(reason instanceof Error ? reason.message : "会员状态读取失败，请重试");
    } finally {
      if (current() && attempt === request.current) setLoading(false);
    }
  }, [current, userId]);

  useFocusEffect(useCallback(() => {
    void refresh();
    // Returning from the shop or iTool may change the account's membership.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]));

  const redeem = async () => {
    if (submitting.current || loading || !code.trim() || membership?.plan !== "free" || !current()) return;
    submitting.current = true;
    request.current++;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await redeemAccountCode(userId, code);
      if (!current()) return;
      setMembership({ plan: "pro", expiresAt: result.expiresAt });
      setCode("");
      setSuccess(result.idempotent ? "此激活码已兑换到当前账号，Pro 权益已同步。" : "兑换成功，Pro 已生效。");
      haptics.success();
      // A successful redemption remains successful if the subsequent profile read fails.
      const next = await loadAccountMembership(userId).catch(() => undefined);
      if (current() && next?.plan === "pro") setMembership(next);
    } catch (reason) {
      if (!current()) return;
      haptics.error();
      setError(reason instanceof Error ? reason.message : "兑换失败，请稍后重试");
    } finally {
      submitting.current = false;
      if (current()) setBusy(false);
    }
  };

  const pro = membership?.plan === "pro";
  return (
    <View style={{ gap: 4 }}>
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: 16, borderCurve: "continuous", padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }}>
            <Icon sf="sparkles" md="auto_awesome" size={16} color={colors.accent} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[type.headline, { color: colors.label }]}>{pro ? "Pro 会员" : "LinkShell Pro"}</Text>
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
              {pro && membership.expiresAt
                ? `有效期至 ${new Date(membership.expiresAt).toLocaleDateString("zh-CN")}`
                : membership ? "普通账户 · 兑换激活码，开通 Pro" : loading ? "正在确认会员状态" : "会员状态暂不可用"}
            </Text>
          </View>
          {loading ? <ActivityIndicator size="small" color={colors.secondaryLabel} /> : null}
        </View>
        {success ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.ok }]}>{success}</Text> : null}
        {membership?.plan === "free" ? <View style={{ gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>激活码</Text>
            <TextInput
              value={code}
              onChangeText={(value) => { setCode(value); setError(undefined); }}
              accessibilityLabel="Pro 激活码"
              placeholder="输入或粘贴激活码"
              placeholderTextColor={colors.tertiaryLabel}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              editable={!busy}
              returnKeyType="done"
              onSubmitEditing={() => void redeem()}
              style={{ color: colors.label, backgroundColor: colors.fill, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator, paddingHorizontal: 12, paddingVertical: 12, minHeight: 48, fontSize: 15 }}
            />
          </View>
          <Button title={busy ? "正在兑换…" : "兑换 Pro"} variant="primary" size="large" busy={busy} disabled={loading || !code.trim()} onPress={() => void redeem()} />
        </View> : null}
        {error ? <View style={{ gap: 6 }}>
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger }]}>{error}</Text>
          {!membership ? <Button title="重新读取会员状态" variant="plain" onPress={() => void refresh()} busy={loading} /> : null}
        </View> : null}
      </View>
      {membership?.plan === "free" ? <Pressable
        accessibilityRole="link"
        accessibilityLabel="没有激活码？前往链动小铺"
        onPress={() => void Linking.openURL(PRO_CODE_SHOP_URL).catch(() => setError("暂时无法打开链动小铺，请稍后重试"))}
        style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, opacity: pressed ? 0.6 : 1 })}
      >
        <Text style={[type.footnote, { color: colors.secondaryLabel, textAlign: "center" }]}>没有激活码？<Text style={{ color: colors.accent }}>前往链动小铺 ↗</Text></Text>
      </Pressable> : null}
    </View>
  );
}
