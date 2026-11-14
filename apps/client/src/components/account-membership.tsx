import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, View } from "react-native";
import {
  dateLocaleTag,
  membershipTierLabel,
  t as translateKey,
  type Locale,
  type ProMembership,
} from "@linkshell/client-core";
import { Text } from "@/components/fixed-text";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { useAccount } from "@/lib/account";
import { loadAccountMembership } from "@/lib/account-membership";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

export interface MobileMembershipPresentation {
  headline: string;
  subtitle: string;
  freeHint?: string;
  isTrial: boolean;
}

export function computeTrialDaysRemaining(membership: ProMembership, nowMs = Date.now()): number | undefined {
  if (typeof membership.daysRemaining === "number" && Number.isFinite(membership.daysRemaining)) {
    return Math.max(1, Math.ceil(membership.daysRemaining));
  }
  const rawEnd = membership.trialEndsAt ?? membership.expiresAt;
  if (!rawEnd) return undefined;
  const until = Date.parse(rawEnd);
  if (!Number.isFinite(until)) return undefined;
  return Math.max(1, Math.ceil((until - nowMs) / 86_400_000));
}

export function formatMobileMembershipState(
  membership: ProMembership | undefined,
  loading: boolean,
  locale: Locale,
  nowMs = Date.now(),
): MobileMembershipPresentation {
  const pro = membership?.plan === "pro";
  if (pro && membership) {
    const isTrial = membership.isTrial === true;
    const daysRemaining = isTrial ? computeTrialDaysRemaining(membership, nowMs) : undefined;
    const headline = membershipTierLabel(membership.tier, {
      isTrial,
      daysRemaining,
      locale,
    });
    const subtitle = membership.expiresAt
      ? translateKey(locale, "mobile.membership.validUntil", {
          date: new Date(membership.expiresAt).toLocaleDateString(dateLocaleTag(locale)),
        })
      : translateKey(locale, "mobile.membership.title");
    return { headline, subtitle, isTrial };
  }
  if (membership?.plan === "free") {
    return {
      headline: translateKey(locale, "mobile.membership.title"),
      subtitle: translateKey(locale, "mobile.membership.freeAccount"),
      freeHint: translateKey(locale, "mobile.membership.freeHint"),
      isTrial: false,
    };
  }
  return {
    headline: translateKey(locale, "mobile.membership.title"),
    subtitle: translateKey(locale, loading ? "mobile.membership.loading" : "mobile.membership.unavailable"),
    isTrial: false,
  };
}

/**
 * Shows the account's iTool entitlement status. The phone never sells anything: zero links,
 * zero URLs, zero prices, and zero buttons leading to a purchase (App Store 3.1.1).
 */
export function AccountMembership({ userId, embedded = false }: { userId: string; embedded?: boolean }) {
  const { locale, t } = useLocale();
  const [membership, setMembership] = useState<ProMembership>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const request = useRef(0);
  const current = useCallback(() => alive.current && useAccount.getState().session?.userId === userId, [userId]);

  useEffect(() => {
    const pending = request;
    alive.current = true;
    return () => {
      alive.current = false;
      pending.current++;
    };
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
      if (current() && attempt === request.current) {
        setError(reason instanceof Error ? reason.message : t("mobile.membership.readFailed"));
      }
    } finally {
      if (current() && attempt === request.current) setLoading(false);
    }
  }, [current, t, userId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      // Account status managed on a computer syncs automatically when returning to the app.
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void refresh();
      });
      return () => subscription.remove();
    }, [refresh]),
  );

  const presentation = formatMobileMembershipState(membership, loading, locale);

  if (embedded) {
    return (
      <View style={{ paddingHorizontal: 16, paddingVertical: 11, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: radius.control,
              borderCurve: "continuous",
              backgroundColor: colors.fill,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon
              sf={presentation.isTrial ? "clock.badge.checkmark" : "sparkles"}
              md={presentation.isTrial ? "schedule" : "auto_awesome"}
              size={15}
              color={colors.secondaryLabel}
              weight="medium"
            />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={1} style={[type.callout, { color: colors.label, fontWeight: "500" }]}>
              {presentation.headline}
            </Text>
            <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel }]}>
              {presentation.subtitle}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              if (loading) return;
              haptics.selection();
              void refresh();
            }}
            disabled={loading}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={loading ? t("mobile.membership.refreshing") : t("mobile.membership.refresh")}
            style={({ pressed }) => ({
              width: 30,
              height: 30,
              borderRadius: 15,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? colors.fill : undefined,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.secondaryLabel} />
            ) : (
              <Icon sf="arrow.clockwise" md="refresh" size={14} color={colors.secondaryLabel} weight="medium" />
            )}
          </Pressable>
        </View>
        {presentation.freeHint ? (
          <Text style={[type.footnote, { color: colors.tertiaryLabel, paddingLeft: 42 }]}>{presentation.freeHint}</Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger, paddingLeft: 42 }]}>
            {error}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: 4 }}>
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: radius.card, borderCurve: "continuous", padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {/* Status is informational only, using neutral fill styling. */}
          <View style={{ width: 30, height: 30, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
            <Icon sf={presentation.isTrial ? "clock.badge.checkmark" : "sparkles"} md={presentation.isTrial ? "schedule" : "auto_awesome"} size={16} color={colors.label} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[type.headline, { color: colors.label }]}>{presentation.headline}</Text>
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{presentation.subtitle}</Text>
          </View>
          {loading ? <ActivityIndicator size="small" color={colors.secondaryLabel} /> : null}
        </View>
        {presentation.freeHint ? (
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{presentation.freeHint}</Text>
        ) : null}
        {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
        {membership || error ? (
          <Button
            title={loading ? t("mobile.membership.refreshing") : t("mobile.membership.refresh")}
            variant="plain"
            onPress={() => void refresh()}
            busy={loading}
          />
        ) : null}
      </View>
    </View>
  );
}
