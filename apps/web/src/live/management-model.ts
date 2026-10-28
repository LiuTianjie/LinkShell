/**
 * This Mac's local management: the shapes `linkshell desktop` prints (see desktopSnapshot in
 * packages/cli/src/commands/desktop.ts) and the rules the page applies to them. No I/O here,
 * so the rules can be tested without a window.
 */

export const MANAGE_PAGES = ["overview", "devices", "password", "usage", "log", "updates", "settings"] as const;
export type ManagePage = (typeof MANAGE_PAGES)[number];
export const managePageTitles: Record<ManagePage, string> = {
  overview: "总览", devices: "设备", password: "访问密码", usage: "用量统计", log: "日志", updates: "更新", settings: "设置",
};

export interface DesktopDevice { id: string; name: string; online: boolean; pairedAt?: number }
export interface DesktopAccount {
  state: string;
  email?: string;
  userId?: string;
  plan?: string;
  planExpiresAt?: string;
}
export interface DesktopSnapshot {
  schema?: number;
  status: string;
  cliVersion?: string;
  source?: string;
  hostOwner?: string;
  appBundle?: string;
  home?: string;
  access?: { password: boolean };
  account?: DesktopAccount;
  redemption?: { userId: string; idempotent: boolean };
  accountWarning?: string;
  machine?: { hostname: string; hostVersion: string };
  gateway?: { status: string; url?: string; devices: DesktopDevice[]; error?: { message: string } };
  sessions?: { id: string; state: string; pendingPermissions?: number }[];
  error?: string;
}
export interface DesktopAbout {
  version: string;
  electron?: string;
  standalone: boolean;
  bundle?: string;
  home: string;
}
export interface DesktopSettings { opaqueWindow: boolean; autoCheck: boolean; updateChannel: "stable" | "beta" }
export interface PairingOffer { code: string; link: string; gateway: string; expiresAt: number; qr?: boolean[][] }

export type Membership =
  | { kind: "signed-out" }
  | { kind: "unknown" }
  | { kind: "free" }
  | { kind: "pro"; expiresAt: Date };

export function isManageView(view: string): boolean {
  return view === "manage" || view.startsWith("manage:");
}

/** Accepts a page id or its Chinese title: the menu bar and tray name pages by title. */
export function parseManagePage(value: unknown): ManagePage | undefined {
  if (typeof value !== "string") return undefined;
  if ((MANAGE_PAGES as readonly string[]).includes(value)) return value as ManagePage;
  return MANAGE_PAGES.find((page) => managePageTitles[page] === value);
}

export function managePage(view: string): ManagePage {
  return parseManagePage(view.slice("manage:".length)) ?? "overview";
}

export function manageView(page: ManagePage = "overview"): string {
  return page === "overview" ? "manage" : `manage:${page}`;
}

export function membershipOf(account: DesktopAccount | undefined, now = Date.now()): Membership {
  if (account?.state !== "signed-in") return { kind: "signed-out" };
  if (account.plan === "free") return { kind: "free" };
  if (account.plan !== "pro" || !account.planExpiresAt) return { kind: "unknown" };
  const expiresAt = new Date(account.planExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return { kind: "unknown" };
  return expiresAt.getTime() > now ? { kind: "pro", expiresAt } : { kind: "free" };
}

/** The CLI checks the same bounds; checking here keeps the password off the wire when it can't pass. */
export function passwordProblem(password: string): string | undefined {
  return password.length < 4 || password.length > 128 ? "密码需要 4 到 128 位。" : undefined;
}

export function redemptionProblem(code: string): string | undefined {
  const trimmed = code.trim();
  if (!trimmed) return "请输入激活码。";
  return new TextEncoder().encode(trimmed).length > 512 ? "激活码格式不正确，请检查后重试。" : undefined;
}

export function serviceLabel(snapshot: DesktopSnapshot | undefined, problem: string | undefined): string {
  if (problem) return "状态未知";
  return ({ running: "运行中", stopped: "已停止", unreachable: "无法连接" } as Record<string, string>)[snapshot?.status ?? ""] ?? "正在连接";
}

export function gatewayLabel(snapshot: DesktopSnapshot | undefined, healthy: boolean): string {
  if (!healthy) return "未知";
  return ({ online: "已连接", connecting: "连接中", offline: "已断开", off: "未启用" } as Record<string, string>)[snapshot?.gateway?.status ?? ""] ?? "未知";
}

export function sourceLabel(snapshot: DesktopSnapshot | undefined, standalone: boolean): string {
  if (standalone) return "独立 App · 内置运行环境";
  return snapshot?.source === "homebrew" ? "Homebrew" : snapshot?.source === "npm" ? "npm / CLI" : "未知";
}

/** Dotted numeric versions; a missing part counts as 0. */
export function newerVersion(latest: string, current: string): boolean {
  const parts = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

export function wholeNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

export function compactNumber(value: number): string {
  for (const [scale, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (value >= scale) return `${(value / scale).toFixed(1)}${suffix}`;
  }
  return wholeNumber(value);
}

/** One entry of the Host's log: a stamped line and the unstamped lines under it (a stack trace). */
export interface LogEntry { at?: number; tag?: string; text: string }

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (?:\[([^\]\s]{1,24})\] )?(.*)$/;

/**
 * The log as `host.log` writes it (`<ISO time> [<source>] <text>`). The window reads the file's
 * last 64 KB, so a first line without its stamp is the tail of a cut-off entry and is dropped.
 */
export function parseHostLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length > 1 && !LOG_LINE.test(lines[0]!) && lines.some((line) => LOG_LINE.test(line))) lines.shift();
  for (const line of lines) {
    const match = LOG_LINE.exec(line);
    const at = match ? Date.parse(match[1]!) : Number.NaN;
    if (match && !Number.isNaN(at)) entries.push({ at, tag: match[2], text: match[3]! });
    else if (entries.length) entries[entries.length - 1]!.text += `\n${line}`;
    else entries.push({ text: line });
  }
  return entries;
}

/**
 * A path cut for an ellipsis in its middle: the head may shrink, the last component stays whole
 * (up to 24 characters), since that is the part that tells one path from another.
 */
export function splitPath(path: string): [head: string, tail: string] {
  const slash = path.lastIndexOf("/");
  const cut = slash > 0 && path.length - slash <= 24 ? slash : Math.max(0, path.length - 16);
  return [path.slice(0, cut), path.slice(cut)];
}
