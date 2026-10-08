# LinkShell Web

A browser client for the existing LinkShell host and gateway. The normal entry point uses real pairing, encrypted tunnels and `@linkshell/client-core` state. `?demo=1` is a separate, explicitly labeled UI demonstration with local fixtures.

The layout and light/dark colors follow the mobile app. Dropdowns, operation menus, command search and dialogs use shadcn/ui (Radix), with source in `src/components/ui`. `components.json` and the `@/*` alias configure the component CLI. Tailwind semantic colors map to the shared mobile palette in `src/theme.ts`; existing layout CSS stays in the base layer.

```bash
pnpm install
pnpm dev:web
pnpm --filter @linkshell/web build
pnpm --filter @linkshell/web lint
pnpm --filter @linkshell/web test
```

Output: `apps/web/dist`. Serve the complete directory at an HTTPS origin's root. The website and gateway are separate deployments; the gateway still only serves `/v2/connect` and `/healthz`.

## Functions

- Official email/password and GitHub/Google sign-in, automatic account token refresh, account computer discovery and sign-out. OAuth redirect origins must be allowed in the existing Supabase project.
- Official or custom gateway pairing by code, pasted link, QR image or camera; persisted browser identity and paired computers; switching computers and revoking devices.
- Session search/filter, archived sessions, projects, new sessions and worktrees, history pagination, streaming messages, draft persistence, attachments, queue editing/reordering, interrupt, steer, rename, archive, delete, fork, and supported handoff takeover/release.
- Dynamic slash commands and Skills from the shared mobile command catalog and Host reports. Command palette and inline suggestions support keyboard navigation. MCP and connector commands go through the agent; their output uses the same rich timeline. Available commands and settings depend on the connected agent's capabilities.
- Dynamic model/permission settings, permission approvals and structured questions, Markdown, images, links, tool output and diffs, plans, usage, goals, workflows, background tasks and subagent conversations.
- Host files, text/image viewing, directory selection, upload and directory creation; worktree status/removal; xterm.js terminals with startup commands, rerun, file upload/paste, font sizing, input, resize and reconnect replay (including framed replay from the current host).
- Remote screen viewer and input through the existing host screen service; port previews through an isolated browser origin, streaming HTTP/SSE and WebSocket forwarding over encrypted host streams; WebRTC data-channel transport when available.
- Multi-tab ownership: one tab holds the browser device connection. Another tab can explicitly take it over.

Browser UI does not independently reimplement authorization, agent execution or the session event model. Host actions remain authoritative. Unsupported agent capabilities are not advertised as available.

## Official and private deployments

| | Official website | Self-hosted website |
| --- | --- | --- |
| Public setting | `deployment: "official"` | `deployment: "self-hosted"` |
| Entry points | Official account or gateway pairing | Custom gateway pairing only |
| Gateway | Fixed official endpoint for account access; custom gateway entered separately | Pre-filled from configuration, editable |
| Account/subscription | Same iTool account; an active Pro subscription for the computer connecting to the official gateway | No official account or subscription |
| Credentials | Account tokens only to the official account service and fixed official gateway | Never send iTool account tokens to a custom gateway |

The official website can also connect to a custom gateway. Serving the website privately does not itself create a gateway or expose a host.

Replace `dist/config.js` without rebuilding (or edit `public/config.js` before building):

```js
window.__LINKSHELL_CONFIG__ = {
  deployment: "self-hosted",
  gatewayUrl: "wss://gateway.example.com",
  previewOrigin: "https://preview.example.net",
};
```

Never put secrets in this file. HTTPS sites require WSS gateways. Loopback WS is accepted only for local HTTP development. Clear browser site data to remove its local identity; it must then pair again.

## Port preview origin

Production port previews require a **separate origin** serving `public/preview/` at `/preview/`. Keep this origin free of account cookies and privileged applications. Prefer a separate registrable domain to avoid shared-domain cookies. Serve its service worker and bridge over HTTPS. Do not redirect preview requests to the main app or register this worker on the app origin.

The bridge uses a service worker for HTTP requests and a WebSocket shim for socket traffic. Parent/iframe messages validate their source, origin and random channel; the parent only forwards to the selected host port. Preview content does not receive the main origin's device keys or account tokens. The gateway continues to route encrypted frames and does not become a plaintext preview proxy.

Local Vite development automatically uses `localhost` versus `127.0.0.1` as separate origins. A static production-build smoke test must explicitly configure `previewOrigin`, even on localhost.

Port previews target ordinary development websites, same-origin assets/API requests and WebSockets. Sites requiring their own service worker, absolute loopback URLs, external OAuth origins or unusual browser/streaming features need individual compatibility validation. The preview cookie jar is scoped to the mounted preview and is not a general browser cookie store.

## Validation

`test/transport.test.ts` and `test/parity.test.ts` check HTTP response boundaries, incremental SSE/chunked decoding, WebSocket framing and fragmentation, host file/line links, and terminal replay geometry/parser completion. For an isolated UI integration environment:

```bash
pnpm --filter @linkshell/host exec tsx ../../apps/web/scripts/fixture.ts
```

This starts a real local gateway on `5181`, a host with temporary state and an explicit test driver, plus a preview HTTP/WebSocket service on `5182`. Its printed pairing code connects the UI to that host. The driver simulates agent events; terminal/file transport uses the real host. Stop the process after testing. Do not expose its ports publicly.

Browser integration checks cover pairing, commands/Skills, MCP output, permission questions, terminal I/O, files, HTTP/JavaScript/WebSocket preview and screen display. They are not proof of real-agent execution, production account/OAuth configuration, all network paths, camera permission behavior or iOS/Android device compatibility. Builds and local checks are not deployment; publication remains manual.

## Parity review (2026-10-08)

The review compared mobile routes, command dispatch and `@linkshell/wire` RPCs. Fixed defects include inline commands pushing the composer offscreen; Claude goals using Codex-only RPC; goal editing/status handling; official-gateway pairing rejection; file links opening as browser URLs; missing remote image URIs; subagent failure states and task-output refresh; terminal frame replay and historical query writebacks; SSE buffering; missing computer-preview show notifications; unusable agent/worktree choices; and worktree deletion choices.

Local browser checks verified the composer with all slash suggestions, model settings, file links, goal save/reopen/pause, a real PTY surviving reload, ordinary HTTP/JS/API/WebSocket preview and a persistent SSE event stream. Agents in those checks are fixtures. Production account refresh/OAuth, actual Codex/Claude/ACP command behavior and WAN/WebRTC paths still require separate live validation.

Port-preview compatibility is intentionally bounded by browser origin isolation; external OAuth, absolute loopback fetches, applications that install their own service worker, and full browser cookie semantics are not yet equivalent to the mobile TCP proxy. The browser terminal uses xterm.js; native terminal image/graphics protocols are not a claimed parity guarantee. Do not describe local tests or the coverage table as full production parity.
