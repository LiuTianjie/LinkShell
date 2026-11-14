import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { ReferralSummary } from "@linkshell/client-core";
import { openExternalUrl } from "../../bridge/desktop-bridge";
import { fetchDesktopReferralSummary, type SignInMethod } from "../../core";
import { DesktopIcon } from "../../icons";
import { Badge, Button, CopyButton, Field, IconButton, Input } from "../../primitives";
import { isImeComposing } from "../../primitives/utils";
import { useSystemI18n } from "./system-i18n";

export type OAuthProvider = "github" | "google";

const SIGN_UP_URLS = {
  zh: "https://itool.tech/zh/register",
  en: "https://itool.tech/en/register",
  ja: "https://itool.tech/en/register",
} as const;

const FORGOT_PASSWORD_URLS = {
  zh: "https://itool.tech/zh/forgot-password",
  en: "https://itool.tech/en/forgot-password",
  ja: "https://itool.tech/en/forgot-password",
} as const;

const STILL_WAITING_MS = 45_000;

function GitHubBrandSvg() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GoogleBrandSvg() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

function ExternalTextLink({
  href,
  children,
}: {
  href: string;
  children: string;
}) {
  const onClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openExternalUrl(href);
  };
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="ls-signin-link"
      onClick={onClick}
    >
      {children}
    </a>
  );
}

export interface SignInFormProps {
  pending?: SignInMethod;
  link?: string;
  error?: string;
  disabled?: boolean;
  showZeroLoginNote?: boolean;
  onPassword: (email: string, password: string) => void;
  onProvider: (provider: OAuthProvider) => void;
  onBrowser: () => void;
  onCancel: () => void;
  onEdit?: () => void;
}

export function SignInForm({
  pending,
  link,
  error,
  disabled = false,
  showZeroLoginNote = false,
  onPassword,
  onProvider,
  onBrowser,
  onCancel,
  onEdit,
}: SignInFormProps) {
  const { locale, ts } = useSystemI18n();
  const baseId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [validation, setValidation] = useState<{
    field: "email" | "password";
    message: string;
  }>();
  const emailRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const waitingOnBrowser = pending !== undefined && pending !== "password";
  const blocked = disabled || pending !== undefined;
  const shownError = validation?.message ?? (error ? error : undefined);

  const handleEdited = () => {
    setValidation(undefined);
    onEdit?.();
  };

  const handleSubmit = () => {
    if (blocked) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setValidation({ field: "email", message: ts("authModal.errEmptyEmail") });
      emailRef.current?.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+$/.test(trimmedEmail)) {
      setValidation({ field: "email", message: ts("authModal.errBadEmail") });
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      if (document.activeElement === emailRef.current) {
        setValidation(undefined);
        passwordRef.current?.focus();
        return;
      }
      setValidation({
        field: "password",
        message: ts("authModal.errEmptyPassword"),
      });
      passwordRef.current?.focus();
      return;
    }
    setValidation(undefined);
    onPassword(trimmedEmail, password);
  };

  if (waitingOnBrowser) {
    return (
      <PkceWaitingState
        method={pending}
        link={link}
        onCancel={onCancel}
      />
    );
  }

  return (
    <div className="ls-signin-form">
      <div className="ls-signin-providers">
        <button
          type="button"
          className="ls-signin-provider-btn"
          disabled={blocked}
          onClick={() => onProvider("github")}
        >
          <GitHubBrandSvg />
          <span>{ts("authModal.continueGithub")}</span>
        </button>
        <button
          type="button"
          className="ls-signin-provider-btn"
          disabled={blocked}
          onClick={() => onProvider("google")}
        >
          <GoogleBrandSvg />
          <span>{ts("authModal.continueGoogle")}</span>
        </button>
      </div>

      <div
        className="ls-signin-divider"
        role="separator"
        aria-label={ts("authModal.orEmail")}
      >
        <span>{ts("authModal.orEmail")}</span>
      </div>

      <form
        className="ls-signin-form"
        noValidate
        aria-busy={pending === "password"}
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <Field
          label={ts("authModal.emailLabel")}
          htmlFor={`${baseId}-email`}
          error={validation?.field === "email" ? validation.message : undefined}
        >
          <Input
            ref={emailRef}
            id={`${baseId}-email`}
            type="email"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
            enterKeyHint="next"
            placeholder={ts("authModal.emailPlaceholder")}
            value={email}
            disabled={blocked}
            aria-invalid={validation?.field === "email" || undefined}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isImeComposing(event)) {
                event.preventDefault();
              }
            }}
            onChange={(event) => {
              setEmail(event.target.value);
              handleEdited();
            }}
          />
        </Field>

        <Field
          label={
            <span className="ls-signin-label-row">
              <span>{ts("authModal.passwordLabel")}</span>
              <ExternalTextLink href={FORGOT_PASSWORD_URLS[locale]}>
                {ts("authModal.forgotPassword")}
              </ExternalTextLink>
            </span>
          }
          htmlFor={`${baseId}-password`}
          error={
            validation?.field === "password"
              ? validation.message
              : !validation && shownError
                ? shownError
                : undefined
          }
        >
          <Input
            ref={passwordRef}
            id={`${baseId}-password`}
            type={showPassword ? "text" : "password"}
            name="password"
            autoComplete="current-password"
            enterKeyHint="done"
            placeholder={ts("authModal.passwordPlaceholder")}
            value={password}
            disabled={blocked}
            aria-invalid={validation?.field === "password" || undefined}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isImeComposing(event)) {
                event.preventDefault();
              }
            }}
            onChange={(event) => {
              setPassword(event.target.value);
              handleEdited();
            }}
            trailingSlot={
              <IconButton
                icon={showPassword ? "eye-off" : "eye"}
                size="icon-sm"
                variant="ghost"
                label={
                  showPassword
                    ? ts("authModal.hidePassword")
                    : ts("authModal.showPassword")
                }
                aria-pressed={showPassword}
                disabled={blocked}
                onClick={() => setShowPassword((prev) => !prev)}
              />
            }
          />
        </Field>

        <Button
          type="submit"
          variant="primary"
          className="ls-system-full-btn"
          loading={pending === "password"}
          disabled={blocked}
        >
          {pending === "password"
            ? ts("authModal.signingInSubmit")
            : ts("authModal.signInSubmit")}
        </Button>
      </form>

      <div className="ls-signin-footer-links">
        <span>{ts("authModal.noAccount")}</span>
        <ExternalTextLink href={SIGN_UP_URLS[locale]}>
          {ts("authModal.signUp")}
        </ExternalTextLink>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="ls-signin-link"
          disabled={blocked}
          onClick={onBrowser}
        >
          {ts("authModal.browserAuth")}
        </button>
      </div>

      {showZeroLoginNote ? (
        <p className="ls-signin-local-note">{ts("authModal.localZeroLoginNote")}</p>
      ) : null}
    </div>
  );
}

