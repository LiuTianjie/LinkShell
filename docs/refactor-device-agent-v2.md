# LinkShell Device-Agent Refactor Plan

## Current Status

Updated: 2026-05-16

### Completed

- Protocol v2 envelope now routes by `hostDeviceId`; old `session.connect` / `session.ack` / `session.resume` / `session.heartbeat` / `session.error` message types are removed from the registry.
- Gateway websocket, pairing, device authorization, tunnel proxy, permission HTTP forwarding, and tests are host-device based.
- Supabase gateway state migrated to v2 tables:
  - `linkshell_gateway_device_authorizations`
  - `linkshell_gateway_pairing_challenges`
- CLI startup is shell-first and device-based. The old terminal Agent v1 proxy was deleted; only Agent Workspace v2 remains.
- Mobile storage has best-effort migration to `hostDeviceId` keys for history, projects, and Agent conversations.
- Agent conversation UI includes the port preview modal routed through `/tunnel/{hostDeviceId}/{port}`, with common-port quick chips plus manual port entry.
- Agent Workspace home now visually groups projects under host devices, then provider, then conversations.
- Agent Workspace now auto-requests provider conversation lists from online devices; CLI Claude adapters scan all local `~/.claude/projects` history and Codex sessions are grouped by provider through the existing provider list sync.
- Published releases:
  - `@linkshell/protocol@0.3.2`
  - `@linkshell/protocol@0.3.3`
  - `@linkshell/gateway@0.3.2`
  - `linkshell-cli@0.3.6`
  - `linkshell-cli@0.3.7`
  - `linkshell-cli@0.3.8`
  - `linkshell-cli@0.3.9`
  - `linkshell-cli@0.3.10`
  - `linkshell-cli@0.3.11`
- Device-side Codex and Claude JSONL message history is now lazily synced into Agent conversation snapshots when opening a conversation.
- Active Codex session titles now fall back to the first visible device-side user message when Codex has not written an index title yet.
- Device-side Codex archived sessions are now detected from `~/.codex/archived_sessions`, synced to the mobile archived section, and covered by CLI tests.
- Codex device history now restores first-class command execution and file-change timeline items, including per-file add/remove counts from patch history.
- Claude device history now restores `tool_use` / `tool_result` blocks as first-class command execution and file-change timeline items for Bash/Edit/MultiEdit/Write/NotebookEdit.
- Mobile Agent conversation UI now renders structured file changes with a desktop-style edited-files card using device-synced entries instead of text-only fallback parsing.
- Agent message composer controls are first-class: model is menu-only, reasoning effort and permission mode are advertised by provider capabilities, Plan mode toggles reliably, image prompts flow through Codex and Claude providers, and default selections are explicitly cleared on the host.
- LinkShell-native Agent commands are now advertised for Codex and Claude, including Plan/exit-plan, review, subagents, status, Git status/diff/commit/pull/push/stash/stash-pop, plus Codex compact.
- Mobile Agent detail now has Remodex-style quick actions for review, Git status/diff/commit/push, file reference insertion, and port preview near the composer.
- Agent tool-call cards now use provider/tool-aware summaries for file patches, shell commands, search/read/web/MCP calls instead of falling back to raw JSON-first cards.

### In Progress

- Mobile UI terminology still exposes `sessionId` in several internal prop/function names. Runtime data is host-device based, but the public screen/hook naming should be cleaned up as follow-up work.
- Port preview is inside Agent conversation UI; the next pass is mostly visual refinement and full-screen ergonomics.
- Provider history sync is now automatic; Claude local JSONL and Codex archived/local history fixture coverage exists, including message, command, and file-change history. Codex app-server `thread/list` fixture coverage still remains.
- Git quick actions are implemented through local native commands; richer staged-file selection and push/pull conflict recovery UI remain follow-up work.

### Remaining Plan

1. Rename mobile screen/hook APIs from `sessionId` to `hostDeviceId` where they cross component boundaries, keeping storage migration compatibility only at the edge.
2. Polish Agent port preview full-screen ergonomics and empty/loading states.
3. Move any remaining terminal-oriented Agent affordances out of Terminal screens and verify there is no old v1 `agent.*` network path.
4. Add Codex app-server `thread/list` fixtures, staged Git UI, and mobile-focused tests where practical; keep `pnpm typecheck`, gateway tests, CLI tests, and full build green.

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
  - show model selection as a menu sourced from CLI/runtime capabilities, falling back only to verified Claude aliases or a default item;
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
