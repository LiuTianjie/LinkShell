/** The signed page owns the native bridge. Screen and port frames never inherit that authority. */
export class WorkspacePolicy {
  readonly origin: URL;
  constructor(origin: URL) { this.origin = origin; }

  static readyURL(line: string): URL {
    let url: URL;
    try {
      const parsed = JSON.parse(line) as { url?: unknown };
      if (typeof parsed.url !== "string") throw new Error();
      url = new URL(parsed.url);
    } catch { throw new Error("工作台返回了无效的本地地址，请更新配套 CLI 后重试。"); }
    const port = Number(url.port);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !(port >= 1 && port <= 65535) ||
        url.username || url.password || url.pathname !== "/" || url.search ||
        !/^#desktop=[A-Za-z0-9_-]{32,256}$/.test(url.hash)) {
      throw new Error("工作台返回了无效的本地地址，请更新配套 CLI 后重试。");
    }
    return url;
  }

  isTrusted(value: string | undefined): boolean {
    const url = parse(value);
    return !!url && url.protocol === this.origin.protocol && url.hostname === this.origin.hostname &&
      url.port === this.origin.port && !url.username && !url.password;
  }

  isPreview(value: string | undefined): boolean {
    const url = parse(value);
    return !!url && url.protocol === "http:" && url.hostname === "localhost" && url.port === this.origin.port &&
      !url.username && !url.password;
  }

  allowsBridge(value: string | undefined, mainFrame: boolean): boolean { return mainFrame && this.isTrusted(value); }

  allowsSubframe(value: string): boolean {
    if (this.isTrusted(value) || this.isPreview(value) || WorkspacePolicy.externalURL(value)) return true;
    if (value === "about:blank" || value === "about:srcdoc") return true;
    return this.allowsBlob(value, true);
  }

  allowsBlob(value: string, opaque = false): boolean {
    if (!value.startsWith("blob:")) return false;
    const content = value.slice(5);
    if (opaque && content.startsWith("null/")) return true;
    return this.isTrusted(content) || this.isPreview(content);
  }

  static externalURL(value: string): boolean {
    const url = parse(value);
    if (!url || !["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    // Native links must not turn an untrusted document into a local-file or loopback launcher.
    return !isBlockedExternalHost(host);
  }

  static validAppearance(value: unknown): value is "light" | "dark" | "system" {
    return value === "light" || value === "dark" || value === "system";
  }
}

function isBlockedIpv4(host: string): boolean {
  return host === "0.0.0.0" || host.startsWith("127.") || host.startsWith("169.254.");
}

function parseIpv6Groups(raw: string): number[] | undefined {
  const withoutZone = raw.split("%")[0] ?? "";
  let text = withoutZone;
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    const ipv4 = text.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
    const hi = ((ipv4[0]! << 8) | ipv4[1]!).toString(16);
    const lo = ((ipv4[2]! << 8) | ipv4[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parsePart = (part: string): number[] | undefined => {
    if (!part) return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parsePart(halves[0]!);
  const right = halves.length === 2 ? parsePart(halves[1]!) : [];
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedExternalHost(host: string): boolean {
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (isBlockedIpv4(host)) return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare.includes(":")) return false;
  const groups = parseIpv6Groups(bare);
  if (!groups) return true;
  const allZero = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const isLinkLocal = (groups[0]! & 0xffc0) === 0xfe80;
  if (allZero || isLoopback || isLinkLocal) return true;
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0);
  if (isIpv4Mapped) {
    const a = (groups[6]! >> 8) & 0xff;
    const b = groups[6]! & 0xff;
    const c = (groups[7]! >> 8) & 0xff;
    const d = groups[7]! & 0xff;
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

function parse(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try { return new URL(value); } catch { return undefined; }
}
