export interface ProMembership {
  plan: "free" | "pro";
  expiresAt?: string;
}

export interface ProMembershipOptions {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  userId: string;
  signal?: AbortSignal;
}

export const PRO_CODE_SHOP_URL = "https://pay.ldxp.cn/item/7lgv1s";

const REDEEM_URL = "https://itool.tech/api/pro/redeem";
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_REQUIRED = "登录已失效，请重新登录后再试";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

async function request(url: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const response = await fetch(url, { ...init, credentials: "omit", signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (controller.signal.aborted || !(error instanceof SyntaxError)) throw error;
    }
    return { response, body };
  } catch {
    throw new Error(controller.signal.aborted ? "请求超时，请稍后重试" : "网络连接失败，请检查网络后重试");
  } finally {
    clearTimeout(timer);
  }
}

/** The profile is read with the user's token; only the server can grant Pro. */
export async function fetchProMembership(options: ProMembershipOptions): Promise<ProMembership> {
  if (!options.accessToken.trim() || !options.userId.trim()) throw new Error(LOGIN_REQUIRED);
  const url = `${options.supabaseUrl.replace(/\/$/, "")}/rest/v1/profiles?select=plan,plan_expires_at&id=eq.${encodeURIComponent(options.userId)}&limit=1`;
  const { response, body } = await request(url, {
    headers: { apikey: options.anonKey, Authorization: `Bearer ${options.accessToken}` },
    signal: options.signal,
  });
  if (response.status === 401 || response.status === 403) throw new Error(LOGIN_REQUIRED);
  if (!response.ok) throw new Error("暂时无法获取会员状态，请稍后重试");
  if (!Array.isArray(body)) throw new Error("会员状态返回异常，请稍后重试");
  if (body.length === 0) return { plan: "free" };
  const profile = record(body[0]);
  if (!profile || typeof profile.plan !== "string") throw new Error("会员状态返回异常，请稍后重试");
  const expiresAt = profile.plan_expires_at;
  const expires = timestamp(expiresAt);
  const serverTime = timestamp(response.headers.get("date"));
  const now = Number.isFinite(serverTime) ? serverTime : Date.now();
  return profile.plan === "pro" && Number.isFinite(expires) && expires > now
    ? { plan: "pro", expiresAt: expiresAt as string }
    : { plan: "free" };
}

const redeemErrors: Record<string, string> = {
  malformed_request: "激活码格式不正确，请检查后重试",
  login_required: LOGIN_REQUIRED,
  request_too_large: "激活码内容过长，请检查后重试",
  invalid_or_unavailable: "激活码无效或已不可用，请检查后重试",
  rate_limited: "操作太频繁，请稍后重试",
  temporarily_unavailable: "兑换服务暂时不可用，请稍后重试",
};

const redeemStatusCodes: Record<number, string> = {
  400: "malformed_request",
  401: "login_required",
  413: "request_too_large",
  422: "invalid_or_unavailable",
  429: "rate_limited",
  503: "temporarily_unavailable",
};

export async function redeemProCode(accessToken: string, code: string): Promise<{ expiresAt: string; idempotent: boolean }> {
  if (!accessToken.trim()) throw new Error(LOGIN_REQUIRED);
  const normalizedCode = code.trim();
  if (!normalizedCode) throw new Error("请输入激活码");
  const { response, body: responseBody } = await request(REDEEM_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalizedCode }),
  });
  const body = record(responseBody);
  if (!response.ok) {
    const code = body?.code ?? record(body?.error)?.code;
    const knownCode = typeof code === "string" && Object.hasOwn(redeemErrors, code) ? code : redeemStatusCodes[response.status];
    throw new Error(knownCode ? redeemErrors[knownCode] : "兑换失败，请稍后重试");
  }
  const expires = timestamp(body?.plan_expires_at);
  const serverTime = timestamp(body?.server_time);
  if (
    body?.ok !== true || body.valid !== true || typeof body.idempotent !== "boolean" ||
    typeof body.months !== "number" || !Number.isFinite(body.months) || body.months < 0 ||
    !Number.isFinite(expires) || !Number.isFinite(serverTime)
  ) {
    throw new Error("兑换结果尚未确认，请刷新会员状态后重试");
  }
  if (expires <= serverTime) {
    throw new Error(body.idempotent
      ? "此激活码已兑换且权益已到期，请使用新的激活码"
      : "兑换结果尚未确认，请刷新会员状态后重试");
  }
  return { expiresAt: body.plan_expires_at as string, idempotent: body.idempotent };
}
