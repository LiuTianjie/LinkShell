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
    const url = new URL(value);
    const hostname = url.hostname.trim().toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    ) {
      return undefined;
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "") || undefined;
  }
}

export function parsePairingLink(raw: string): PairingLinkPayload | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "linkshell:" || url.hostname !== "pair") {
      return null;
    }

    const code = url.searchParams.get("code")?.trim() ?? "";
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
