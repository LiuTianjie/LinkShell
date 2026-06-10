<p align="center">
  <img src="docs/assets/adaptive-icon.png" alt="LinkShell" width="160" style="border-radius:24px" />
</p>

<h1 align="center">LinkShell</h1>

<p align="center">
  <strong>Remote Terminal and Agent Workspace for Claude Code, Codex, Gemini, and Copilot</strong>
</p>

<p align="center">
  Remotely control local AI terminals, Agent Workspace conversations, desktop sharing, and dev server previews from your phone
</p>

<p align="center">
  <strong>English</strong>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="README_CN.md">中文</a>
</p>

<p align="center">
  <a href="https://liutianjie.github.io/LinkShell/">🌐 Website</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://github.com/LiuTianjie/LinkShell/releases/latest">📦 Releases</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="docs/user-guide.md">📖 Docs</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/LiuTianjie/LinkShell?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-iOS%20%7C%20Android%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" />
</p>

<p align="center">
  <a href="https://www.producthunt.com/products/linkshell?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-linkshell" target="_blank" rel="noopener noreferrer"><img alt="LinkShell - Control your AI terminal sessions from your phone. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1120419&amp;theme=dark&amp;t=1775998159516" /></a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/cc09d3a7-239c-4d5c-a2a7-76f64d4af070" width="280" autoplay loop muted playsinline></video>
  &nbsp;&nbsp;
  <video src="https://github.com/user-attachments/assets/d24a1699-fb8e-4a27-a51d-27a290f7ec73" width="280" autoplay loop muted playsinline></video>
</p>

## 📲 Download

<table>
  <tr>
    <td align="center">
      <a href="https://apps.apple.com/cn/app/linkshell/id6761547516">
        <img src="https://img.shields.io/badge/iOS-App_Store-blue?style=for-the-badge&logo=apple&logoColor=white" alt="Download on App Store" />
      </a>
      <br /><sub>iOS 14+</sub>
    </td>
    <td align="center">
      <a href="https://github.com/LiuTianjie/LinkShell/releases/latest">
        <img src="https://img.shields.io/badge/Android-Download_APK-brightgreen?style=for-the-badge&logo=android&logoColor=white" alt="Download APK" />
      </a>
      <br /><sub>Android 8+</sub>
    </td>
  </tr>
</table>

> Android APK is available from GitHub Releases. iOS version is available on the App Store.

## Get Started

```bash
# npm
npm install -g linkshell-cli

# Homebrew (macOS)
brew install LiuTianjie/linkshell/linkshell

# or curl
curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh
```

```bash
linkshell start --daemon --provider claude
```

The CLI starts a built-in Gateway + terminal bridge in the background, then prints a pairing code and QR code. Scan to connect. Disconnecting the app does not affect the background process. On macOS, the bridge prevents idle system sleep by default so locking the screen does not usually drop the session.

Terminal providers currently include `claude`, `codex`, `gemini`, `copilot`, and `custom`. The Agent Workspace auto-detects ACP-capable Claude Code and Codex installations when `--agent-ui` is enabled.

## Commands

```bash
linkshell start --daemon --provider claude   # Start in background (built-in Gateway + bridge)
linkshell start --daemon --provider claude --no-keep-awake  # macOS: allow idle sleep
linkshell start --provider claude             # Start in foreground
linkshell start --daemon --provider gemini    # Bridge Gemini CLI
linkshell start --daemon --provider copilot   # Bridge GitHub Copilot CLI
linkshell start --daemon --agent-ui           # Enable Agent Workspace (auto-detects Claude/Codex)
linkshell status                              # Check running status
linkshell stop                                # Stop all background processes
tail -f ~/.linkshell/bridge.log               # View logs

linkshell gateway --daemon                    # Start Gateway separately in background (for server deployment)
linkshell gateway status                      # Check Gateway status
linkshell gateway stop                        # Stop Gateway

linkshell setup                               # Interactive configuration
linkshell doctor                              # Environment check
linkshell upgrade                             # Upgrade to latest version
linkshell login                               # Log in (enables premium gateway)
linkshell logout                              # Log out
```

## Architecture

```
Your Computer                                    Your Phone
┌──────────────────────┐   WebSocket   ┌──────────┐
│ CLI + Built-in GW    │ ◄───────────► │ App      │
│ (PTY + Relay)        │               │ (xterm)  │
└──────────────────────┘               └──────────┘
```

