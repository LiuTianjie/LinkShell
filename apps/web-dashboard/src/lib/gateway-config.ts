// Which gateway the web client talks to.
//
// In production the gateway SERVES this SPA same-origin, so the default is the
// page's own origin — open https://xxx.itool.tech/ and it connects to
// xxx.itool.tech automatically ("web follows the gateway"). In Vite dev the
// page is served separately, so default to the local gateway. Always
// user-overridable (e.g. point a locally-served page at a remote gateway) and
// persisted.

import type { GatewayConfig } from "./types";

const KEY = "linkshell_gateway_url";
const LOCAL_GATEWAY = "http://localhost:8787";

function defaultGateway(): string {
  if (import.meta.env.DEV) return LOCAL_GATEWAY;
  // Same-origin: the gateway that delivered this page is the one to talk to.
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin.replace(/\/+$/, "");
  }
  return LOCAL_GATEWAY;
}

export function loadGatewayConfig(): GatewayConfig {
  let httpUrl = defaultGateway();
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) httpUrl = stored;
  } catch {}
  return { httpUrl };
}

export function saveGatewayUrl(httpUrl: string): void {
  try {
    localStorage.setItem(KEY, httpUrl.replace(/\/+$/, ""));
  } catch {}
}

export { defaultGateway as DEFAULT_GATEWAY };
