export function sessionTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  const date = new Date(timestamp);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    ...(date.getFullYear() !== today.getFullYear()
      ? { year: "numeric" as const }
      : {}),
    month: "short",
    day: "numeric",
  });
}

/** Short enough for a sidebar row: 刚刚, 12 分, 15:21, 昨天, 10/3. */
export function compactTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分`;
  const date = new Date(timestamp);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** A message's own time, as Codex stamps it: the time today, with the weekday within a week, else with the date. */
export function messageTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (timestamp >= midnight.getTime()) return time;
  if (timestamp >= midnight.getTime() - 6 * 86_400_000) return `${date.toLocaleDateString("zh-CN", { weekday: "short" })} ${time}`;
  return `${date.getFullYear() !== midnight.getFullYear() ? `${date.getFullYear()}年` : ""}${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
