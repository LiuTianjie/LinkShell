# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is LinkShell

Follow, steer and approve the coding agents running on your computer, from your phone. Three parts:

- **The host** — a daemon on the computer (`linkshell host`). It owns the agent sessions (Codex, Claude Code, ACP agents), terminals, port previews and the screen, and keeps their history.
- **The app** — iOS / Android (`apps/client`). A client of the host.
- **The gateway** — a relay between the two. Everything it routes is end-to-end encrypted; it only authenticates peers by key, brokers pairing and knows who may reach whom.

There is one generation of everything. The 1.x PTY bridge, its protocol, its web console and its half of the gateway are deleted; don't bring them back.

## Build & Dev

pnpm workspace (`apps/*`, `packages/*`), Node.js 22.13+ (the host and the gateway use `node:sqlite`).

```bash
pnpm install
pnpm build                # pnpm -r build: tsc in each package; on a Mac also builds LinkShell.app (apps/mac)
pnpm typecheck            # pnpm -r typecheck
pnpm test                 # every package's tests, one package at a time; on a Mac also apps/mac's swift test
pnpm -r --filter "./packages/*" build   # the packages only: what CI builds and tests (Linux)
pnpm --filter @linkshell/host test      # one package (vitest)
```

Run the pieces from the checkout:

```bash
cd packages/cli && npx tsx src/index.ts host --dev-port 7878   # a host that also serves its API on ws://127.0.0.1:7878 (loopback, development only)
pnpm dev:app              # Metro for the app (expo start)
pnpm dev:ios              # development build "LinkShell Dev" (com.bd.linkshell.v2), installs beside the released app
pnpm dev:android
pnpm dev:gateway          # the gateway from source (tsx src/main.ts), port 8787, data in packages/gateway/data/relay.db
pnpm dev:cli <command>    # the CLI from source (tsx src/index.ts)
```

- A development build of the app connects to `ws://127.0.0.1:7878` by default (`EXPO_PUBLIC_LINKSHELL_HOST`, `apps/client/src/lib/settings.ts`).
- `LINKSHELL_HOME=<dir>` gives a host its own state directory, so a development host doesn't share `~/.linkshell` with the installed one.
- The CLI compiles the host's and the gateway's sources too: after changing either, run the full `pnpm build` and `pnpm typecheck`, not just one package's.
- Real agents: `pnpm --filter @linkshell/host live:codex` / `live:claude` (need the agent installed and signed in; `live:claude` from your own terminal).

