import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { membershipTierLabel, type ProMembership } from "@linkshell/client-core";
import { Text } from "@/components/fixed-text";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { useAccount } from "@/lib/account";
import { loadAccountMembership } from "@/lib/account-membership";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

/**
 * Shows the account's iTool membership. The phone never sells it: no link, no price, no button
 * that leads to a purchase (App Store rules). People open it on a computer, then this refreshes.
 */
export function AccountMembership({ userId }: { userId: string }) {
  const [membership, setMembership] = useState<ProMembership>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const request = useRef(0);
  const current = useCallback(() => alive.current && useAccount.getState().session?.userId === userId, [userId]);

  useEffect(() => {
    const pending = request;
    alive.current = true;
    return () => { alive.current = false; pending.current++; };
  }, []);

  const refresh = useCallback(async () => {
    if (!current()) return;
    const attempt = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await loadAccountMembership(userId);
      if (current() && attempt === request.current) setMembership(next);
    } catch (reason) {
      // A failed read keeps what was last known; it says nothing about the account.
      if (current() && attempt === request.current) setError(reason instanceof Error ? reason.message : "会员状态读取失败，请重试");
    } finally {
      if (current() && attempt === request.current) setLoading(false);
    }
  }, [current, userId]);

  useFocusEffect(useCallback(() => {
    void refresh();
    // A membership opened on a computer shows up when the app comes back to the front.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]));

  const pro = membership?.plan === "pro";
  return (
    <View style={{ gap: 4 }}>
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: radius.card, borderCurve: "continuous", padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {/* Membership is a plain fact, so its mark is grey like every other tile. */}
          <View style={{ width: 30, height: 30, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
            <Icon sf="sparkles" md="auto_awesome" size={16} color={colors.label} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[type.headline, { color: colors.label }]}>{pro ? membershipTierLabel(membership.tier) : "iTool 会员"}</Text>
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
              {pro && membership.expiresAt
                ? `LinkShell 有效期至 ${new Date(membership.expiresAt).toLocaleDateString("zh-CN")}`
                : membership ? "普通账户" : loading ? "正在确认会员状态" : "会员状态暂不可用"}
            </Text>
          </View>
          {loading ? <ActivityIndicator size="small" color={colors.secondaryLabel} /> : null}
        </View>
        {membership?.plan === "free" ? (
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
            官方网关需要 iTool 会员。在电脑浏览器打开 itool.tech/pro 开通会员，回到这里即可生效。
          </Text>
        ) : null}
        {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
        {membership || error ? <Button title={loading ? "正在刷新…" : "刷新会员状态"} variant="plain" onPress={() => void refresh()} busy={loading} /> : null}
      </View>
    </View>
  );
}