function PkceWaitingState({
  method,
  link,
  onCancel,
}: {
  method: Exclude<SignInMethod, "password">;
  link?: string;
  onCancel: () => void;
}) {
  const { ts } = useSystemI18n();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setStale(true), STILL_WAITING_MS);
    return () => clearTimeout(timer);
  }, []);

  const providerLabel =
    method === "github" ? "GitHub" : method === "google" ? "Google" : undefined;

  return (
    <div className="ls-signin-waiting" role="status" aria-live="polite">
      <DesktopIcon name="spinner" size="lg" />
      <h3>
        {providerLabel
          ? ts("authModal.waitingProvider", { provider: providerLabel })
          : ts("authModal.waitingBrowser")}
      </h3>
      <p>{ts("authModal.waitingSub")}</p>
      {stale ? (
        <p className="ls-system-note" data-tone="warning">
          {ts("authModal.waitingStale")}
        </p>
      ) : null}
      <div className="ls-signin-waiting__actions">
        {providerLabel && link ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              leadingIcon="external-link"
              onClick={() => openExternalUrl(link)}
            >
              {ts("authModal.reopenBrowser")}
            </Button>
            <CopyButton
              value={link}
              label={ts("authModal.copyAuthLink")}
              copiedLabel={ts("authModal.copiedAuthLink")}
              showText
            />
          </>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {ts("modal.cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Referral invite card for signed-in accounts (`SystemOverviewPage` & `SignInPairModal`).
 */
export function ReferralSummaryCard({
  userId,
  disabled = false,
}: {
  userId?: string;
  disabled?: boolean;
}) {
  const { locale, tCore } = useSystemI18n();
  const [summary, setSummary] = useState<ReferralSummary>();

  useEffect(() => {
    if (!userId) {
      setSummary(undefined);
      return undefined;
    }
    let alive = true;
    void fetchDesktopReferralSummary(userId, locale)
      .then((next) => {
        if (alive) setSummary(next);
      })
      .catch(() => {
        if (alive) setSummary(undefined);
      });
    return () => {
      alive = false;
    };
  }, [userId, locale]);

  if (!summary) return null;

  return (
    <div className="ls-referral-card">
      <div className="ls-referral-card__top">
        <span className="ls-referral-card__title">
          <DesktopIcon name="sparkles" size="sm" />
          {tCore("desktop.membership.referralTitle")}
        </span>
        <Badge tone="neutral">{summary.code}</Badge>
      </div>
      <p className="ls-referral-card__desc">
        {tCore("desktop.membership.referralDesc")}
      </p>
      <div className="ls-referral-card__bottom">
        <span className="ls-referral-card__stats">
          {tCore("desktop.membership.referralStats", {
            invited: summary.invited,
            rewarded: summary.rewarded,
            days: summary.earnedDays,
          })}
        </span>
        <CopyButton
          value={summary.shareUrl}
          label={tCore("desktop.membership.copyInviteLink")}
          copiedLabel={tCore("common.copied")}
          disabled={disabled}
          showText
        />
      </div>
    </div>
  );
}