By default, the CLI includes a built-in Gateway — one command does it all. You can also deploy the Gateway separately on a public server:

```
Your Computer              Public Server                Your Phone
┌──────────┐  WebSocket   ┌──────────┐   WebSocket   ┌──────────┐
│ CLI      │ ────────────►│ Gateway  │◄──────────── │ App      │
│ (PTY)    │              │ (Relay)  │              │ (xterm)  │
└──────────┘              └──────────┘              └──────────┘
```

## Usage

### Simple Mode (Built-in Gateway, LAN)

```bash
linkshell start --daemon --provider claude
```

With your phone and computer on the same WiFi, the CLI auto-detects the LAN IP and generates a QR code.

### macOS Lock Screen / Sleep

`linkshell start` enables macOS keep-awake by default while the bridge is running. This uses `caffeinate -i -w <bridge-pid>` to prevent idle system sleep without keeping the display on or unlocking the screen.

```bash
linkshell start --daemon --provider claude
```

To favor battery life and allow idle sleep:

```bash
linkshell start --daemon --provider claude --no-keep-awake
# or
LINKSHELL_KEEP_AWAKE=0 linkshell start --daemon --provider claude
```

### Remote Desktop Viewing

```bash
linkshell start --daemon --provider claude --screen
```

With `--screen`, the app can switch to the Desktop tab to view your computer screen. Supports WebRTC (30fps) and screenshot streaming (fallback), automatically selecting the best option.

