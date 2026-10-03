# linkshell-cli

Follow, steer and approve the coding agents running on your computer — from your phone. This is the computer side of [LinkShell](https://github.com/LiuTianjie/LinkShell): it runs Claude Code, Codex and other agents you already have installed, and keeps them reachable from the LinkShell app ([iPhone](https://apps.apple.com/cn/app/linkshell/id6761547516) · [Android](https://github.com/LiuTianjie/LinkShell/releases/latest)) over an end-to-end encrypted channel.

[Website](https://liutianjie.github.io/LinkShell/) · [Docs](https://liutianjie.github.io/LinkShell/docs/) · [简体中文](https://github.com/LiuTianjie/LinkShell/blob/main/README_CN.md)

## Install

macOS or Linux, **Node.js 22.13 or newer**.

```bash
npm i -g linkshell-cli
linkshell setup
```

`linkshell setup` does everything once, in order: it starts the host in the background, gets the screen ready (on a Mac, the two permission switches), and connects your phone. Each part also has its own command.

Connect your phone one of two ways:

- **Pro — the official gateway.** `linkshell login`, then sign in to the app with the same account. The computer shows up by itself.
- **Your own gateway.** Run one (below), then:

  ```bash
  linkshell host --gateway wss://gw.example.com --daemon
  linkshell pair    # scan the QR code in the app
  ```

Start sessions from the phone, or launch agents from your terminal so they can be handed over at any time:

```bash
linkshell claude    # Claude Code; a message from the phone takes over, any key here takes it back
linkshell codex     # Codex; the terminal and the phone are live at the same time
```

Claude Workflow progress, phases and Agent details require CLI 0.10.6 or newer and app 2.3.5 or newer. After upgrading the CLI, restart the host with `linkshell host stop` and `linkshell host --daemon`.

## Commands

| | |
| --- | --- |
| `linkshell setup` | Set this computer up, once: the host, the screen's permissions, your phone |
| `linkshell host --daemon` | Start LinkShell in the background |
| `linkshell status` | The host, its agents, sessions and gateway connection |
| `linkshell host stop` | Stop the host (`linkshell stop` stops everything LinkShell runs here) |
| `linkshell host --gateway <url>` | Choose the gateway (`off` to disconnect, `default` for the official one); applies to a running host |
| `linkshell pair` | Pair a phone through your own gateway |
| `linkshell devices` | Paired phones; `linkshell devices remove <name>` unpairs one |
| `linkshell login` / `logout` | Pro account: join or leave the official gateway, without restarting the host |
| `linkshell claude` / `linkshell codex` | The agent's own UI, shareable with the phone (arguments pass through) |
| `linkshell gateway [--port 8787] [--daemon]` | Run a gateway (`gateway status`, `gateway stop`) |
| `linkshell screen` | Set up watching and controlling the screen (`--check` only reports) |
| `linkshell doctor` | Check Node, agents, the host and its gateway |
| `linkshell upgrade` | Upgrade the CLI (restart the host afterwards to run the new version) |

## Run your own gateway

A gateway only relays encrypted frames and brokers pairing. Yours is the same program as the official one, without the accounts: you pair each phone once, with a QR code or a six-digit code.

```bash
linkshell gateway --port 8787 --daemon
```

or with Docker: `nickname4th/linkshell-gateway` (see the [self-hosting guide](https://github.com/LiuTianjie/LinkShell/blob/main/docs/deploy.md)). Put it behind HTTPS and point hosts at `wss://your-domain`. All it keeps is one SQLite file, `~/.linkshell/relay.db`: keep it and phones stay paired.

## Files

```
~/.linkshell/
├── state.db              sessions and their history
├── identity.json         this computer's keys
├── paired-devices.json   phones paired with it
├── auth.json             the Pro login, if any
├── config.json           the chosen gateway
├── host.log              the host's log
├── worktrees/            git worktrees made for sessions started (or forked) into one
├── LinkShell.app         the Mac side of the screen, unpacked on first use (macOS)
└── relay.db              pairings, when this computer runs a gateway
```

`LINKSHELL_HOME` moves this directory. LinkShell never handles your agents' accounts or API keys: agents run as you, with your login shell's environment.

## Coming from 1.x

2.0 changed both the app and the computer side: upgrade both and connect again. From 0.10 the 1.x commands (`linkshell start`, `linkshell list`) are gone, and `linkshell gateway` no longer serves the 1.x app. `linkshell stop` still ends a 1.x bridge left running from before the upgrade.

## License

MIT
