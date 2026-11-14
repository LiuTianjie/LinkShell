import type { Locale } from "@linkshell/client-core";

type Copy = Record<Locale, string>;

const TIMEOUT: Copy = {
  zh: "电脑没有及时响应，请稍后再试",
  en: "The computer didn't respond in time. Try again in a moment.",
  ja: "PC から応答がありませんでした。しばらくしてからもう一度お試しください。",
};
const CLOSED: Copy = {
  zh: "连接断开了，连上后再试",
  en: "The connection dropped. Try again once it is back.",
  ja: "接続が切れました。再接続後にもう一度お試しください。",
};
const OFFLINE: Copy = {
  zh: "没有连上电脑，连上后再试",
  en: "Not connected to the computer. Try again once it is back.",
  ja: "PC に接続されていません。再接続後にもう一度お試しください。",
};
const LOCKED: Copy = {
  zh: "请先输入这台电脑的访问密码",
  en: "Enter this computer's access password first.",
  ja: "先にこの PC のアクセスパスワードを入力してください。",
};
const UNKNOWN: Copy = { zh: "操作没有完成，请重试", en: "That didn't go through. Try again.", ja: "完了できませんでした。もう一度お試しください。" };

/** The `data.code` an RPC error carries (`timeout`, `closed`, `offline`, a host's own code). */
export function errorCode(error: unknown): string | undefined {
  const data = (error as { data?: { code?: unknown } } | null | undefined)?.data;
  return typeof data?.code === "string" ? data.code : undefined;
}

/**
 * A failed action in words the user can act on. The peer's own timeout and close messages name
 * the RPC method and its limit in milliseconds ("请求超时（fs.read，20000 ms）"): true, and
 * no use to someone holding a phone. A host's own message says what happened and is kept.
 */
export function actionErrorText(error: unknown, locale: Locale): string {
  const code = errorCode(error);
  if (code === "timeout") return TIMEOUT[locale];
  if (code === "closed") return CLOSED[locale];
  if (code === "offline") return OFFLINE[locale];
  if (code === "locked") return LOCKED[locale];
  const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "").trim();
  // The same two, from a peer that did not attach a code.
  if (/^请求超时（/.test(message)) return TIMEOUT[locale];
  if (/^(连接已断开|正在重新连接|连接已停止)\s*[（(]/.test(message)) return CLOSED[locale];
  return message || UNKNOWN[locale];
}
