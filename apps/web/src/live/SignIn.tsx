import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { openDesktopExternal } from "./desktop";
import "../styles/desktop-signin.css";

export type SignInProvider = "github" | "google";
export type SignInMethod = "web" | "password" | SignInProvider;

// Sign-up and password resets stay on itool.tech: their confirmation emails link back there.
export const SIGN_UP_URL = "https://itool.tech/zh/register";
export const FORGOT_PASSWORD_URL = "https://itool.tech/zh/forgot-password";
/** After this long without an answer from the browser, say what may have gone wrong. */
const STILL_WAITING_MS = 45_000;

const providerNames: Record<SignInProvider, string> = { github: "GitHub", google: "Google" };

export interface SignInProps {
  /** The sign-in under way, if any. */
  pending?: SignInMethod;
  /** The provider's authorize link once the computer is listening for it (GitHub / Google). */
  link?: string;
  error?: string;
  disabled?: boolean;
  title?: string;
  description?: string;
  onPassword(email: string, password: string): void;
  onProvider(provider: SignInProvider): void;
  /** iTool's authorization page, for someone already signed in to iTool in the browser. */
  onBrowser(): void;
  onCancel(): void;
  /** The person changed the form: an error about the last attempt no longer applies. */
  onEdit?(): void;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

/** In the desktop the system browser opens links; a plain `target=_blank` may go nowhere. */
function ExternalLink({ href, children }: { href: string; children: string }) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openDesktopExternal(href);
  };
  return <a href={href} target="_blank" rel="noreferrer" onClick={open}>{children}</a>;
}

