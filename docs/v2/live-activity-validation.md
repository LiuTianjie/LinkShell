# Live Activity development validation — 2026-10-17

This is development validation, not a mobile or gateway release.

## Installed environment

- iPhone Air, iOS 27.0: `com.bd.linkshell.dev`, Release configuration with development signing; rebuilt and installed from the current working tree.
- Sandbox ActivityKit service: `https://push-dev.itool.tech`, separate APNs sandbox and storage.
- Local development host: current source, separate host home and identity.
- SSH `air2`: CLI `0.10.40-dev.activity.20261017`, Host package `0.4.38-dev.activity.20261017`, wire `0.2.12-dev.activity.20261017`. These are unpublished test packages. The daemon was restarted and verified online, retaining its existing account, identity and history. Its current process uses the sandbox push service through `LINKSHELL_PUSH_SERVICE_URL`; a future normal restart does not persist this environment override.

## Observed on the phone

| Scenario | Evidence and boundary |
| --- | --- |
| Status icon | Expanded card no longer displays “连接中”; it uses the same status symbol as the compact island. |
| Manual browsing | Tapping the island's right chevron changes the displayed task and pager indicator. |
| Switch computers | Selected local development host, then air2. Both activity registrations remained; notification-center expansion showed separate cards labeled with each computer. |
| Exact terminal navigation | Tapping air2's card opened its matching `sleep 600` terminal. |
| Completion while in another app | While Settings was foreground, air2's test terminal exited successfully. APNs accepted `end`, `completed`, `alert:true`; its card showed a checkmark and “已结束”. Automatic alert expansion was not captured. |
| Approval while in another app | An isolated fixture created an approval while Settings was foreground. The island switched to orange; expanded controls showed allow/reject. Tapping allow delivered the exact fixture task's approval to Host, and the app displayed “已允许”. This does not prove a real Codex desktop approval round trip. |
| Cold entry | Terminated the development app, then tapped a fixture async-question option in the island. The app restarted into the corresponding session rather than remaining on the action intermediary. |

## Automated validation

- Full workspace `pnpm build` and `pnpm typecheck` passed.
- Client lint passed.
- Five focused Live Activity suites: 34 tests passed, including 19 registration/handoff tests.
- Earlier in this change: full client 188, host 498, wire 29 tests passed before the final multi-computer additions; these totals must not be presented as a rerun of the final native build.
- Registration cases include preserving another computer, rotating background tokens without giving its grant to the current host, signout revocation, ended/in-flight races, and one failed refresh not blocking another computer.

## Remaining validation boundaries

- Actual account switching/signout on the phone was not performed; covered by focused tests, not device proof.
- Notification-center appearance is not proof of a screen-off alert waking the phone. Automatic expansion, sounds, Focus-mode delivery and screen-off behavior remain unconfirmed.
- Apple's documented Live Activity animations are bounded data-update animations (up to two seconds); continuous waveform animation is not promised, and Always-On disables animations.
- Real Codex desktop async-question dismissal remains unresolved. The desktop's native submit path removes its local question selection; the remote steer path examined does not perform that same UI-state mutation. Fixture acceptance must not be reported as fixing the desktop UI.
- Temporary validation hosts and terminals are removed after checks. The installed development app, local development host and upgraded air2 host remain available for user testing.

## Agent compatibility review

The Live Activity contract is independent of the agent ID. `defaultDrivers` currently registers Codex, Claude, Gemini, Antigravity, Copilot, Grok, OpenCode and Cursor, plus user-configured ACP agents. Each adapter produces shared session state; the Host relay and ActivityKit payload consume that state without an agent allowlist. Unknown agent IDs receive a generic native badge.

| Adapter path | State and action contract |
| --- | --- |
| Codex app-server | Turn, approval and question events become shared session updates. Approval/form replies return through the owning native request; asynchronous question replies use the Codex-specific steering envelope. |
| Claude | Desktop transcript observation supplies progress and completion. Remote sessions use the ACP adapter's approval/form response path. A desktop-owned request is not automatically a remotely actionable ACP request; control follows the existing handoff rules. |
| Gemini, Copilot, OpenCode and custom ACP | The generic ACP driver maps turns and `session/request_permission`, and supports standard elicitation when the agent exposes it. Missing upstream question events cannot be inferred by the card. |
| Cursor and Grok | ACP plus their existing question adapters, preserving native option IDs or answer arrays and annotations. |
| Antigravity | ACP interaction mapping, plus desktop watcher actions addressed by the current trajectory and step. Desktop private API compatibility remains a dependency. |

The card retains the computer, session, request and option identifiers. On entry the app reconnects to that computer and validates the current request before dispatch; the Host validates again and selects the session's own driver. Simple single-choice questions can expose buttons. Multi-select, multiple questions, typed answers, secret fields and URL authorization retain their full app flow. Codex asynchronous-question semantics must not be assumed for unrelated ACP agents.

