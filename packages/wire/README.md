# @linkshell/wire

The LinkShell v2 wire protocol, shared by the host, the relay and the apps:

- the session model and ACP-shaped session updates, including Claude Workflow phases and Agent progress,
- JSON-RPC methods and notifications between devices and a computer,
- end-to-end encryption (Ed25519 identities, X25519 channel keys, XChaCha20-Poly1305),
- the relay frames and a relay client for Node and React Native.

Most people want the CLI instead: `npm install -g linkshell-cli`.

MIT License
