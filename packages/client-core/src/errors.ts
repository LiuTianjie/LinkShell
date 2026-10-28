/**
 * Errors as the Claude desktop app shows them, for every agent: what kind of failure it was
 * (the server's, too many requests, the sign-in, the request itself), what to do about it, and
 * the agent's own words one disclosure away. Errors that aren't the model's API failing (a
 * message that couldn't be sent, history that couldn't be read) keep their own words.
 */

export type ErrorKind = "server" | "overloaded" | "rate_limit" | "auth" | "request";

export interface ErrorPresentation {
  kind?: ErrorKind;
  title: string;
  hint?: string;
  /** The error as the agent reported it, for the "查看详情" disclosure. */
  detail?: string;
}

const TITLES: Record<ErrorKind, string> = {
  server: "服务器错误",
  overloaded: "服务繁忙",
  rate_limit: "请求过于频繁",
  auth: "认证失败",
  request: "请求失败",
};

const HINTS: Partial<Record<ErrorKind, string>> = {
  server: "稍后重试，或换一个模型。",
  overloaded: "稍后重试，或换一个模型。",
  rate_limit: "稍后重试，或换一个模型。",
  auth: "在电脑上确认 Agent 已登录，然后重试。",
};

/** Codes an agent's failed request comes with (Claude's transcript, Codex's error info, LinkShell's own for agent errors). */
const CODE_KINDS: Record<string, ErrorKind> = {
  rate_limit: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  usage_limit_exceeded: "rate_limit",
  overloaded: "overloaded",
  server_overloaded: "overloaded",
  server_error: "server",
  internal_server_error: "server",
  authentication_failed: "auth",
  unauthorized: "auth",
  invalid_request: "request",
  bad_request: "request",
  model_not_found: "request",
  billing_error: "request",
  context_window_exceeded: "request",
  api_error: "request",
};

/** Codes whose message may be the model's API failing; others are LinkShell's own and say what they mean. */
const AGENT_CODES = new Set(["turn_failed", "agent_error", "agent_notice"]);

function kindFromText(raw: string): ErrorKind | undefined {
  if (/\b529\b|overloaded|at capacity|服务繁忙|server is busy/i.test(raw)) return "overloaded";
  if (/\b429\b|rate.?limit|too many requests|usage limit|session limit|用量已达上限|quota/i.test(raw)) return "rate_limit";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|authenticat|鉴权失败|not logged in|\/login\b|invalid (api key|bearer|x-api-key)|token has (expired|been revoked)/i.test(raw)) return "auth";
  if (/\b5\d\d\b|server error|internal error|bad gateway|service unavailable|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection (dropped|lost|refused|reset)|timed out|stream (disconnected|error)|stopped arriving/i.test(raw)) return "server";
  if (/API Error|\b4\d\d\b|invalid_request|bad request|payload too large/i.test(raw)) return "request";
  return undefined;
}

export function presentError(error: { code: string; message: string; hint?: string }): ErrorPresentation {
  const raw = [error.message, error.hint].filter(Boolean).join("\n");
  const coded = CODE_KINDS[error.code];
  const kind = coded ?? (AGENT_CODES.has(error.code) ? kindFromText(raw) : undefined);
  if (!kind) return { title: error.message, hint: error.hint };
  // A coded error with a more telling message ("Repeated 529 Overloaded" coded server_error) takes the message's kind.
  const refined = coded === "server" || coded === "request" ? kindFromText(raw) ?? kind : kind;
  return { kind: refined, title: TITLES[refined], hint: HINTS[refined], detail: raw };
}

export interface Reconnect {
  attempt: number;
  max: number;
  /** The server said it is busy (overloaded, too many requests). */
  busy: boolean;
}

/**
 * A retry an agent reports while it keeps the turn going: Codex's "Reconnecting... 2/5", Claude's
 * "Retrying Claude, attempt 2 of 10." / "Reconnecting to Claude, attempt 2 of 10.".
 */
export function reconnectOf(title: string, detail?: string): Reconnect | undefined {
  const codex = /^Reconnecting(?:\.\.\.|…)?\s+(\d+)\/(\d+)/i.exec(title);
  const claude = codex ? undefined : /^(?:Reconnecting to|Retrying)\b.*?\battempt (\d+) of (\d+)/i.exec(title);
  const found = codex ?? claude;
  if (!found) return undefined;
  const busy = /\b(429|503|529)\b|overloaded|at capacity|rate.?limit|too many requests|busy/i.test(`${title}\n${detail ?? ""}`);
  return { attempt: Number(found[1]), max: Number(found[2]), busy };
}

/** The reconnect row: still trying (the turn is on it), or past (the turn moved on). */
export function reconnectLabel(reconnect: Reconnect, live: boolean): string {
  if (!live) return `已重新连接（重试 ${reconnect.attempt} 次）`;
  const trying = `正在重新连接 ${reconnect.attempt}/${reconnect.max}`;
  return reconnect.busy ? `服务器繁忙，${trying}` : trying;
}
