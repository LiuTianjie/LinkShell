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
    const host = url.hostname.toLowerCase();
    // Native links must not turn an untrusted document into a local-file or loopback launcher.
    return !(host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1" ||
      host === "0.0.0.0" || host.startsWith("127.") || host.startsWith("169.254."));
  }

  static validAppearance(value: unknown): value is "light" | "dark" | "system" {
    return value === "light" || value === "dark" || value === "system";
  }
}

function parse(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try { return new URL(value); } catch { return undefined; }
}
