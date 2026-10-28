// What the iTool account service (Supabase auth, or itool.tech's proxy in front of it) answers
// when a sign-in fails, in the words the app and the desktop show. One table, so the phone and
// the computer never describe the same refusal differently. No I/O and no imports: the CLI
// compiles this file directly.

export type AccountErrorCode =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "missing_credentials"
  | "oauth_expired"
  | "oauth_denied"
  | "identity_conflict"
  | "provider_disabled"
  | "rate_limited"
  | "user_banned"
  | "unavailable"
  | "network"
  | "timeout"
  | "browser_timeout"
  | "cancelled"
  | "unverified"
  | "unknown";

export const ACCOUNT_ERROR_MESSAGES: Record<AccountErrorCode, string> = {
  // Supabase answers the same for a wrong password and for an account that has none (signed up
  // with GitHub or Google), so the message has to cover both.
  invalid_credentials: "邮箱或密码不正确。用 GitHub 或 Google 注册的账号没有密码，请用对应的按钮登录。",
  email_not_confirmed: "邮箱还没有验证，请先查收 iTool 发送的验证邮件。",
  missing_credentials: "请输入邮箱和密码。",
  oauth_expired: "这次登录已失效，请重新登录。",
  oauth_denied: "已在浏览器中取消授权。",
  identity_conflict: "这个邮箱已经用另一种方式注册过，请用原来的方式登录。",
  provider_disabled: "这种登录方式暂时不可用，请改用其他方式。",
  rate_limited: "尝试次数过多，请稍后再试。",
  user_banned: "这个账号已被停用。",
  unavailable: "登录服务暂时不可用，请稍后重试。",
  network: "无法连接登录服务，请检查网络后重试。",
  timeout: "登录请求超时，请检查网络后重试。",
  browser_timeout: "5 分钟内没有收到浏览器的登录结果，请重试。",
  cancelled: "已取消登录。",
  unverified: "无法验证账号，请重新登录。",
  unknown: "登录失败，请稍后重试。",
};

export function accountErrorMessage(code: AccountErrorCode): string {
  return ACCOUNT_ERROR_MESSAGES[code];
}

/** A refusal that a retry elsewhere (the other route to Supabase) would only repeat. */
export function isDefinitiveAccountError(code: AccountErrorCode): boolean {
  return !["unavailable", "network", "timeout", "unknown"].includes(code);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A failed `/auth/v1/token` (or itool.tech's `/api/linkshell/auth`). GoTrue has answered in two
 * shapes over the years: `error_code` + `msg`, and the older OAuth-style `error` +
 * `error_description`, where `invalid_grant` covered every password failure.
 */
export function tokenErrorCode(status: number, body: unknown, grant: "password" | "pkce" | "refresh_token" = "password"): AccountErrorCode {
  const json = record(body);
  const code = text(json.error_code) || text(json.code) || text(json.error);
  const detail = `${text(json.msg)} ${text(json.message)} ${text(json.error_description)}`;
  if (code === "email_not_confirmed" || /email not confirmed/i.test(detail)) return "email_not_confirmed";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(detail)) return "invalid_credentials";
  if (["flow_state_not_found", "flow_state_expired", "bad_code_verifier", "bad_oauth_state"].includes(code)) return "oauth_expired";
  if (code === "invalid_grant") return grant === "password" ? "invalid_credentials" : "oauth_expired";
  if (code === "user_banned") return "user_banned";
  if (code === "over_request_rate_limit" || code === "rate_limited" || status === 429) return "rate_limited";
  if (code === "provider_disabled" || /provider is not enabled|unsupported provider/i.test(detail)) return "provider_disabled";
  if (code === "temporarily_unavailable" || status >= 500) return "unavailable";
  return "unknown";
}

/** The `error` / `error_code` / `error_description` an OAuth redirect carries back. */
export function oauthErrorCode(params: { error?: string | null; errorCode?: string | null; description?: string | null }): AccountErrorCode {
  const error = params.error ?? "";
  const code = params.errorCode ?? "";
  const detail = `${params.description ?? ""} ${error}`;
  if (/same email|already registered|linking domain|identity_already_exists|email_exists/i.test(`${detail} ${code}`)) return "identity_conflict";
  if (/provider is not enabled|unsupported provider/i.test(detail) || code === "provider_disabled") return "provider_disabled";
  if (error === "access_denied" || code === "access_denied") return "oauth_denied";
  if (/flow state|expired/i.test(detail) || ["flow_state_not_found", "flow_state_expired", "bad_oauth_state", "bad_oauth_callback"].includes(code)) return "oauth_expired";
  if (error === "temporarily_unavailable" || error === "server_error") return "unavailable";
  return "unknown";
}
