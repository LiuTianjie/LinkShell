# @linkshell/wire

The LinkShell v2 wire protocol, shared by the host, the relay and the apps:

- the session model and ACP-shaped session updates, including Claude Workflow phases and Agent progress,
- JSON-RPC methods and notifications between devices and a computer,
- end-to-end encryption (Ed25519 identities, X25519 channel keys, XChaCha20-Poly1305),
- the relay frames and a relay client for Node and React Native,
- the direct bulk-stream framing used by `proxy.*` when a WebRTC DataChannel is available.

The bulk channel is separate from the Mac screen's native WebRTC video connection. Screen
SDP/ICE is forwarded by the host viewer service; media and its four input/cursor channels use
libwebrtc between LinkShell.app and the receiver. See the
[screen architecture](../../docs/v2/screen-realtime.md) for both paths and RPC fallback.

Most people want the CLI instead: `npm install -g linkshell-cli`.

MIT License
