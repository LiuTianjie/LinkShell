# @linkshell/host

The LinkShell v2 host daemon. It runs on your computer and owns what your devices control:
agent sessions (Codex, Claude Code, Gemini, Copilot, Grok and other ACP agents), terminals,
file and port previews. Devices reach it over the LAN or through a relay, end-to-end encrypted.

Run it through the CLI: `npm install -g linkshell-cli`, then `linkshell host --daemon`.

Claude Workflow progress and background sub-agent transcripts stay synchronized even while the main conversation is idle. The app can open each run, phase and Agent independently.

Requires Node.js 22.13 or newer.

MIT License