LinkShell.app (`apps/mac`, Swift; macOS 13+, Apple silicon, Xcode's Swift):

```bash
pnpm --filter @linkshell/mac build    # build/LinkShell.app and build/LinkShell.app.tar.gz
pnpm --filter @linkshell/mac test     # swift test: what needs no screen and no network
pnpm --filter @linkshell/mac check    # that, then pass or fail for the built app (about a minute)
```

Without a Developer ID certificate it is signed ad hoc: fine for development, a different app to macOS (its own permissions), never for release. See `apps/mac/README.md`.

App release builds: `pnpm prod:ios` / `pnpm prod:android` (`apps/client/scripts/release.mjs`; always a clean prebuild of the release variant — there is no quick variant).

## Project Structure

- `packages/wire` (`@linkshell/wire`) — what the host, the gateway and the app share. `model.ts` + `updates.ts` (sessions and their events, ACP-shaped), `rpc.ts` (the host's JSON-RPC methods and notifications, zod), `peer.ts` (JSON-RPC peer), `crypto.ts` (identities, signatures, channel keys), `relay.ts` (gateway frames, pairing link, the end-to-end tunnel), `relay-client.ts` (one connection to a gateway), `direct.ts` (direct-channel framing).
- `packages/host` (`@linkshell/host`) — the daemon. `host.ts` (`startHost`, paths), `hub.ts` (`SessionHub`), `store.ts` (SQLite `state.db`), `drivers/` (`codex/` app-server, `claude/` handoff, `acp/` everything else, `registry.ts`), `rpc/server.ts` (every RPC method), `gateway.ts` (`GatewayLink`: identity, pairing, tunnels), `direct.ts` (WebRTC data channel, werift), `terminals.ts` (node-pty), `ports.ts` (previews), `screen.ts` + `screen-viewer.ts` + `screen-pacer.ts` + `input.ts` (the screen), `worktrees.ts`, `fs.ts`.
- `packages/gateway` (`@linkshell/gateway`) — the relay; the official gateway and a self-hosted one are this same package. `relay.ts` (`Gateway`: auth, routing, pairing, backpressure), `store.ts` (SQLite), `accounts.ts` (`supabaseVerifier`), `subscription.ts` (the Pro check), `rate-limit.ts`, `serve.ts` (`startGateway`: HTTP server, `/healthz`, the upgrade), `main.ts` (the executable: env → `startGateway`), `index.ts` (exports only). `Dockerfile` builds `nickname4th/linkshell-gateway`.
- `packages/cli` (`linkshell-cli`, bin `linkshell`) — commander commands in `src/index.ts` and `src/commands/*`; `auth.ts` (the account), `utils/daemon.ts` (background processes, pid and log files).
- `packages/client-core` (`@linkshell/client-core`) — client state without UI: `host-link.ts` (RPC connection), `tunnel-socket.ts` (that connection through a gateway), `store.ts` (zustand), `timeline.ts` (event log → what is rendered), `streams.ts` (byte streams for previews and the screen), `pairing.ts`.
- `apps/client` (`@linkshell/client`) — the app: Expo + React Native + Expo Router. Routes in `src/app/`, screens in `src/screens/`, `src/lib/` (`client.tsx`, `computers.ts`, `identity.ts`, `account.ts`, `direct.ts`), native modules in `modules/` (`link-terminal`, `link-socket`, `link-screen` for iOS WebRTC/Metal screen reception). Read `apps/client/AGENTS.md` before touching Expo APIs.
- `apps/mac` (`@linkshell/mac`) — LinkShell.app: captures the Mac's screen, sends it (WebRTC video, or encoded for the host), posts pointer and key events, and holds the two macOS permissions. Shipped to npm as one archive.
- `docs/site` — the website and `install.sh` (GitHub Pages). After editing `index.html` run `python3 scripts/build-site-pages.py`.
- `docs/v2/architecture.md` (design), `docs/v2/screen-realtime.md` (current screen architecture, diagrams, fallback and validation; older experiments in `screen-realtime-history.md`), `docs/deploy.md` (self-hosting), `docs/release-sop.md`.

## Architecture

### The host and its files

`linkshell host --daemon` starts the host detached; local clients (the CLI, `linkshell claude` / `codex`) reach it over a unix socket. State is in `~/.linkshell` (`LINKSHELL_HOME` moves it):

| File | What |
| --- | --- |
| `state.db` | sessions and their event logs (SQLite) |
| `identity.json` | this computer's keys (0600); its id derives from the signing key |
| `machine.json` | the machine id shown in `machine.info` |
| `paired-devices.json` | phones paired with it, with their keys (0600) |
| `config.json` | the chosen gateway (`off` is a choice), whether setup has run |
| `auth.json` | the account from `linkshell login` (0600) |
| `run/host.sock`, `run/codex.sock` | the host's API; the shared Codex app-server |
| `host.pid`, `host.log`, `gateway.pid`, `gateway.log` | background processes |
| `relay.db` | pairings, when this computer runs `linkshell gateway` |
| `worktrees/` | git worktrees made for sessions |
| `LinkShell.app` | unpacked from `@linkshell/mac` on first use (macOS) |

Agents run as the user with the login shell's environment; LinkShell never handles their credentials.

### From phone to host

1. **Relay auth.** Host (role `machine`) and app (role `device`) each open a WebSocket to `<gateway>/v2/connect`. The gateway sends a nonce; the peer signs `linkshell-gateway-v2:${nonce}` with its Ed25519 key, and may add an account token.
2. **Who may reach whom.** A device reaches a machine it is **paired** with, or one on the same **account**. Pairing: `linkshell pair` asks the gateway for a 6-digit code (10 minutes) and shows a QR code (`linkshell://pair?…`: gateway, the machine's signing key, a one-time secret, the code); the app claims by scan or by code; the host checks the proof and decides. Account: both sides signed in (`linkshell login`, and in the app) — no pairing.
3. **End-to-end channel.** The device opens a tunnel (`hello` / `welcome`, ephemeral X25519 keys signed by the long-term keys); after that every frame is sealed with XChaCha20-Poly1305. The gateway sees only ciphertext. The host accepts a `hello` only from a device in `paired-devices.json` with the same keys, or, when signed in, one the gateway says shares its account.
4. **RPC.** Inside the tunnel: JSON-RPC (`packages/wire/src/rpc.ts`) — `sessions.*`, `terminals.*`, `fs.*`, `ports.list` / `proxy.*`, `screen.*`, `direct.offer`, …; the host pushes `session.event` (per-session `seq`, resumable).
5. **Direct data channel.** For bulk streams (port previews, the viewer's HTTP/WebSocket and compatible screen bytes) the device sends a WebRTC offer over RPC (`direct.offer`). This is a separate connection between the Node host (werift) and client; its `direct` status does not prove that a screen video track is connected. `LINKSHELL_ICE_SERVERS` sets STUN servers; `off` disables this bulk channel and removes STUN from screen media, but the latter can still try LAN candidates. No TURN.
6. **The screen.** `screen.start` returns a loopback viewer port, token and displays. The phone forwards that port; the web client loads the same page in an isolated iframe. The viewer/native receiver's socket carries SDP/ICE via the host to LinkShell.app. On a Mac, ScreenCaptureKit → low-latency VideoToolbox H.264 → libwebrtc sends a **video track directly to the receiver**, with four DataChannels for input and cursor. The host and gateway do not carry that media. The default encoder is `own`, with stock H.264 fallback; FlexFEC is offered but requires receiver negotiation.
7. **iOS reception and fallback.** `apps/client/modules/link-screen` defaults to native WebRTC decode → latest decoded-frame mailbox → Metal presentation, requesting up to 120 fps subject to source/receiver displays, power, thermal state and adaptation. The transparent WebView retains controls, gestures and cursor; WebKit sends input directly to Swift, bypassing RN JS, and frames never enter JS. Failure tries standard WebView WebRTC, then forces that screen's bytes onto RPC (`direct:false`); retry starts native again. Android/Web retain the standard viewer and its byte-stream fallback. On Mac the fallback is also captured/encoded by LinkShell.app, paced by `screen-pacer.ts` and decoded with WebCodecs/Canvas. Linux uses ffmpeg/X11 for this path and has no control. Intel Mac/Windows screen capture is unsupported. A new iOS binary is required for native module changes; stable 120 fps, stable 4K/60 and real-device weak-network gains remain unproven. See `docs/v2/screen-realtime.md` for the current route and known periodic stutter.

### Gateway (`packages/gateway`)

- WebSocket `/v2/connect`, `GET /healthz` → `{ ok, version, relay, memoryMb }` (`relay`: connected peers), and the bundled current-protocol web client at `/`. `/config.js` selects account or pairing-only mode from gateway settings; unknown paths remain 404.
- Data: one SQLite file (peers' public keys and account, machine↔device links). `RELAY_DATA_PATH`, default `./data/relay.db`; the Docker image uses `/data/relay.db`; `linkshell gateway` uses `~/.linkshell/relay.db`. Losing it unpairs every phone.
- Env: `PORT` (8787), `LOG_LEVEL`, `RELAY_DATA_PATH`, `TRUSTED_PROXIES` (IPs or IPv4 ranges whose `X-Forwarded-For` is believed), `WS_CONNECT_RATE_LIMIT_MAX` / `WS_CONNECT_RATE_LIMIT_WINDOW_MS` (20 connects a minute per IP, loopback exempt), `SUPABASE_URL` + `SUPABASE_ANON_KEY` (account tokens are verified), `AUTH_REQUIRED` + `SUPABASE_SERVICE_ROLE_KEY` (a computer needs an active Pro account).
- Official vs self-hosted: the same code. A self-hosted gateway has no Supabase variables: pairing only. The official one (`gateway.itool.tech`, `luma-gateway.yml`) adds account verification and, through `admit`, the Pro check for computers — at connect only; a failed lookup admits.

### CLI commands

`setup` (host, screen permissions, phone — once), `host [--daemon] [--gateway <url|off|default>] [--dev-port <port>]` with `host status` / `host stop`, `pair`, `devices` / `devices remove <device>`, `claude` / `codex` (the agent's own UI attached to the host; arguments pass through), `screen [--check]`, `doctor [--gateway <url>]`, `login`, `logout`, `upgrade`, `status`, `stop`, `gateway [--port] [--daemon]` with `gateway status` / `gateway stop`. Bare `linkshell` runs the setup on a computer that has never had it.

## Never rename

Every paired phone and every installed host depends on these. Changing one silently breaks or unpairs users.

- `RELAY_PATH = "/v2/connect"` (`packages/wire/src/relay.ts`).
- The challenge string `linkshell-gateway-v2:${nonce}` (`packages/wire/src/crypto.ts`). The "v2" in both is part of the protocol, not a version to tidy up.
- The relay's SQLite schema (`packages/gateway/src/store.ts`: tables `peers`, `links`) and production's data file `/data/relay.db` on the volume in `luma-gateway.yml`.
- LinkShell.app's bundle id `com.bd.linkshell.host` and its Developer ID signing identity: macOS keeps the Screen Recording and Accessibility grants against the pair.

## Release

Checklist: [docs/release-sop.md](docs/release-sop.md).

When the user asks to release LinkShell, execute the full release workflow, including publication and deployment. The user explicitly exempts LinkShell from the preparation-only rule used for other projects. Use the preparation-only lane only when the user explicitly requests it.

- npm, always `pnpm publish` (it rewrites `workspace:*`), in dependency order: wire → mac → host → gateway → cli; skip what didn't change.
- `@linkshell/mac` must be published from a Mac with the Developer ID Application certificate (`prepack` refuses to build unsigned).
- Tag `gateway-vX.Y.Z` → CI builds and pushes `nickname4th/linkshell-gateway` (`.github/workflows/docker-publish.yml`). That only builds: the official gateway is deployed by bumping the image in `luma-gateway.yml`.
- Tag `cli-vX.Y.Z` marks a CLI release (no CI). `./scripts/update-brew.sh` updates the Homebrew tap.
- Tag `vX.Y.Z` → the app, on self-hosted macOS runners: iOS to TestFlight, Android AAB + APK to a GitHub release (`./scripts/release-mobile.sh`). Locally: `pnpm prod:ios` / `pnpm prod:android`.
- `docs/site/` deploys to GitHub Pages on push to main (`.github/workflows/pages.yml`).

Install channels: `npm i -g linkshell-cli`, `brew install LiuTianjie/linkshell/linkshell`, `curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh`.

## Auth & Backend

- Supabase project `mkbeusztkzffnzjdwmqk`, shared with iTool. Sign-in happens at `https://itool.tech/en/auth/linkshell`; the CLI keeps the tokens in `~/.linkshell/auth.json`, the app in the Keychain.
- Subscription: iTool's `profiles` table, `plan = 'pro'` and `plan_expires_at` in the future. `linkshell login` reads it with the user's token (to say Pro or Free); the official gateway reads it with the service-role key, and its answer is the one that counts.
- The gateway verifies an account token against `${SUPABASE_URL}/auth/v1/user`.
- The `linkshell_*` tables in that project are left from 1.x. No code reads them; don't drop them.

## Conventions

- Commit style: `feat:`, `fix:`, `docs:`, `release:`
- Chinese UI text in the app and in the screen's viewer page (`packages/host/src/screen-viewer.ts`); errors the phone shows are Chinese too
- English in README.md, Chinese in README_CN.md; keep the two saying the same
- Comments say why, not what
