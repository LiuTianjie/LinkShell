export interface PairingLinkPayload {
  code: string;
  gateway?: string;
}

function normalizeGateway(rawGateway: string | null): string | undefined {
  const value = rawGateway?.trim();
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    const hostname = url.hostname.trim().toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    ) {
      return undefined;
    }

    url.hash = "";
    url.search = "";
    url.pathname = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function parsePairingLink(raw: string): PairingLinkPayload | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  if (/^\d{6}$/.test(value)) {
    return { code: value };
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "linkshell:" || url.hostname !== "pair") {
      return null;
    }

    const code = (
      url.searchParams.get("code")?.trim() ||
      decodeURIComponent(url.pathname.replace(/^\/+/, "")).trim()
    );
    const gateway = normalizeGateway(url.searchParams.get("gateway"));

    if (!/^\d{6}$/.test(code)) {
      return null;
    }

    return {
      code,
      gateway,
    };
  } catch {
    return null;
  }
}