The compatibility regression matrix covers all eight built-in IDs and a custom ACP ID: 18 action tests verify exact identifiers, stale/cross-computer rejection and form fallback; nine relay tests verify running, approval, failure and completion delivery. These are normalized-contract tests, not evidence that nine external agent binaries were exercised. Existing fake-process Codex, Claude and ACP integration suites cover the adapter side; Antigravity and Codex attention suites provide additional mapping coverage.

This review's runs passed: wire Live Activity 22, Host relay 22, ACP questions 4, generic ACP integration 26, Codex integration 20, Antigravity 12 and Codex attention 6. Claude handoff passed 15 of 16 cases in the grouped run and again in a standalone suite run. The remaining case (`sends a waiting message at once…`, line 544) expected `queued` but received `started`; it passed when selected alone. The race was subsequently reproduced deterministically and fixed; see the follow-up below. This earlier run alone did not certify every desktop handoff path. No external agent binary or further phone build was required for this contract review.

## Async question resolution research — 2026-10-17

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput) documents `serverRequest/resolved` for a response to `item/tool/requestUserInput`. That is the pending-request path. The [async tool implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_async.rs) instead emits an agent message with questions and immediately returns `accepted`; that acceptance is not an answer from a user.

Two third-party implementations clarify the distinction:

