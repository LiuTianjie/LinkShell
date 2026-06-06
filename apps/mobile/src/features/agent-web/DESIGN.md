# Agent Web Console in WebView — FROZEN DESIGN

> Status: **frozen**. This is the authoritative contract for embedding the
> `apps/web-dashboard` agent console inside the mobile app via a WebView. Two
> implementation agents (WEB side, MOBILE side) work independently against this
> document. Do not renegotiate the contract during implementation — if something
> here is wrong, fix the doc first, then code.

## Goal

The in-app agent experience must be **byte-for-byte the web experience** — the
same React app, the same DOM/CSS/scroll behavior served same-origin by the
gateway at `<gatewayHttpUrl>/`. The mobile app is a thin native host: it resolves
which session to show, hands the web SPA its connection params, and renders it
full-screen in a WebView. It is **not** a reimplementation of the agent UI.

The web SPA already supports a never-logged-in client connecting to a session it
owns via a device token (`?token=` → gateway `tokenOwns` path). That is the
headless handoff: **no Supabase interactive login happens inside the WebView.**

---

## 1. URL + Storage Contract (the seam between the two sides)

The web SPA reads its target from **two channels**, seeded by the native host
*before* the page paints:

### Channel A — URL query string (authoritative, parsed first)

```
<gatewayHttpUrl>/?embed=1&session=<sessionId>&gateway=<gatewayHttpUrl>&token=<deviceToken>&theme=<dark|light>
```

| Param     | Required | Meaning                                                        |
|-----------|----------|----------------------------------------------------------------|
| `embed`   | yes      | Presence flag = `1`. Marks an embedded boot; enables the bypass branch and suppresses chrome the host owns. |
| `session` | yes      | `sessionId` to open the console for. Maps to `view = {name:"console", sessionId}`. |
| `gateway` | yes      | Full `http(s)` base of the gateway. Persisted via `saveGatewayUrl`. In practice equals the page origin (served same-origin), but passed explicitly so it is unambiguous. |
| `token`   | yes      | Device token. Persisted via `setDeviceToken`. Drives the WS `?token=` `tokenOwns` auth path. |
| `theme`   | no       | `dark` \| `light`. Applied via `setThemePref`. Omitted → SPA keeps its own stored/default theme. |

### Channel B — pre-seeded localStorage (belt-and-suspenders, set before content loads)

The native host ALSO seeds localStorage in `injectedJavaScriptBeforeContentLoaded`
so that even on a reload (where the WebView may drop the query string) the SPA
lands in the right place. Keys (must match `apps/web-dashboard/src/lib`):

```js
localStorage.setItem('linkshell_gateway_url', '<gatewayHttpUrl>');           // gateway-config.ts KEY
localStorage.setItem('linkshell_device_token', '<deviceToken>');             // device-token.ts KEY
localStorage.setItem('linkshell_theme', '<dark|light>');                     // theme.ts KEY (only if theme provided)
localStorage.setItem('linkshell_view',                                       // storage.ts VIEW_KEY, versioned envelope
  JSON.stringify({ version: 1, data: { name: 'console', sessionId: '<sessionId>' } }));
```

**Precedence rule (WEB side):** when `embed=1` is present in the query string,
the query string wins for `gateway`/`session`/`token`/`theme`. localStorage is
the fallback for reloads. The versioned envelope `{version:1,data:...}` is
mandatory for `linkshell_view` — `storage.ts` rejects anything else.

### Concrete example

```
https://gw.itool.tech/?embed=1&session=8f3c1a90-2b&gateway=https%3A%2F%2Fgw.itool.tech&token=d4e5f6a7-8b9c&theme=dark
```

> URL contract is fully specified: path `/`, flag `embed=1`, plus
> `session`, `gateway`, `token`, `theme`. All values URL-encoded by the host.

---

## 2. WEB side — `apps/web-dashboard`

### New helper: `src/lib/embed.ts`

```ts
export interface EmbedBootstrap {
  embed: boolean;
  sessionId: string | null;
  gateway: string | null;
  token: string | null;
  theme: "dark" | "light" | null;
}

// Parse once from location.search. Pure read, no side effects.
export function readEmbedBootstrap(): EmbedBootstrap;

// Apply the bootstrap: persist gateway + device token + theme, then return the
// view to seed. Returns null when not an embed boot (caller falls back to loadView()).
export function applyEmbedBootstrap(b: EmbedBootstrap): AppView | null;
```

