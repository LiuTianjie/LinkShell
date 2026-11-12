import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Gift, LoaderCircle, RefreshCw } from "lucide-react";
import {
  MONTHLY_UPGRADE_COPY,
  dateLocaleTag,
  itoolMembershipUrl,
  itoolYearlyUpgradeUrl,
  membershipTierLabel,
  t as translate,
  type Locale,
  type ProMembership,
  type ReferralSummary,
} from "@linkshell/client-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { accountMembership, accountReferral } from "./account";
import { useLoad } from "./common";
import { isDesktop, openDesktopExternal } from "./desktop";
import { useLocale } from "./i18n";

function expiry(at: string, locale: Locale): string {
  return new Date(at).toLocaleDateString(dateLocaleTag(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * The signed-in account as one row: initial, address, membership on the line under it, and
 * sign-out at the end. Membership refreshes on its own when the person comes back from paying.
 */
export function AccountSummary({
  email,
  userId,
  disabled,
  signOutLabel,
  onSignOut,
  membership,
  locale,
}: {
  email?: string;
  userId?: string;
  disabled: boolean;
  signOutLabel?: string;
  onSignOut(): void;
  /** Replaces the live lookup; for previews of each state. */
  membership?: ReactNode;
  locale?: Locale;
}) {
  const detectedLocale = useLocale();
  const activeLocale = locale ?? detectedLocale;
  const initial = (email ?? "?").trim().charAt(0).toUpperCase() || "?";
  const resolvedSignOut = signOutLabel ?? translate(activeLocale, "common.signOut");
  return (
    <div className="flex min-w-0 items-center gap-3" aria-label={translate(activeLocale, "nav.account")}>
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-sm font-medium text-muted-foreground"
        aria-hidden
      >
        {initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium" title={email}>
          {email ?? translate(activeLocale, "common.signedIn")}
        </span>
        {membership ?? (userId ? <MembershipLine key={userId} userId={userId} disabled={disabled} locale={activeLocale} /> : null)}
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onSignOut}>
        {resolvedSignOut}
      </Button>
    </div>
  );
}

function MembershipLine({ userId, disabled, locale }: { userId: string; disabled: boolean; locale?: Locale }) {
  const status = useLoad(() => accountMembership(userId), [userId]);
  const membership = status.value;
  // After a trip to itool.tech to pay, coming back to this window is when the answer may change.
  const visitedShop = useRef(false);
  const reload = useRef(status.reload);
  reload.current = status.reload;
  useEffect(() => {
    const back = () => {
      if (!visitedShop.current || document.visibilityState !== "visible") return;
      visitedShop.current = false;
      reload.current();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);

  return (
    <MembershipStatus
      membership={membership}
      loading={status.loading}
      disabled={disabled}
      onRefresh={status.reload}
      onShop={() => {
        visitedShop.current = true;
      }}
      locale={locale}
    />
  );
}

export function MembershipStatus({
  membership,
  loading,
  disabled,
  onRefresh,
  onShop,
  locale,
}: {
  membership?: ProMembership;
  loading: boolean;
  disabled: boolean;
  onRefresh(): void;
  onShop?(): void;
  locale?: Locale;
}) {
  const detectedLocale = useLocale();
  const activeLocale = locale ?? detectedLocale;
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate(activeLocale, key, vars);

  if (loading && !membership) {
    return (
      <span className="text-xs text-muted-foreground" role="status">
        {t("desktop.membership.checking")}
      </span>
    );
  }

  const refreshLabel = t("desktop.membership.refresh");
  const refresh = (
    <button
      type="button"
      className="inline-grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      aria-label={refreshLabel}
      title={refreshLabel}
      disabled={disabled || loading}
      onClick={onRefresh}
    >
      {loading ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
    </button>
  );

  if (!membership) {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive" role="alert">
        {t("desktop.membership.failed")} {refresh}
      </span>
    );
  }

  if (membership.plan === "pro") {
    const isTrial = Boolean(membership.isTrial);
    const rawTrialEnd = membership.trialEndsAt ?? membership.expiresAt;
    const daysRemaining =
      typeof membership.daysRemaining === "number"
        ? membership.daysRemaining
        : isTrial && rawTrialEnd && !Number.isNaN(Date.parse(rawTrialEnd))
          ? Math.max(0, Math.ceil((Date.parse(rawTrialEnd) - Date.now()) / 86_400_000))
          : undefined;
    const trialExpiringSoon = isTrial && daysRemaining !== undefined && daysRemaining <= 2;
    const upgradeCopy = MONTHLY_UPGRADE_COPY[activeLocale] ?? MONTHLY_UPGRADE_COPY.en;
    return (
      <>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {isTrial ? (
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-medium">
              {membershipTierLabel(membership.tier, {
                isTrial: true,
                daysRemaining,
                locale: activeLocale,
              })}
            </Badge>
          ) : (
            <span className="truncate">
              {membershipTierLabel(membership.tier, { locale: activeLocale })}
              {membership.expiresAt ? ` · ${t("desktop.membership.expiresOn", { date: expiry(membership.expiresAt, activeLocale) })}` : ""}
            </span>
          )}
          {isTrial && membership.expiresAt && (
            <span className="truncate">
              {t("desktop.membership.expiresOn", { date: expiry(membership.expiresAt, activeLocale) })}
            </span>
          )}
          {refresh}
        </span>
        {trialExpiringSoon && (
          <div
            className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs text-foreground"
            role="status"
          >
            <span>{t("desktop.membership.trialExpiringBanner", { days: daysRemaining ?? 0 })}</span>
            <ShopLink url={itoolMembershipUrl(activeLocale)} onShop={onShop}>
              {t("desktop.membership.activateOfficialPlan")}
            </ShopLink>
          </div>
        )}
        {!isTrial && membership.tier === "monthly" && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">{upgradeCopy.unlocked} ·</span>
            <ShopLink url={itoolYearlyUpgradeUrl(activeLocale)} onShop={onShop}>
              {upgradeCopy.action}
            </ShopLink>
          </span>
        )}
      </>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span>{t("desktop.membership.notSubscribed")} ·</span>
      <ShopLink url={itoolMembershipUrl(activeLocale)} onShop={onShop}>
        {activeLocale === "zh" ? "开通" : t("desktop.membership.subscribeAction")}
      </ShopLink>
      {refresh}
    </span>
  );
}

/**
 * Invite Friends growth card: displays the signed-in user's referral code, invited/rewarded
 * summary, and 1-click copy share URL.
 */
export function ReferralCard({
  userId,
  referral: initialReferral,
  disabled,
  locale,
  reserveSpace = false,
}: {
  userId?: string;
  referral?: ReferralSummary;
  disabled?: boolean;
  locale?: Locale;
  reserveSpace?: boolean;
}) {
  const detectedLocale = useLocale();
  const activeLocale = locale ?? detectedLocale;
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate(activeLocale, key, vars);
  const loaded = useLoad(
    () => (initialReferral ? Promise.resolve(initialReferral) : userId ? accountReferral(userId, activeLocale) : Promise.resolve(undefined)),
    [userId, activeLocale, initialReferral],
  );
  const summary = initialReferral ?? loaded.value;
  const [copied, setCopied] = useState(false);

  if (!summary && loaded.loading) {
    if (!reserveSpace || !userId) return null;
    return (
      <div
        className="flex min-h-[104px] flex-col justify-between gap-2 rounded-lg border border-border bg-muted/20 p-3"
        aria-busy="true"
      >
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-3.5 w-4/5" />
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-7 w-24" />
        </div>
      </div>
    );
  }
  if (!summary) return null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(summary.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable in non-secure context; ignore silently.
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <Gift className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{t("desktop.membership.referralTitle")}</span>
        </div>
        <Badge variant="secondary" className="shrink-0 font-mono text-[11px]">
          {summary.code}
        </Badge>
      </div>
      <p className="text-muted-foreground leading-relaxed">{t("desktop.membership.referralDesc")}</p>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <span className="text-muted-foreground">
          {t("desktop.membership.referralStats", {
            invited: summary.invited,
            rewarded: summary.rewarded,
            days: summary.earnedDays,
          })}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => void copyLink()}
        >
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? t("desktop.membership.copiedInviteLink") : t("desktop.membership.copyInviteLink")}
        </Button>
      </div>
    </div>
  );
}

/** A link to itool.tech's buy page: a new tab in a browser, the default browser on the desktop. */
function ShopLink({ url, onShop, children }: { url: string; onShop?(): void; children: ReactNode }) {
  return (
    <a
      className="shrink-0 text-link hover:underline"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        onShop?.();
        if (isDesktop) {
          event.preventDefault();
          openDesktopExternal(url);
        }
      }}
    >
      {children}
    </a>
  );
}
