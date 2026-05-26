import type { ConnectionStatus } from "./useSession";

export const RECONNECT_BASE_DELAY = 1_000;
export const RECONNECT_MAX_DELAY = 15_000;

export type SessionErrorImpact = "none" | "session_exited" | "subscription_expired";

export function reconnectDelayForAttempt(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  return Math.min(RECONNECT_BASE_DELAY * 2 ** safeAttempt, RECONNECT_MAX_DELAY);
}

export function shouldReconnectAfterClose(input: {
  code?: number;
  manualDisconnect: boolean;
  status: ConnectionStatus;
}): boolean {
  if (input.manualDisconnect) return false;
  if (input.status === "session_exited") return false;
  return true;
}

export function connectionDetailForClose(code?: number): string {
  if (code === 4001) {
    return "认证或设备令牌暂时不可用，正在保持会话并重试。";
  }
  if (code === 4003) {
    return "订阅状态需要确认，正在保持会话并重试。";
  }
  return "Gateway connection lost. Reconnecting...";
}

export function sessionErrorConnectionImpact(code: string): SessionErrorImpact {
  if (code === "session_terminated") return "session_exited";
  if (code === "subscription_expired") return "subscription_expired";
  return "none";
}