`applyEmbedBootstrap` calls, in order, only when `b.embed === true`:
1. `saveGatewayUrl(b.gateway)`        — from `lib/gateway-config.ts`
2. `setDeviceToken(b.token)`          — from `lib/device-token.ts`
3. `if (b.theme) setThemePref(b.theme)` — from `lib/theme.ts`
4. return `{ name: "console", sessionId: b.sessionId }` (or `null` if `sessionId`/`token`/`gateway` missing — malformed embed degrades to normal app)

### Change: `src/main.tsx`

Top of `App()`, before the existing `useState(() => loadView())` (line 21),
compute the embed bootstrap once:

```ts
const embedView = useMemo(() => applyEmbedBootstrap(readEmbedBootstrap()), []);
const [view, setViewState] = useState<AppView>(() => embedView ?? loadView());
const isEmbed = embedView !== null;
```

- `session` state stays `null` for embed (no Supabase). The existing
  `loadSession()` effect is harmless — it just finds nothing.
- When `isEmbed`, never auto-show Login and never render `SessionListPage`.
  Concretely: leave `showLogin` initial `false` (already is), and the
  `onBack` passed to `AgentConsolePage` becomes a no-op that instead posts
  `requestClose` to the native host (see §4) rather than `setView({name:"list"})`.

```ts
if (view.name === "console") {
  return (
    <AgentConsolePage
      sessionId={view.sessionId}
      session={session}                              // null in embed — already supported
      onBack={isEmbed ? postRequestCloseToHost : () => setView({ name: "list" })}
    />
  );
}
```

`postRequestCloseToHost` = `window.ReactNativeWebView?.postMessage(JSON.stringify({type:"requestClose"}))`.
Guard on `window.ReactNativeWebView` so plain web is unaffected.

### Graceful degradation (MUST)

- No `embed=1` → `applyEmbedBootstrap` returns `null` → `loadView()` seeds as
  today. **Normal web app is byte-for-byte unchanged.**
- `embed=1` but missing `session`/`token`/`gateway` → returns `null` → falls
  back to normal app (which will show the session list / login). No crash.
- `AgentConsolePage` already tolerates `session=null` (`void session`, only used
  for header email/badge), and `useWorkspace`'s `getJwt` returns `null` when
  logged out → device-token-only connect. **Zero downstream changes.**

### WEB files to touch

| File | Change |
|------|--------|
| `src/lib/embed.ts` | **new** — `readEmbedBootstrap`, `applyEmbedBootstrap` |
| `src/main.tsx` | seed `view` from embed bootstrap; embed-aware `onBack`; `postRequestCloseToHost` |

Functions reused (no change): `saveGatewayUrl`, `setDeviceToken`, `setThemePref`,
`loadView`, `AgentConsolePage`, `useWorkspace`.

---

## 3. MOBILE side — `apps/mobile/src/features/agent-web/AgentWebScreen.tsx`

A new screen that hosts the WebView. **Same prop shape the route already passes
to the native screen**, so the route switch is one line.

### Props

```ts
export interface AgentWebScreenProps {
  conversationId: string;
  workspace: AgentWorkspaceHandle;   // from contexts/AppContext (ctx.agentWorkspace)
  isRestoring?: boolean;             // accepted for parity with route; controls initial spinner
  onBack: () => void;                // router.back()
}
```

### Resolving the embed URL

1. `const conv = workspace.getConversation(conversationId)` — gives `serverUrl`
   (already an HTTP(S) URL, normalized, no trailing slash) and `sessionId`.
2. `const token = await getDeviceToken()` — from `storage/device-token.ts`
   (async, SecureStore-backed). Gate render on a resolved-token state.
3. Build:
   ```ts
   const base = conv.serverUrl;                       // = gatewayHttpUrl, no ws→http conversion needed
   const q = new URLSearchParams({
     embed: "1",
     session: conv.sessionId,
     gateway: base,
     token: token ?? "",
     theme: resolvedTheme,                             // "dark" | "light" from useTheme()
   });
   const uri = `${base}/?${q.toString()}`;
   ```
4. The existing resume/connect path (route effect calling
   `workspace.resumeConversation`) stays — it brings the host CLI session live
   before/while the WebView loads. The WebView connects independently by device
   token, so even if resume is mid-flight the page just waits for the host.

### WebView config (copy `BrowserView.tsx` conventions)

- `source={{ uri }}`, `ref={webViewRef}`, `key={webViewKey}` (bump to remount).
- `sharedCookiesEnabled`, `javaScriptEnabled`, `domStorageEnabled` (**required**
  — SPA persists to localStorage), `allowsInlineMediaPlayback`,
  `mediaPlaybackRequiresUserAction={false}`.
- Safe area: wrap in `View` with `useSafeAreaInsets()`; `paddingTop: insets.top`,
  `paddingBottom: insets.bottom`; container `backgroundColor` = `pageThemeColor || theme.bg`
  to avoid notch flash.
