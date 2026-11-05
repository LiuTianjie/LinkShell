import { useEffect, useRef, type ReactNode } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { ITOOL_MEMBERSHIP_URL, membershipTierLabel, type ProMembership } from "@linkshell/client-core";
import { Button } from "@/components/ui/button";
import { accountMembership } from "./account";
import { useLoad } from "./common";
import { isDesktop, openDesktopExternal } from "./desktop";

function expiry(at: string): string {
  return new Date(at).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * The signed-in account as one row: initial, address, membership on the line under it, and
 * sign-out at the end. Membership refreshes on its own when the person comes back from paying.
 */
export function AccountSummary({
  email,
  userId,
  disabled,
  signOutLabel = "退出",
  onSignOut,
  membership,
}: {
  email?: string;
  userId?: string;
  disabled: boolean;
  signOutLabel?: string;
  onSignOut(): void;
  /** Replaces the live lookup; for previews of each state. */
  membership?: ReactNode;
}) {
  const initial = (email ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="flex min-w-0 items-center gap-3" aria-label="iTool 账号">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-sm font-medium text-muted-foreground"
        aria-hidden
      >
        {initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium" title={email}>{email ?? "已登录"}</span>
        {membership ?? (userId ? <MembershipLine key={userId} userId={userId} disabled={disabled} /> : null)}
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onSignOut}>
        {signOutLabel}
      </Button>
    </div>
  );
}

function MembershipLine({ userId, disabled }: { userId: string; disabled: boolean }) {
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
      onShop={() => { visitedShop.current = true; }}
    />
  );
}

export function MembershipStatus({
  membership,
  loading,
  disabled,
  onRefresh,
  onShop,
}: {
  membership?: ProMembership;
  loading: boolean;
  disabled: boolean;
  onRefresh(): void;
  onShop?(): void;
}) {
  if (loading && !membership) return <span className="text-xs text-muted-foreground" role="status">正在查询会员…</span>;

  const refresh = (
    <button
      type="button"
      className="inline-grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      aria-label="刷新会员状态"
      title="刷新会员状态"
      disabled={disabled || loading}
      onClick={onRefresh}
    >
      {loading ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
    </button>
  );

  if (!membership) {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive" role="alert">
        会员状态获取失败 {refresh}
      </span>
    );
  }

  if (membership.plan === "pro") {
    return (
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">
          {membershipTierLabel(membership.tier)}
          {membership.expiresAt ? ` · ${expiry(membership.expiresAt)}到期` : ""}
        </span>
        {refresh}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span>未开通会员 ·</span>
      <a
        className="text-link hover:underline"
        href={ITOOL_MEMBERSHIP_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          onShop?.();
          if (isDesktop) {
            event.preventDefault();
            openDesktopExternal(ITOOL_MEMBERSHIP_URL);
          }
        }}
      >
        开通
      </a>
      {refresh}
    </span>
  );
}
