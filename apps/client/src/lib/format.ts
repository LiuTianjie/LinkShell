const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (n: number) => String(n).padStart(2, "0");

/** "刚刚", "5 分钟前", "14:20", "昨天", "周三", "9月3日", "2025年9月3日". */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  const date = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (ts >= startOfToday - DAY) return "昨天";
  if (ts >= startOfToday - 6 * DAY) return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()]!;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** "14:20" or "昨天 14:20" — for timeline separators. */
export function clockTime(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = relativeTime(ts, now);
  return day.includes(":") || day === "刚刚" || day.endsWith("分钟前") ? time : `${day} ${time}`;
}

export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
  }
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Last path segment, for project names. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Replaces the home directory prefix with "~". */
let hostHome: string | undefined;

/** The connected computer's home directory (from its machine info). */
export function setHostHome(home: string | undefined): void {
  hostHome = home && home !== "/" ? home.replace(/\/$/, "") : undefined;
}

/** A path on the computer, with its home directory as `~`. */
export function shortPath(path: string): string {
  if (hostHome && (path === hostHome || path.startsWith(`${hostHome}/`))) return `~${path.slice(hostHome.length)}`;
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
