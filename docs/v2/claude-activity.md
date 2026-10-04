# Claude background activity and appearance regression checks

Issue: <https://github.com/LiuTianjie/LinkShell/issues/8>.

## Source contracts

- [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows): a Workflow invocation launches background work; the launching tool returning is not the run completing. The workflow view contains agents, progress and their individual transcripts.
- [Claude Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents) and the installed `@anthropic-ai/claude-agent-sdk@0.3.284` declarations: `WorkflowOutput` supplies `taskId`, `runId`, `workflowName`, `transcriptDir` and `async_launched` / `remote_launched`; `task_progress` provides usage, and `task_notification` supplies terminal state.
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), installed version 0.84.0, `dist/subagent-history.js`: ordinary child files live beside the main transcript at `<session>/subagents/agent-<id>.jsonl`; the adjacent `.meta.json` links `toolUseId` to the spawning call.
- [ultracode-workflows](https://github.com/hesreallyhim/ultracode-workflows), `plugins/ultracode-workflows/scripts/workflow-statusline.mjs` and `cassettes/discovery-run/`: workflow agents append `started` / `result` entries to `subagents/workflows/<runId>/journal.jsonl`; the final `workflows/<runId>.json` supplies status, phases, labels and usage. This is an implementation detail, not a promised SDK API. Keep this compatibility reader in `packages/host/src/drivers/claude/activity.ts`.
- [Happier's workflow implementation](https://github.com/happier-dev/happier/tree/45bd83c934f7a00bc3b02f29879d7a91d99445e4/apps/ui/sources/components/tools/renderers/workflow) informed the mobile hierarchy: transcript summary, persistent activity entry, phase groups and reusable agent transcripts. Its Claude correlation reader documents the undeclared live `task_progress.workflow_progress` phase/agent rows, including provisional indices before concrete agent ids arrive. LinkShell normalizes these into its own additive wire fields; it does not execute or infer structure from workflow scripts.

Live counts mean **completed / observed started**, not an estimated total: a script may launch more agents later. Pending agents are not counted as started. Live progress and final artifacts share one phase/agent parser; records without reported phases stay ungrouped. A provisional row joins its concrete agent by reported identity, and becomes openable only after its transcript is actually read. Missing artifacts do not mean completion. Remote/cloud workflows can expose their lifecycle through the local task notification, but their worker transcripts are not available locally. Unknown journal records and incomplete writes are ignored; a subsequent poll retries complete records. Artifact paths are restricted to the current session, including symlink resolution. Workflow scripts are never evaluated.

Stopping a run does not prove that all its processes have exited. Keep unfinished workers live until their own outcome arrives, and retain the persistent entry while any is still running. Cancellation is not failure. A null journal result is not successful completion; without a more precise native state it is shown as an unconfirmed outcome. A transcript-tail API error may be replaced by a later successful retry.

## Mobile presentation and persistence

The main conversation shows a compact Workflow summary; the input area keeps a live entry even when the main turn is idle. `/session/[id]/workflow/[call]` shows the complete run grouped by phase, with completed phases initially folded. Agents open `/session/[id]/workflow-agent/[call]`, a full-screen host of the existing subagent timeline. Both places use the same reported agent state and metrics.

Paged history can begin with a worker's output before its spawning call is loaded. The timeline reducer then creates a top-level `Sub-agent` placeholder. The main conversation removes these duplicate cards only when the worker's exact `toolCallId` appears in a Workflow roster, or its explicit parent chain reaches a Workflow. Parent relationships come from nested event history and `sessions.subagents.parentToolCallId`; names, task text, timestamps and id prefixes are never membership evidence. Unassociated agents remain visible, and the original event log and child timelines remain intact. Completed runs remain accessible from the session's Agent and Workflow list even when their launch is on an unloaded page.

Consecutive finished Agent and Workflow steps can use the timeline's existing three-step fold, without grouping across a main-agent message or a pagination seam. This is a display fold, not Workflow membership. An ordinary agent needs an explicit terminal outcome to fold: a completed launch or `running: false` alone is insufficient. A stopped Workflow with running or paused workers stays visible.

Run snapshots live in the existing event log's `detail.workflow`. `sessions.subagents` also returns the latest snapshot and its event sequence, so the client can restore an old run without loading all its chat turns. The client's workflow roster is independent of the paged timeline; a slow list response or an older event cannot overwrite a newer snapshot. Multiple runs retain separate identities. No new gateway protocol, database table or dependency is needed. This UI monitors native state; it does not add unverified pause/resume/stop controls.

On host restart, the driver reconciles the current run and worker metadata after the deduplicated history import. A previously logged terminal tool must not hide later phase labels, outcomes or final artifacts. Conversation text still follows the existing item deduplication rules.

The main and child cursors are independent. Ordinary child cursors advance silently while ACP streams them, preventing duplication on handoff. Workflow artifacts remain observed in either driving mode. Host history APIs and client routing preserve multiple nesting levels, including an independently opened worker.

## Android appearance

The screenshot in issue #8 is Android. Android's Fabric `PlatformColorParser.h` resolves resource colors to integers and caches them by surface and resource path. The prior Android navigation remount reused the same resource identities; that alone did not remove dependence on the native resolution/cache lifecycle. `colors.ts` now reads the explicit light/dark values from the existing brand palette on access. The existing `useColorScheme()`-keyed Android tree gets literal colors, including memoized rows and native text. Sheet styles, navigation options and button fills are built when rendered so they do not retain the import-time color.

iOS keeps its native semantic colors and [DynamicColorIOS](https://reactnative.dev/docs/dynamiccolorios). An iOS 26.5 simulator check of the unpatched app did not reproduce the reported appearance issue. No React Native patch, native dependency, or source-build override is required for this fix. The existing Android remount behavior is retained; this change does not add draft persistence.

## Validation

- `pnpm --filter @linkshell/host test test/claude-activity.test.ts test/claude-agents.test.ts test/claude-handoff.e2e.test.ts test/history.test.ts`
- `pnpm --filter @linkshell/client-core test`
- `pnpm build`, `pnpm typecheck`, `pnpm --filter @linkshell/client lint`
- `pnpm --filter @linkshell/client test test/colors.test.ts`: checks every palette color across light → dark → light without re-importing the module; checks background appearance changes and preservation of iOS native colors.
- `pnpm --filter @linkshell/client test test/workflow-timeline.test.ts`: reproduces 60 paginated worker placeholders, checks exact-id/parent membership, same-name isolation, retained transcripts and conservative background-state folding. These are synthetic regression fixtures, not the issue reporter's original session.
- Android acceptance: with the app already displaying text, switch light → dark → light. Check lists, forms, sheets and the timeline, and repeat after backgrounding and returning. Native visual acceptance is separate from TypeScript/unit tests.

Release validation for app 2.3.5 / CLI 0.10.6 also passed the real Claude handoff check (`pnpm --filter @linkshell/host live:claude`, 13/13 checks against Claude Code 2.1.168). This covers discovery, transcript import and two-way continuation, not a live native Workflow run. Workflow UI screenshots use an isolated fixture host and the actual Android app in an emulator; they are not Claude execution records.