- [T3 Code's provider contract](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md) explicitly treats async questions as notifications with no pending RPC response. Its own server persists the question and atomically records resolution plus the answering user message. This solves T3's client state, not the official desktop's separate question selection.
- [codex-web's IPC client](https://github.com/i-am-BT/codex-web/blob/main/desktop-ipc-client.mjs) exposes `thread-follower-submit-user-input`. The installed desktop handler was inspected: it looks up a pending native request. It is not a general close-async-question method. Likewise, `thread-follower-set-queued-follow-ups-state` modifies queued user messages, not the selected question editor.

[Upstream issue 44648](https://github.com/openai/codex/issues/44648) reports unresolved async questions after normal-chat answers in the CLI. It is related lifecycle evidence, not proof of the same desktop defect or an official fix.

A read-only extraction of the installed desktop's `DIt` reconciliation function from `app-initial-1ab6fbe93c4f.js` was executed in isolation with synthetic state. Given one selected question and an answer already present in `answersByQuestionItemId`, the actual function populated `lastSubmission` but left that question selected. A candidate filter excluding answered IDs cleared that selection in the same fixture. The native submit helper `A$e` in `app-primary-2a670e99a60c.js` explicitly removes submitted selections; the remote Steer path does not invoke that UI helper.

This demonstrates a concrete UI reconciliation gap even when an answer is recognized. It does not prove every production failure has that cause, and it is not an installed fix. A proper upstream correction should reconcile confirmed answers with selected questions while preserving a newly edited draft and unanswered siblings. No application bundle, user settings, or live conversation was modified by this experiment.

Practical paths: retain exact structured replies and confirmed state in LinkShell; fix desktop reconciliation upstream (or maintain an explicitly chosen, version-specific compatibility patch); or use blocking questions for future requests where waiting is acceptable. Switching question style changes agent behavior and does not repair an already-issued async question. No documented public external-dismiss interface was found in the sources examined.

For Claude, the [official SDK input contract](https://code.claude.com/docs/en/agent-sdk/user-input) handles `AskUserQuestion` through `canUseTool`. [Official Remote Control](https://code.claude.com/docs/en/remote-control) synchronizes its own clients through Anthropic's service; that is not evidence of a public drop-in LinkShell handoff endpoint. The local fake-process `queued`/`started` regression was subsequently traced to the transcript watcher race described below; it was independent of the upstream SDK input contract.


## Claude handoff fix and phone button follow-up

A desktop can resume writing a session after its last remote turn but before the periodic transcript watcher notices. An immediate phone prompt previously saw the stale remote owner and started another turn instead of queuing behind the desktop. `ClaudeDriver` now reconciles external transcript writes before prompt, cancel and takeover, and concurrent callers await the same transition. A regression test uses a 60-second watcher interval to reproduce the ordering without relying on a short timer: it failed before the change and passes afterward.

After the fix, full workspace build and typecheck, client lint, and 65 focused Host tests passed (17 Claude handoff, 26 ACP integration, 22 Live Activity relay).

The following were operated on the actual iPhone Air development app, through the public gateway and sandbox ActivityKit service, using the real Host and ClaudeDriver with isolated fake Claude/ACP child processes:

| Phone action | Verified result |
| --- | --- |
| App approval: Allow | The owning `session/request_permission` resumed and the session completed. |
| Notification-center Live Activity: Reject | The exact waiting request resolved; the app opened its session and displayed “已拒绝”. |
| Live Activity single choice: SQLite | The owning elicitation returned `{"action":"accept","content":{"question_0":"SQLite"}}`; the app displayed “已回答” and the activity ended. |
| App: Take over | An actual `linkshell claude --resume` CLI connection stepped aside and printed “已由手机接管”. |
| Send after takeover | Text entered and sent on the phone returned through the ACP process and completed in the same session. |
| Return to desktop | Pressing a key in that CLI reclaimed the same session; Host reported `driver: desktop`. |

These are device-to-driver integration results, including actual taps, reconnection, RPC and child-process handoff. The fake processes do not call a language model and are not evidence of live Claude model compatibility. The separate real-Claude attempt could not complete: the configured third-party model gateway returned an upstream HTTP 502 after retry/timeout. The preceding bootstrap 401 was not sufficient evidence of a login problem; no global Claude settings were changed.

All isolated child processes, validation hosts, logs and temporary trial files from this follow-up were removed. The existing development host remains running with the handoff fix, and the installed phone app is retained.

## Prepared Codex desktop compatibility patch

[`scripts/compat/codex-async-question-selection.mjs`](../../scripts/compat/codex-async-question-selection.mjs) reads the installed desktop asset and prepares a reviewable patch manifest. It never repacks, signs, restarts or modifies the application. The companion test has seven passing cases against an isolated execution of the installed reconciliation function: confirmed answers clear selection, unanswered siblings and newly edited drafts remain, and unrecognized layouts are rejected.

The examined build is 26.1007.71326 (`com.openai.codex`, locally installed as `/Applications/ChatGPT.app`). The target is `webview/assets/app-initial-1ab6fbe93c4f.js`; its source SHA-256 is `f3d5fedc993d0ead2720c9877d8c72a82dc5fb2d935f13ad9426e6964fb6f105`. This is version-specific. The patch remains **uninstalled**, so the official desktop async-question dismissal problem is not claimed fixed on the live app. Applying it would change the signed desktop bundle and require re-signing and restarting; that separate action awaits the user's choice.

## Real installed agents and home presentation follow-up

The isolated source Host exercised the installed Codex 0.162.1, Antigravity 2.24.0, Grok 1.0.60, Gemini 0.62.0 and Copilot 1.0.98 against their real model services. Each completed an initial turn retaining a test token. Codex, Antigravity and Grok then emitted actual structured single-choice questions; Gemini and Copilot emitted actual permission requests. Copilot explicitly reported that its ACP session does not expose a native ask-user tool. OpenCode and Cursor were not installed. The `agent` executable on this machine is Grok, so its presence must not be reported as Cursor availability.

The initial phone screenshot exposed a missing denial action: Gemini uses `cancel` for its sole `reject_once` option. The shared presentation had treated that ID as Codex's separate stop action, and the card's secondary-action limit hid it. Sole rejection now follows the permission kind, while Codex's separate decline/stop pair is preserved. The button group also promotes a lone stop action when no ordinary rejection exists. Two focused regression cases pass, bringing the wire Live Activity suite to 24 tests.

Home waiting cards now use a single neutral surface, show the actual question text, and keep answer/approval controls compact. Repeated warning borders, colored inset panels and duplicate status counts were removed. Existing large-text stacking and 44-point control heights remain. Client lint, full workspace typecheck and all 193 client tests pass. Device installation and real action outcomes are recorded below after completion.

### Actual phone outcomes

The updated development binary was built successfully, installed on iPhone Air and inspected visually in dark mode. The homepage showed compact neutral cards and complete allow/reject controls. All actions below were tapped on that phone:

| Real agent | Phone action | Observed result |
| --- | --- | --- |
| Codex | Selected SQLite and submitted the structured question | Native turn resumed, returned `SQLite PELICAN-84`, became idle with zero pending permissions. This is the blocking question path, not official desktop async-editor dismissal. |
| Grok | Selected SQLite and submitted | Returned `SQLite PELICAN-84`, became idle with zero pending permissions. |
| Gemini | Rejected the requested process-inspection command from Home | Request cleared and turn ended. The agent reported no native structured ask-user tool in this session. |
| Copilot | Allowed one command from Home | Created the exact isolated proof file containing `PELICAN-84`, reported it and became idle. |
| Antigravity | Selected Postgres and submitted a fresh native question | Returned `Postgres PELICAN-84`, became idle with zero pending permissions. |

Antigravity initially exposed another real bug: its native question step had been canceled while the transcript still ended with the old tool call. The transcript fallback recreated an obsolete permission, and submitting it returned `input not registered for step 4`. The Host now gives observed native step state precedence over the transcript fallback. Three regression cases (done, canceled, error) failed before the change and pass afterward; all 15 Antigravity tests pass. Restarting the isolated Host with the fix cleared the obsolete card; the fresh real question then completed successfully as shown above. Full workspace build and typecheck were rerun successfully after this Host change.

The real Claude attempts remain limited by the configured model service's failed/aborted requests; they are not counted as a successful live Claude model round trip. The earlier controlled Claude handoff/device results and the uninstalled Codex desktop patch retain their separate boundaries. Light-mode and enlarged-text layouts were not separately exercised on the phone in this pass.

Cleanup: the five owned agent sessions were deleted through Host RPC after becoming idle (the subsequent restart-only Gemini auth error was also cleared with its test session). The isolated real-agent Host was stopped, its temporary state/logs/proof file and 3.4 GB build directory were removed, and the isolated failed Claude transcript directory was removed. The phone was switched back to `LinkShell Dev · MacBook`. The installed development binary and pre-existing development hosts remain available.