> **Prerequisite:** [ffmpeg](https://ffmpeg.org/) must be installed.
>
> ```bash
> # macOS
> brew install ffmpeg
>
> # Ubuntu / Debian
> sudo apt install ffmpeg
>
> # Windows (Chocolatey)
> choco install ffmpeg
> ```
>
> Once installed, the CLI auto-detects screen devices and starts H.264 encoding. If [werift](https://github.com/nicktomlin/werift) is also installed (`npm i -g werift`), WebRTC low-latency transport is preferred; otherwise it falls back to screenshot streaming.

### Agent Workspace

LinkShell exposes an Agent tab alongside Terminal, Desktop, and Browser. It auto-detects installed agent providers (Claude Code, Codex CLI), starts available providers, and reports provider capabilities to the app.

```bash
# Auto-detects Claude Code and/or Codex CLI — both available to the mobile app
linkshell start --daemon --agent-ui

# Explicit provider override (if needed)
linkshell start --daemon --agent-ui --agent-provider codex
```

The current Agent Workspace v2 supports provider selection, dynamic model lists from CLI capabilities, reasoning effort and permission mode controls, image/text input blocks, structured input prompts, permission approval, plan/timeline events, command/file-change cards, subagent activity, reconnect snapshots, and local conversation history. Claude Code is supported through the Claude Agent SDK when available, with stream-json fallback; Codex uses `codex app-server --listen stdio://`.

If no local agent provider is available, the app shows an unavailable Agent state and the terminal session continues normally.

### Port Forwarding (Preview Dev Server)

After starting a dev server in the remote terminal, you can preview pages directly on your phone:

1. Start a service in the terminal, e.g. `npm run dev` (listening on port 3000)
2. Switch to the Browser tab (globe icon) in the app
3. Enter the port number and tap Go

Supports:
- Full loading of static assets, CSS, JS, images, etc.
- HMR / WebSocket hot reload (Vite, Next.js, etc.)
- PC / mobile view switching
- Fullscreen preview mode

> Requires `linkshell-cli >= 0.2.53`, `@linkshell/gateway >= 0.2.17`

### Remote Mode (Standalone Gateway, Cross-Network)

On the server:

```bash
npm install -g linkshell-cli
linkshell gateway --daemon --port 8787
```

On your computer:

```bash
linkshell start --daemon --gateway wss://your-server.com:8787/ws --provider claude
```

You can also deploy the Gateway with Docker:

```bash
# From Docker Hub (recommended)
docker pull nickname4th/linkshell-gateway:latest
docker run -d -p 8787:8787 --name linkshell-gateway nickname4th/linkshell-gateway:latest

# Apple Silicon / arm64 hosts: current Docker Hub images are linux/amd64.
docker pull --platform linux/amd64 nickname4th/linkshell-gateway:latest

# Or build from source
git clone https://github.com/LiuTianjie/LinkShell
cd LinkShell
docker compose up -d
```

See [docs/deploy.md](docs/deploy.md) for detailed deployment instructions.

### Manage Background Processes

```bash
linkshell status    # Check Bridge and Gateway status
linkshell stop      # Stop all background processes
```

### Connect from Phone

In the app:
- Scan the QR code printed by the CLI (recommended)
- Or manually enter the Gateway address + 6-digit pairing code
- Or select from the session list

Reconnecting after disconnection does not affect background processes — just scan or enter the pairing code to resume.

### Web Console (Browser)

Besides the phone app, **every gateway serves a web console same-origin at its own address** — the same Agent + terminal interface as mobile. The CLI ships this web bundle (the built-in gateway has it too), so there's nothing extra to deploy.

Just open the gateway URL in a browser:

- **LAN**: open the LAN address printed by `linkshell start`, e.g. `http://192.168.1.10:8787`
- **Self-hosted gateway**: open your deployed domain, e.g. `https://gateway.example.com`
- **Official gateway (Pro)**: open the official gateway URL

The page connects to whichever gateway served it ("web follows the gateway"). You'll see that gateway's session list; click any session to open the Agent console or terminal.

Login is **optional**, not a gate:

- LAN / self-hosted: no login needed — device trust (TOFU on first connect) is enough
- Pro: sign in (top-right) to see every session owned by your account across official gateways (`/sessions/mine`) without scanning a code

## Local Development

```bash
pnpm install
pnpm dev:gateway    # Start gateway (localhost:8787)
pnpm dev:web        # Web debug client (localhost:5173)
pnpm dev:app        # Expo App

# CLI local development
pnpm --filter linkshell-cli dev start --provider custom --command bash
```

## Handoff Docs

1. [docs/ai-handoff.md](docs/ai-handoff.md) — Repository-level handoff guide
2. [apps/mobile/README.md](apps/mobile/README.md) — Mobile information architecture

## Project Structure

```
├── packages/
│   ├── shared-protocol/       # Shared protocol (Zod schema, message types, version negotiation)
│   ├── cli/                   # CLI (PTY, providers, Agent Workspace, built-in Gateway, daemon)
│   └── gateway/               # Cloud gateway (pairing, sessions, routing, control, auth, rate limiting)
│       └── Dockerfile
├── apps/
│   ├── mobile/                # Expo App (xterm.js WebView, Agent Workspace, desktop/browser tabs)
│   ├── web-dashboard/         # Browser console (Vite + React + Tailwind): Agent + terminal, session list, login, subscription — served same-origin by every gateway
│   └── web-debug/             # Web debug client (Vite + xterm.js + debug panel)
├── docs/
│   ├── site/                  # Landing page + install script
│   ├── brew/                  # Homebrew formula
│   ├── ai-handoff.md          # Handoff guide
│   ├── deploy.md              # Gateway deployment docs
│   └── user-guide.md          # End-user documentation
├── docker-compose.yml
├── .env.example
└── PRD.md
```

## Gateway API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check |
| `POST` | `/pairings` | Create pairing (6-digit code, valid for 10 minutes) |
| `POST` | `/pairings/claim` | Exchange code for sessionId |
| `GET` | `/pairings/:code/status` | Query pairing status |
| `GET` | `/sessions` | List active sessions |
| `GET` | `/sessions/:id` | Session details |
| `WS` | `/ws?sessionId=&role=` | Real-time connection |
| `GET/POST` | `/tunnel/:sessionId/:port/**` | HTTP port forwarding |
| `WS` | `/tunnel/:sessionId/:port/**` | WebSocket port forwarding (HMR) |

## Reliability

- ACK confirmation + dual-layer buffering (CLI 1000 messages + Gateway 200 messages)
- Exponential backoff auto-reconnect (both CLI and App)
- Heartbeat detection (15s/20s)
- Session persistence (host disconnect retained for 60s, idle cleanup after 30min)
- Single-device control management
- Protocol version negotiation
- Agent Workspace v2 snapshots for reconnect and resume
- CORS + rate limiting + graceful shutdown
- Daemon mode (both CLI and Gateway support background running)

## Sponsors

- [AI18N](https://ai18n.chat/) — Unified AI API Gateway with OpenAI / Anthropic compatible API for Claude models

## Buy Me a Coffee

If LinkShell has been helpful to you, consider buying the author a coffee:

<p>
  <img src="docs/assets/pay_wechat.jpg" alt="WeChat Pay" width="180" />
  <img src="docs/assets/pay_ali.jpg" alt="Alipay" width="180" />
</p>

## License

MIT
