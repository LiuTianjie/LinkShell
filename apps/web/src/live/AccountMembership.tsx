import { useEffect, useRef } from "react";
import { ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import { ITOOL_MEMBERSHIP_URL, membershipTierLabel } from "@linkshell/client-core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldGroup } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { accountMembership } from "./account";
import { LoadState, useLoad } from "./common";

export function AccountMembership({
  userId,
  disabled,
}: {
  userId: string;
  disabled: boolean;
}) {
  const status = useLoad(() => accountMembership(userId), [userId]);
  const membership = status.value;
  // After a trip to itool.tech to pay, coming back to this tab is when the answer may change.
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
    <section className="flex min-w-0 flex-col gap-4" aria-label="iTool 会员">
      <Separator />
      {status.loading && !membership ? (
        <LoadState loading />
      ) : status.error && !membership ? (
        <Alert variant="destructive">
          <AlertTitle>暂时无法获取会员状态</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <p>{status.error}</p>
            <Button type="button" variant="outline" onClick={status.reload}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : membership?.plan === "pro" ? (
        <Alert variant="success" role="status">
          <AlertTitle>{membershipTierLabel(membership.tier)}</AlertTitle>
          <AlertDescription>
            {membership.expiresAt
              ? `LinkShell 有效期至 ${new Date(membership.expiresAt).toLocaleDateString(
                  "zh-CN",
                  { year: "numeric", month: "long", day: "numeric" },
                )}`
              : "会员权益已生效"}
          </AlertDescription>
        </Alert>
      ) : membership ? (
        <FieldGroup>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">开通 iTool 会员</span>
            <Badge variant="secondary">普通账户</Badge>
          </div>
          <FieldDescription>
            月度会员 ¥9.9 包含 LinkShell 官方网关和 iTool 网站，年度会员 ¥99 包含全部 iTool 产品。在 itool.tech 用同一账号开通，支付宝付款。
          </FieldDescription>
          <Button asChild disabled={disabled}>
            <a
              href={ITOOL_MEMBERSHIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => { visitedShop.current = true; }}
            >
              开通 iTool 会员 <ArrowUpRight data-icon="inline-end" aria-hidden />
            </a>
          </Button>
        </FieldGroup>
      ) : null}
      {membership && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || status.loading}
          onClick={status.reload}
        >
          {status.loading ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          {membership.plan === "pro" ? "刷新会员状态" : "已付款？刷新会员状态"}
        </Button>
      )}
      {status.error && membership && (
        <p className="field-hint" role="alert">{status.error}</p>
      )}
      <Separator />
    </section>
  );
}
