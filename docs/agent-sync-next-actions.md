# Agent Sync Next Action Plan

Updated: 2026-05-16

## Decision

LinkShell Agent Workspace should use a **device-authoritative sync model**:

- CLI / host device is the source of truth for Codex and Claude conversations, titles, archived state, running state, and message history.
- Gateway remains a thin relay with small reconnect replay buffers. It should not parse Agent messages or persist full Agent history.
- Mobile keeps a local cache for speed, but always treats device snapshots, deltas, and history pages as authoritative.

This matches the Remodex-style shape: relay for transport, host bridge for runtime and canonical history, mobile for cached UI and reconciliation.

## Current Project Read

- Protocol already has `agent.v2.conversation.list`, `agent.v2.conversation.opened`, `agent.v2.snapshot.request`, `agent.v2.snapshot`, and `agent.v2.event`.
- CLI already scans device-side Codex and Claude JSONL history, detects archived Codex sessions, restores command/file-change timeline items, and emits live `agent.v2.event` updates.
- Mobile already caches conversations/timelines in AsyncStorage and merges `conversation.opened`, `snapshot`, and `event`.
- Gateway is mostly thin for Agent traffic, which is good. Terminal scrollback has `seq/ack/resume`, but Agent history currently does not have an equivalent cursor/delta contract.
- Main risk: mobile can display cached state that is not known to be complete or canonical. There is no explicit Agent history pagination, revision token, gap detection, or running-thread watch contract yet.

## P0: Make Agent History Device-Authoritative

1. Extend protocol with history paging and revision metadata:
   - `agent.v2.history.request`
   - `agent.v2.history.page`
   - `agent.v2.delta.request`
   - optional `agent.v2.running_state`
   - add `revision`, `cursor`, `hasMore`, `source`, and `canonical` fields where needed.

2. Add per-conversation revision tracking on the CLI:
   - every timeline mutation increments a monotonic revision;
   - `agent.v2.event` carries revision;
   - conversation list carries `timelineRevision`, `historyComplete`, and `runningTurnId` when known.

3. Implement CLI history page serving:
   - Codex: page from local JSONL / archived sessions first, then app-server `thread/turns/list` when available;
   - Claude: page from `~/.claude/projects` JSONL;
   - return normalized `AgentTimelineItem[]` with stable item IDs and turn IDs.

4. Add mobile reconciliation rules:
   - open cached timeline immediately;
   - request latest device snapshot/page after opening;
   - if event revision jumps or a reconnect happens, request delta/page instead of trusting local cache;
   - mark conversations as `syncing`, `complete`, `stale`, or `deferred` internally.

5. Keep gateway thin:
   - no full Agent timeline persistence;
   - only relay frames and retain bounded recent events for reconnect;
   - expose health metrics for buffered Agent frames, dropped clients, and host absence.

## P1: Running State And Realtime Correctness

1. Add host-side running-thread watch:
   - track active prompt/command lifecycle per conversation;
   - emit `running`, `waiting_permission`, `idle`, `error` transitions explicitly;
   - do not let mobile infer completion from WebSocket silence.

2. Add foreground sync cadence on mobile:
   - active conversation: refresh status/history every 1-3 seconds while running;
   - inactive running conversations: refresh every 10-15 seconds;
   - idle background: slow polling only.

3. Make cancel/permission/input state authoritative:
   - permission request delivery and resolution should update the same conversation revision;
   - cancel should produce a terminal outcome event, not only a status change.

## P2: Codex And Claude Parity

1. Codex:
   - add app-server `thread/list` and `thread/turns/list` fixtures;
   - prefer app-server metadata for title/archive/running when available;
   - keep JSONL fallback for archived/offline history.

2. Claude:
   - improve title extraction from first visible user prompt and project metadata;
   - normalize Bash/Edit/MultiEdit/Write/NotebookEdit into the same command/file-change timeline model;
   - verify model, permission, image, and plan-mode behavior against current Claude CLI / SDK capabilities.

3. Shared:
   - centralize stable timeline identity: `conversationId + turnId + itemId`;
   - make duplicate live/history merge deterministic.

## P3: Mobile UX Finish

1. Conversation detail:
   - keep Remodex-style lightweight timeline rows;
   - add visible stale/syncing indicator only when useful;
   - add older-history loading at top of timeline.

2. Sidebar/home:
   - distinguish device-offline, stale-cache, and actively-running conversations;
   - archived conversations should be device-authoritative when online and local-only when offline.

3. Composer:
   - continue simplifying bottom controls;
   - verify image send, model menu, thinking effort, plan mode, and permission mode on both Codex and Claude.

## P4: Gateway Stability

1. Reduce memory pressure:
   - audit host/client maps and tunnel request cleanup;
   - add bounded Agent relay buffer if needed;
   - log payload sizes for oversized Agent snapshots.

2. Improve 503 / container-termination diagnosis:
   - add event-loop delay and heap metrics to `/health` when detailed health is enabled;
   - close or reject oversized WebSocket frames before they pressure the heap;
   - add regression tests for host reconnect and client reconnect under Agent traffic.

## Verification Plan

- Protocol: schema tests for new history/delta messages.
- CLI: Codex JSONL, Codex archived, Codex app-server fixtures, Claude JSONL fixtures, revision monotonicity, history paging.
- Mobile: reducer tests for snapshot + event + delta merge, stale cache recovery, archived restore, running state updates.
- Gateway: relay-only Agent traffic tests, host absence, reconnect, oversized payload rejection.
- Full checks before release:
  - `pnpm --filter @linkshell/protocol build`
  - `pnpm --filter linkshell-cli test`
  - `pnpm --filter @linkshell/gateway test`
  - `pnpm --filter @linkshell/app typecheck`
  - `pnpm build`

## Suggested Execution Order

1. Protocol history/delta schemas and TypeScript types.
2. CLI revision tracker and history page service.
3. Mobile cache reconciliation and top-of-history pagination.
4. Running-state watch and explicit lifecycle events.
5. Codex app-server fixtures and Claude parity fixtures.
6. Gateway health/memory hardening.
7. UI polish pass after sync semantics are trustworthy.

