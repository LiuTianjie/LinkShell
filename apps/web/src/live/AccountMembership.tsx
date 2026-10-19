import { useId, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { PRO_CODE_SHOP_URL, type ProMembership } from "@linkshell/client-core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { accountMembership, redeemAccountProCode } from "./account";
import { LoadState, useJob, useLoad } from "./common";

export function AccountMembership({
  userId,
  disabled,
}: {
  userId: string;
  disabled: boolean;
}) {
  const id = useId();
  const [code, setCode] = useState("");
  const [redeemed, setRedeemed] = useState<ProMembership>();
  const status = useLoad(() => accountMembership(userId), [userId]);
  const job = useJob();
  // Keep the successful receipt visible if the follow-up profile read is delayed.
  const membership =
    status.value?.plan === "pro" ? status.value : (redeemed ?? status.value);

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Pro 会员">
      <Separator />
      {status.loading && !redeemed ? (
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
        <>
          <Alert variant="success" role="status">
            <AlertTitle>
              {redeemed ? "兑换成功，Pro 已激活" : "Pro 会员"}
            </AlertTitle>
            <AlertDescription>
              {membership.expiresAt
                ? `有效期至 ${new Date(membership.expiresAt).toLocaleString(
                    "zh-CN",
                    {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    },
                  )}`
                : "Pro 权益已生效"}
            </AlertDescription>
          </Alert>
          {status.error && (
            <Alert variant="warning">
              <AlertTitle>会员信息暂时未能刷新</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <p>兑换结果已保存，可稍后重试刷新。</p>
                <Button type="button" variant="outline" onClick={status.reload}>
                  刷新会员状态
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : membership ? (
        <form
          aria-label="兑换 Pro 激活码"
          aria-busy={job.busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || job.busy || !code.trim()) return;
            void job.run(async () => {
              const result = await redeemAccountProCode(userId, code.trim());
              setRedeemed({ plan: "pro", expiresAt: result.expiresAt });
              setCode("");
              status.reload();
            });
          }}
        >
          <FieldGroup>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">升级 Pro</span>
              <Badge variant="secondary">普通账户</Badge>
            </div>
            <Field
              data-disabled={disabled || job.busy}
              data-invalid={!!job.error}
            >
              <FieldLabel htmlFor={`${id}-code`}>激活码</FieldLabel>
              <Input
                id={`${id}-code`}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  job.clear();
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="输入 Pro 激活码"
                disabled={disabled || job.busy}
                aria-invalid={!!job.error}
                aria-describedby={
                  job.error ? `${id}-error` : `${id}-description`
                }
                required
              />
              <FieldDescription id={`${id}-description`}>
                兑换后，当前 iTool 账户即可使用 Pro 权益。
              </FieldDescription>
              {job.error && (
                <FieldError id={`${id}-error`}>{job.error}</FieldError>
              )}
            </Field>
            <Button
              type="submit"
              disabled={disabled || job.busy || !code.trim()}
            >
              {job.busy && (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              )}
              {job.busy ? "正在兑换…" : "兑换并升级 Pro"}
            </Button>
            <FieldDescription>
              没有激活码？{" "}
              <a
                href={PRO_CODE_SHOP_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                前往链动小铺 ↗
              </a>
            </FieldDescription>
          </FieldGroup>
        </form>
      ) : null}
      <Separator />
    </section>
  );
}
