# LinkShell Device-Agent Refactor Plan

## Summary

- First execution step: write this plan to `docs/refactor-device-agent-v2.md`, then implement by phases.
- Make a breaking Protocol v2: user-facing identity becomes **host device**, not session. Pairing authorizes a client device to a host device permanently until explicit revocation.
- Split product surfaces cleanly:
  - Terminal = remote shell on a paired device, no AI/provider/project concepts.
  - Agent GUI = device-scoped catalog: `Device -> Agent Provider -> Project -> Conversation`.
  - Port preview = part of Agent GUI, using the paired device tunnel.

## Protocol And Gateway

- Replace `sessionId` as the primary route key with `hostDeviceId`; keep `connectionId` only as an internal live websocket connection id.
- Add v2 HTTP APIs:
  - `POST /pairings`: host creates a one-time pairing challenge for its `hostDeviceId`.
  - `POST /pairings/claim`: client claims code and receives `{ hostDeviceId, deviceToken, authorizationId }`.
  - `GET /devices`: list permanently authorized host devices for the client token.
  - `GET /devices/:hostDeviceId`: device status, metadata, online state, capabilities.
  - `DELETE /devices/:hostDeviceId/authorizations/:authorizationId`: revoke authorization.
- Pairing codes may expire before claim; successful authorizations do not expire automatically.
- Replace `SessionManager`/session-token binding with device managers:
  - host devices keyed by machine identity from `machine-id.ts`;
  - client authorizations keyed by token + host device;
  - live host/client sockets keyed by host device;
  - terminal scrollback buffers keyed by `hostDeviceId + terminalId`.
- Update Supabase persistence with v2 tables for host devices, authorizations, and pairing challenges; old session tables are not kept compatible.

## CLI And Terminal

- Remove public terminal provider selection from `linkshell start`; default terminal command is the user’s system shell:
  - `$SHELL` first;
  - `/bin/zsh` on macOS fallback;
  - login shell args only for shells known to support them.
- Remove AI hook injection from terminal startup entirely: no Claude/Codex/Gemini/Copilot hook writes, no terminal `provider`, no terminal permission/status mapping.
- Keep terminal messages as generic PTY operations: spawn, input, resize, output, kill, browse/read file, history.
- Keep `--agent-ui` as a separate device capability; agent providers are auto-detected on the host and exposed through Agent adapters, not terminal provider flags.

## Agent GUI

- Add an `AgentProviderAdapter` layer with a strict rule: UI capabilities must come from official runtime discovery or verified local client state, not hardcoded guesses.
- Codex adapter:
  - use `codex app-server` and generated schema/types where possible;
  - use runtime responses for models, thread list/resume/start, turn lifecycle, permissions, commands, and compaction;
  - map permissions using Codex’s own sandbox/approval concepts, not LinkShell-specific fake modes.
- Claude adapter:
  - read conversations/projects from `~/.claude/projects` and resume via official Claude CLI/session IDs;
  - use Claude CLI-supported flags for model, effort, and permission mode;
  - show a model text/alias control instead of a fake fixed dropdown unless a real list is discoverable;
  - expose only verified commands: official CLI/native commands and `.claude/commands` custom commands.
- Mobile storage moves to v2 keys keyed by `hostDeviceId`; conversations store `hostDeviceId`, `provider`, `projectPath`, `agentSessionId`, and cached timeline.
- Mobile home becomes device-first; Agent screen groups as `Device -> Provider -> Project -> Conversation`.
- Move port preview from terminal screen into Agent conversation UI with common port chips plus manual port entry, routed through `/tunnel/{hostDeviceId}/{port}`.

## Phased Execution

1. Land plan doc and Protocol v2 types.
2. Refactor gateway device pairing, authorization, websocket routing, revocation, and tests.
3. Refactor CLI startup to shell-only terminal and device-based host websocket.
4. Refactor mobile device storage, pairing flow, device list, and terminal screen.
5. Implement agent catalog/adapters and replace session/project grouping with device-provider-project-session.
6. Move port preview into Agent UI and remove old terminal AI surfaces.
7. Run full verification: `pnpm typecheck`, gateway/CLI tests, mobile typecheck, and targeted manual pairing flow.

## Test Plan

- Gateway unit/e2e: pairing claim returns device auth, auth survives host disconnect, revoke blocks websocket/tunnel, unauthorized client rejected, old `sessionId` routes removed.
- CLI tests: default shell resolution, no provider required, no AI hook files written, terminal spawn/list/output works by host device.
- Agent adapter tests: Codex app-server RPC mapping, Claude project/session discovery fixtures, no fabricated model/command options.
- Mobile tests/typecheck: device cache migration, paired device list, terminal connect by device, agent grouping by device/provider/project/session, preview tunnel URL uses host device.
- Manual smoke: pair phone to host, reconnect after CLI restart without re-pairing, revoke and confirm access fails, open terminal shell, open Codex/Claude conversation, preview local dev port.

## Assumptions

- Breaking v2 upgrade is allowed; old app/CLI/gateway interoperability is not required.
- Existing local mobile caches can be migrated best-effort, but old live sessions do not need to keep working.
- Pairing challenge codes remain temporary for security; the post-claim authorization is permanent until revoked.
