# Windows model UI E2E

`pnpm --filter @linkshell/windows test:model-ui-e2e` runs only on a disposable Windows GitHub Actions runner after a standalone bundle has been built. The dispatch-only workflow stage runs independently of the update E2E result. It does not publish a release.

The harness copies the bundle into its own temporary directory and downloads the official Windows Codex CLI 0.162.1 from npm, checking its pinned SHA-512 integrity. It uses that archive's `package/vendor/x86_64-pc-windows-msvc/bin/codex.exe` and checks the binary and working directory before launch. Electron, the bundled Host, the official agent, their profiles and their working directory are all isolated. Child processes receive an environment allowlist, an empty `CODEX_HOME` and `cli_auth_credentials_store = "file"`. Native `account/read` must confirm `account: null` and `requiresOpenaiAuth: true`.

The actual Electron UI chooses a model from the live catalog, sends the real `agents.models` preview request and creates a session with an empty prompt. The harness then changes that session's model through the composer. It requires all of:

- The actual `sessions.setConfig` request and successful response.
- The Host's `ls_config` notification with the selected value.
- The matching model in the SQLite `driver_state` override and latest persisted configuration event.
- The same checked UI value after leaving and reopening the session, and again after reloading the renderer with the original Host and app-server still running.

A fixture imported only into the copied CLI observes the real official agent's stdio without replacing any response. It records native `account/read`, `model/list` and the empty `thread/start` result. It rejects `turn/start`, `turn/steer`, `review/start`, `thread/compact/start` and `command/exec` before forwarding them to the native process; the final zero-inference assertion checks that same set of methods. No prompt, review, compaction or inference is required or allowed. The Codex global model configuration remains unchanged.

This proves model discovery, option writes, disk persistence and UI reopening. It does not prove account model entitlement, completed inference, or recovery of an empty native thread across a Host restart; an empty thread may have no rollout yet.

Artifacts contain only allowlisted RPC/native fields, scoped renderer screenshots and a report. They exclude credentials, environment dumps, connection URLs, tokens, raw agent output, profiles and databases. Cleanup terminates only processes whose executable resolves inside this run's temporary root, then removes that root. The staging bundle is preserved for subsequent CI steps.