- `injectedJavaScriptBeforeContentLoaded` — seed Channel-B localStorage (gateway,
  device token, theme, versioned `linkshell_view` envelope) so reloads land
  correctly. **Must end with `true;`.**
- `injectedJavaScript` (after load) — reuse the theme-color extractor from
  `BrowserView` (posts `{type:'themeColor',color}`). **Must end with `true;`.**
- `onLoadStart`/`onLoadEnd` → toggle loading overlay (`ActivityIndicator`) shown
  until first paint.
- `onMessage` → JSON.parse in try/catch, handle the bridge schema in §4.
- Error/retry: `onError`/`onHttpError` → show an error state with a Retry button
  that bumps `webViewKey`. Also surface `unauthorized`/`error` bridge messages
  (token rejected) with a "re-pair" hint.
- Pull-to-refresh / remount: `pullToRefreshEnabled` (iOS) and/or a manual reload
  that bumps `webViewKey`.
- Hardware back (Android): `BackHandler` → if `canGoBack` (tracked via
  `onNavigationStateChange`) call `webViewRef.goBack()`, else `onBack()`.

### `injectedJavaScriptBeforeContentLoaded` template

```js
(function () {
  try {
    localStorage.setItem('linkshell_gateway_url', '<gatewayHttpUrl>');
    localStorage.setItem('linkshell_device_token', '<deviceToken>');
    // theme only if provided:
    localStorage.setItem('linkshell_theme', '<dark|light>');
    localStorage.setItem('linkshell_view', JSON.stringify({
      version: 1, data: { name: 'console', sessionId: '<sessionId>' }
    }));
  } catch (e) {}
})();
true;
```

> All interpolated values MUST be JS-string-escaped (`JSON.stringify` the value,
> not just wrap in quotes) to avoid breaking out of the literal.

---

## 4. postMessage bridge schema (minimal)

JSON strings via `window.ReactNativeWebView.postMessage` (web→native) and
`webViewRef.injectJavaScript` (native→web). Keep it tiny for v1.

### web → native

| `type`          | payload         | host action |
|-----------------|-----------------|-------------|
| `themeColor`    | `{color}`       | set container bg (reuse `BrowserView` handler) |
| `ready`         | —               | optional handshake; hide spinner if not already |
| `requestClose`  | —               | call `onBack()` (web "back" from console) |
| `error`         | `{message?}`    | show error state |
| `unauthorized`  | —               | token rejected → error state + re-pair hint |
| `openExternal`  | `{url}`         | `Linking.openURL(url)` (external links open in system browser) |

### native → web (v1: theme only; optional)

| injected call | effect |
|---------------|--------|
| `window.__linkshellSetTheme && window.__linkshellSetTheme('<dark\|light>')` | host→page theme sync if the user flips theme while the WebView is mounted. Web exposes `window.__linkshellSetTheme = (t) => setThemePref(t)` under embed. Optional for v1; theme is otherwise set once via URL/localStorage at boot. |

No other channels are needed for v1.

---

## 5. Native capabilities

- **Image attach: works with no bridge.** iOS WKWebView handles
  `<input type=file accept=image/*>` natively (photo picker/camera). The web
  composer's existing attach flow runs in-WebView unchanged.
- **Voice: out of scope.** The web console has no voice input, so parity needs
  nothing here.
- **Nothing else needs bridging for v1.** Terminal I/O, history, scroll,
  streaming all happen inside the web SPA over its own WebSocket.

---

## 6. Migration & rollback

- **Route switch (one line):** in
  `apps/mobile/src/app/agent/[conversationId].tsx`, swap the rendered component
  from `AgentConversationScreen` to `AgentWebScreen`, passing the **same props**
  (`conversationId`, `workspace`, `isRestoring`, `onBack`). The resume effect
  above it is unchanged.
- **Keep orphaned for rollback — do NOT delete:**
  - `apps/mobile/src/features/agent/` (the entire native screen + components)
  - any just-built native `agent` module pieces
  These remain importable; reverting is the same one-line route change back.

---

## Frozen invariants (don't drift)

1. localStorage keys are exactly: `linkshell_gateway_url`, `linkshell_device_token`,
   `linkshell_theme`, `linkshell_view` (versioned `{version:1,data}`).
2. Query params are exactly: `embed`, `session`, `gateway`, `token`, `theme`.
3. Embed path uses device-token-only auth (`?token=` / `tokenOwns`); no Supabase
   login inside the WebView.
4. Plain web (no `embed=1`) is byte-for-byte unchanged.
5. The WebView renders `<gatewayHttpUrl>/` — the same-origin web SPA — never a
   reimplementation.
