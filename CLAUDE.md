# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is LinkShell

Remote terminal bridge — control local CLI sessions from your phone. A CLI spawns a PTY on the host machine, connects to a gateway (embedded or cloud), and mobile/web clients connect to interact with the terminal in real-time.

## Build & Dev

```bash
pnpm install
pnpm build                # Build all packages (tsc in each)
pnpm typecheck            # Type check all packages (tsc --noEmit)
pnpm dev:gateway          # Dev gateway (localhost:8787)
pnpm dev:cli              # Dev CLI
pnpm dev:app              # Dev mobile app (Expo)
pnpm dev:web              # Dev web dashboard (Vite)
```

## Mobile Build

- iOS: `pnpm prod:ios` (full prebuild, never use `prod:ios:quick`)
- Android: `pnpm prod:android` or `pnpm prod:android:apk`

## Project Structure

- `packages/shared-protocol` — Single-file Zod schema (`src/index.ts`): envelope format + 40+ message types
- `packages/gateway` — Cloud gateway (Node.js HTTP + ws): pairing, session relay, tunnel proxy, auth middleware
- `packages/cli` — CLI (commander): BridgeSession with PTY (node-pty), daemon mode, embedded gateway, login/upgrade
- `apps/mobile` — Expo 54 + React Native + Expo Router + xterm.js (in WebView)
- `apps/web-dashboard` — Vite + React 19 + React Router 7 + Tailwind (login + subscription dashboard)

## Architecture

### Data Flow

1. CLI starts → spawns PTY → connects to gateway (embedded on random port, or remote via `--gateway`)
2. Gateway generates 6-digit pairing code (7-day TTL) + QR code
3. Mobile app scans QR / enters code → `POST /pairings/claim` → gets sessionId + deviceToken
4. Mobile opens WebSocket: `wss://gateway/ws?sessionId=...&role=client&token=...`
5. Terminal I/O relayed: client sends `terminal.input` → gateway → host PTY; host sends `terminal.output` → gateway → client

### Protocol (`packages/shared-protocol`)

All messages use a unified envelope: `{ id, type, sessionId, terminalId?, deviceId?, timestamp, seq?, ack?, payload }`. Payloads are Zod-validated; invalid messages trigger `session.error`. Message categories: session lifecycle, terminal I/O, terminal management, control (claim/grant/reject), pairing, screen sharing (WebRTC SDP/ICE), file upload, tunnel proxy, history.

### Gateway (`packages/gateway`)

- **SessionManager** — In-memory `Map<sessionId, Session>`, buffers last 200 output envelopes per terminal for resume replay, cleanup 60s after host disconnect
- **PairingManager** — 6-digit codes, 7-day TTL, cleanup every 60s
- **TokenManager** — Device tokens bound to sessions, 7-day TTL
- **Relay** — Routes messages host↔clients, handles `session.resume` with buffered replay
- **Tunnel** — HTTP + WebSocket proxy at `/tunnel/{sessionId}/{port}{path}`, cookie fallback for HMR, 30s timeout
- **Auth middleware** — Optional (`AUTH_REQUIRED=true`), validates Supabase JWT + subscription check every 5min
- **Embedded mode** — `startEmbeddedGateway()` used by CLI when no `--gateway` flag, starts on random port

### CLI (`packages/cli`)

- **BridgeSession** (`runtime/bridge-session.ts`) — Core class: spawns PTY, manages WebSocket, handles pairing, multi-terminal (200-line scrollback per terminal), reconnection (exponential backoff, max 20 attempts)
- **Daemon** (`utils/daemon.ts`) — Detached child process, PID in `~/.linkshell/bridge.pid`, logs to `~/.linkshell/bridge.log`
- **Providers** (`providers.ts`) — Resolves CLI executables (claude, codex, gemini, etc.)
- **Auth** (`auth.ts`) — Tokens in `~/.linkshell/auth.json` (mode 0o600), Supabase OAuth via iTool
- **Screen sharing** — WebRTC (werift + ffmpeg H.264) preferred, JPEG polling fallback

### Mobile (`apps/mobile`)

- xterm.js runs inside a WebView (React Native has no DOM); communicates via `postMessage`
- Terminal HTML built by `scripts/build-terminal-html.mjs`
- Multi-terminal tabs with spawn/kill/status
- Screen sharing: WebRTC video stream preferred, JPEG fallback
- Storage: AsyncStorage for device tokens, server list, history

## Release

See [docs/release-sop.md](docs/release-sop.md) for the full checklist.

Publish order: protocol → gateway → cli (dependency chain).

Tag `gateway-vX.Y.Z` triggers Docker Hub CI. Run `./scripts/update-brew.sh` to update Homebrew tap.

## Distribution Channels

- npm: `npm install -g linkshell-cli`
- Homebrew: `brew install LiuTianjie/linkshell/linkshell`
- curl: `curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh`
- Docker Hub: `nickname4th/linkshell-gateway` (CI: `.github/workflows/docker-publish.yml`)
- GitHub Pages: `docs/site/` via `.github/workflows/pages.yml`

## Auth & Backend

- Supabase project: `mkbeusztkzffnzjdwmqk` (shared with iTool)
- Tables: `linkshell_device_tokens`, `linkshell_official_gateways` (+ iTool's `profiles` for subscription)
- Gateway env vars: `AUTH_REQUIRED`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Subscription check: queries `profiles.plan` + `profiles.plan_expires_at`

## Conventions

- Commit style: `feat:`, `fix:`, `docs:`, `release:`
- Chinese UI text in mobile app
- English in README.md, Chinese in README_CN.md
