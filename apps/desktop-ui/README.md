# LinkShell Workspace (`@linkshell/desktop-ui`)

Unified React 19 + TypeScript + Tailwind 4 workspace powering both the native desktop app (`apps/desktop`, `apps/mac`, `apps/windows`) and the browser client bundled by `@linkshell/gateway` at `/`.

```bash
pnpm install
pnpm dev:web                                     # Vite dev server on 127.0.0.1
pnpm --filter @linkshell/desktop-ui build        # Build dist/ for desktop and gateway
pnpm --filter @linkshell/desktop-ui lint
pnpm --filter @linkshell/desktop-ui test
pnpm --filter @linkshell/gateway build:web       # Populate packages/gateway/web-client/
```

## Runtime Modes

- **Desktop (`data-shell="electron"`)**: Connects directly to the local Host sidecar (`#desktop=<capability>`) for zero-login local sessions, local host service management, macOS Metal remote screen, and macOS/Windows Fusion window streaming, while also supporting remote computers via Gateway or LAN.
- **Browser (`data-shell="browser"`)**: Served at `/` by `@linkshell/gateway` alongside `/v2/connect` and `/healthz`. Uses `/config.js` (`deployment: "official" | "self-hosted"`), persists its Ed25519/X25519 device identity in IndexedDB (`linkshell.web.identity`), coordinates multi-tab connection ownership with `navigator.locks`, and supports email/password + PKCE OAuth (`/?linkshell-auth-callback=1` or loopback `/linkshell/callback`) as well as 6-digit / QR pairing.

For standalone static hosting, edit `dist/config.js` (never put secrets in this file):

```js
window.__LINKSHELL_CONFIG__ = {
  deployment: "self-hosted",
  gatewayUrl: "wss://gateway.example.com",
  previewOrigin: "https://preview.example.net",
};
```
