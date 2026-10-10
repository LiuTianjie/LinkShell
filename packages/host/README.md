# @linkshell/host

The LinkShell v2 host daemon. It runs on your computer and owns what your devices control:
agent sessions (Codex, Claude Code, Gemini, Copilot, Grok and other ACP agents), terminals,
files, port previews and the remote screen. Devices reach it over the LAN or through a relay, end-to-end encrypted.

Run it through the CLI: `npm install -g linkshell-cli`, then `linkshell host --daemon`.

Claude Workflow progress and background sub-agent transcripts stay synchronized even while the main conversation is idle. The app can open each run, phase and Agent independently.

## Agent questions

Codex Desktop asynchronous questions retain their pending state and accept immediate replies.
Claude and standard ACP forms, Cursor choice questions, and Grok questions/MCP forms share
the phone's question card while preserving each agent's native response format.
See [question support and validation boundaries](../../docs/v2/agent-questions.md).

## Remote screen

`screen.start` returns a token-protected loopback viewer port and display list. The phone
forwards the port; the web client hosts the same page in an isolated iframe. On Apple silicon
Macs, LinkShell.app captures and encodes with ScreenCaptureKit/VideoToolbox. The host passes
SDP/ICE over its Unix socket; the media track and four input/cursor channels run directly
between LinkShell.app and the native iOS receiver or web player.

This media connection is separate from the host's werift bulk DataChannel (`direct.offer`),
which can carry forwarded HTTP/WebSocket traffic. If video fails, the Mac supplies encoded
H.264 frames over another Unix socket and `screen-pacer.ts` applies ACK-based dropping and
quality steps; WebCodecs renders the byte stream. iOS tries native → standard WebView → RPC,
bypassing the bulk direct channel for the last step. Linux uses ffmpeg/X11 and is view-only.

`LINKSHELL_ICE_SERVERS=off` disables the bulk channel and removes STUN from screen signalling;
video can still try LAN candidates. `LINKSHELL_SCREEN_VIDEO=off` disables media-track offers.
No TURN is deployed. See the [current architecture](../../docs/v2/screen-realtime.md) for
source/display limits, transport-specific defaults and validation boundaries.

Requires Node.js 22.13 or newer.

MIT License
