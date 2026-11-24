/** Cooldown between automatic foreground/launch update checks so switching windows doesn't spam requests. */
export const AUTO_UPDATE_CHECK_COOLDOWN_MS = 15 * 60_000;
/** Periodic fallback interval when the app stays open continuously without foreground transitions. */
export const PERIODIC_UPDATE_CHECK_INTERVAL_MS = 6 * 3600_000;

export interface AutoUpdateCheckInput {
  enabled: boolean;
  standalone: boolean;
  busy: boolean;
  lastCheckAt: number;
  now: number;
  cooldownMs?: number;
}

export function shouldAutoCheckUpdates(input: AutoUpdateCheckInput): boolean {
  if (!input.enabled || !input.standalone || input.busy) return false;
  const cooldown = input.cooldownMs ?? AUTO_UPDATE_CHECK_COOLDOWN_MS;
  return input.lastCheckAt === 0 || input.now - input.lastCheckAt >= cooldown;
}