/** The Enter that confirms an input method's candidate (Chinese, Japanese…), not a submit. */
export function isCompositionEnter(event: { key: string; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === "Enter" && (event.isComposing === true || event.keyCode === 229);
}

function guardComposition(event: KeyboardEvent<HTMLInputElement>) {
  if (isCompositionEnter({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) event.preventDefault();
}

/** What is missing before asking the account service at all; the service judges the rest. */
export function signInProblem(email: string, password: string): { field: "email" | "password"; message: string } | undefined {
  const address = email.trim();
  if (!address) return { field: "email", message: "请输入邮箱。" };
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) return { field: "email", message: "邮箱格式不正确。" };
  if (!password) return { field: "password", message: "请输入密码。" };
  return undefined;
}

/**
 * The iTool account sign-in, as Codex's desktop app has it: providers first, then email and
 * password, then the ways that stay on the web. The panel only collects and shows; the caller
 * signs in (through the Electron window or the workspace service), so no token passes through it.
 */
export function SignIn(props: SignInProps) {
  const { pending, link, error, disabled, title, description, onPassword, onProvider, onBrowser, onCancel, onEdit } = props;
  const id = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invalid, setInvalid] = useState<{ field: "email" | "password"; message: string }>();
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const waiting = pending !== undefined && pending !== "password";
  const blocked = disabled || pending !== undefined;
  const shownError = invalid?.message ?? error;

  const submit = () => {
    if (blocked) return;
    const problem = signInProblem(email, password);
    // Enter in the address field with no password yet is moving on, not a mistake.
    if (problem?.field === "password" && !password && document.activeElement === emailInput.current) {
      setInvalid(undefined);
      passwordInput.current?.focus();
      return;
    }
    setInvalid(problem);
    if (problem) {
      (problem.field === "email" ? emailInput : passwordInput).current?.focus();
      return;
    }
    onPassword(email.trim(), password);
  };
  const edited = () => {
    setInvalid(undefined);
    onEdit?.();
  };

  if (waiting) return <Waiting method={pending} link={link} title={title} onCancel={onCancel} />;

  return (
    <div className="signin">
      {(title || description) && (
        <header className="signin-header">
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="signin-providers">
        {(["github", "google"] as const).map((provider) => (
          <button key={provider} type="button" className="signin-button" data-kind="provider" disabled={blocked} onClick={() => onProvider(provider)}>
            {provider === "github" ? <GitHubMark /> : <GoogleMark />}
            使用 {providerNames[provider]} 继续
          </button>
        ))}
      </div>
      <div className="signin-divider" role="separator" aria-label="或使用邮箱"><span>或</span></div>
      <form
        className="signin-form"
        noValidate
        aria-busy={pending === "password"}
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        <div className="signin-field">
          <label className="signin-field-label" htmlFor={`${id}-email`}>邮箱</label>
          <input
            ref={emailInput}
            // The panel opens to type into: the address takes the focus, providers are a Tab back.
            autoFocus
            id={`${id}-email`}
            className="signin-input"
            type="email"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
            placeholder="你的 iTool 账号邮箱"
            value={email}
            disabled={blocked}
            aria-invalid={invalid?.field === "email"}
            aria-describedby={shownError ? `${id}-error` : undefined}
            onKeyDown={guardComposition}
            onChange={(event) => { setEmail(event.target.value); edited(); }}
          />
        </div>
        <div className="signin-field">
          <div className="signin-field-label">
            <label htmlFor={`${id}-password`}>密码</label>
            <ExternalLink href={FORGOT_PASSWORD_URL}>忘记密码？</ExternalLink>
          </div>
          <input
            ref={passwordInput}
            id={`${id}-password`}
            className="signin-input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            disabled={blocked}
            aria-invalid={invalid?.field === "password"}
            aria-describedby={shownError ? `${id}-error` : undefined}
            onKeyDown={guardComposition}
            onChange={(event) => { setPassword(event.target.value); edited(); }}
          />
        </div>
        {/* Under the fields it is about, before the button that would try again. */}
        {shownError && <p id={`${id}-error`} className="signin-error" role="alert">{shownError}</p>}
        <button type="submit" className="signin-button" data-kind="primary" disabled={blocked}>
          {pending === "password" && <LoaderCircle className="signin-spinner" aria-hidden />}
          {pending === "password" ? "正在登录…" : "登录"}
        </button>
      </form>
      <footer className="signin-footer">
        <p>没有账号？<ExternalLink href={SIGN_UP_URL}>注册 iTool 账号</ExternalLink></p>
        <p>
          已在浏览器登录 iTool？
          <button type="button" className="signin-link" disabled={blocked} onClick={onBrowser}>在浏览器中授权</button>
        </p>
      </footer>
    </div>
  );
}

function Waiting({ method, link, title, onCancel }: { method: Exclude<SignInMethod, "password">; link?: string; title?: string; onCancel(): void }) {
  const [stale, setStale] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    const timer = setTimeout(() => setStale(true), STILL_WAITING_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (copy !== "copied") return;
    const timer = setTimeout(() => setCopy("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [copy]);
  const provider = method === "web" ? undefined : providerNames[method];
  const copyLink = () => {
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => setCopy("copied"), () => setCopy("failed"));
  };
  return (
    <div className="signin" data-state="waiting">
      {title && <header className="signin-header"><h2>{title}</h2></header>}
      <div className="signin-waiting" role="status" aria-live="polite">
        <LoaderCircle className="signin-spinner" data-size="large" aria-hidden />
        <h3>{provider ? `请在浏览器中完成 ${provider} 登录` : "请在浏览器中完成授权"}</h3>
        <p>{provider ? "完成后会自动回到 LinkShell。" : "在 iTool 页面确认后，会自动回到 LinkShell。"}</p>
        {stale && (
          <p className="signin-hint">
            还没有收到浏览器的结果。如果浏览器停在了错误页，请取消后重试，或改用邮箱和密码登录。等待 5 分钟后会自动取消。
          </p>
        )}
      </div>
      {provider && (
        <div className="signin-actions">
          <button type="button" className="signin-button" data-kind="provider" disabled={!link} onClick={() => link && openDesktopExternal(link)}>
            重新打开浏览器
          </button>
          <button type="button" className="signin-button" data-kind="provider" disabled={!link} onClick={copyLink}>
            {copy === "copied" ? "已复制" : "复制链接"}
          </button>
        </div>
      )}
      {copy === "failed" && link && (
        <p className="signin-hint">无法写入剪贴板，请手动复制：<span className="signin-link-text">{link}</span></p>
      )}
      <button type="button" className="signin-button" data-kind="quiet" onClick={onCancel}>取消</button>
    </div>
  );
}
