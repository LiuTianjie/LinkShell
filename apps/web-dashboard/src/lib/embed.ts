// Embedded boot: when the SPA is hosted inside the mobile app's WebView, the
// native host hands it connection params via the query string (and pre-seeds
// localStorage as a reload fallback). See
// apps/mobile/src/features/agent-web/DESIGN.md for the frozen contract.
//
// Contract (query string, authoritative): ?embed=1&session=<id>&gateway=<httpUrl>
//   &token=<deviceToken>&theme=<dark|light>
//
// When embed=1 is absent the plain web app is byte-for-byte unchanged.

import { saveGatewayUrl } from "./gateway-config";
import { setDeviceToken } from "./device-token";
import { setThemePref } from "./theme";
import type { AppView } from "./storage";

export interface EmbedBootstrap {
  embed: boolean;
  sessionId: string | null;
  gateway: string | null;
  token: string | null;
  theme: "dark" | "light" | null;
}

/** Parse the embed bootstrap from location.search. Pure read, no side effects. */
export function readEmbedBootstrap(): EmbedBootstrap {
  try {
    const params = new URLSearchParams(window.location.search);
    const embed = params.get("embed") === "1";
    const theme = params.get("theme");
    return {
      embed,
      sessionId: params.get("session"),
      gateway: params.get("gateway"),
      token: params.get("token"),
      theme: theme === "dark" || theme === "light" ? theme : null,
    };
  } catch {
    return { embed: false, sessionId: null, gateway: null, token: null, theme: null };
  }
}

/**
 * Apply the bootstrap: persist gateway + device token + theme, then return the
 * view to seed. Returns null when not an embed boot (or when malformed), so the
 * caller falls back to loadView() and the normal app.
 */
export function applyEmbedBootstrap(b: EmbedBootstrap): AppView | null {
  if (!b.embed) return null;
  // Malformed embed degrades to the normal app rather than crashing.
  if (!b.sessionId || !b.token || !b.gateway) return null;

  saveGatewayUrl(b.gateway);
  setDeviceToken(b.token);
  if (b.theme) setThemePref(b.theme);

  return { name: "console", sessionId: b.sessionId };
}

/** Tell the native host the user pressed "back" from the console. No-op on plain web. */
export function postRequestCloseToHost(): void {
  try {
    const rn = (window as unknown as {
      ReactNativeWebView?: { postMessage: (msg: string) => void };
    }).ReactNativeWebView;
    rn?.postMessage(JSON.stringify({ type: "requestClose" }));
  } catch {}
}

// Persisted embed flag, written by the native host's localStorage seed (Channel
// B) BEFORE first paint. Unlike the query string — which is dropped on reload —
// this survives, so the app stays embed-aware (back→requestClose, chrome hidden,
// native-owned theme) across reloads/pull-to-refresh inside the WebView.
const EMBED_FLAG_KEY = "linkshell_embed";

/** True when running inside the mobile app's WebView (query flag or persisted). */
export function isEmbedded(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("embed") === "1") return true;
    return localStorage.getItem(EMBED_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
