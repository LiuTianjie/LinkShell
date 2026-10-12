# Fixed-version native agent regression

```sh
pnpm install --frozen-lockfile
npm ci --prefix packages/host/test/real-agents --no-audit --no-fund
pnpm --filter @linkshell/host test:real-agents
```

The private npm manifest and lockfile pin Codex and Claude Code, including their
platform binaries. The ACP adapter and both SDKs use the host's exact versions
from the frozen workspace installation. Preflight checks installed packages and
CLI `--version`; missing binaries, global fallback and version drift fail the run.

Only the model HTTP endpoint is a deterministic loopback fixture. The real Codex
app-server and Claude CLI, bundled ACP adapter, SDK, host RPC, transcript files,
permission requests and shell tools run unchanged. No provider account or API
key is needed. Each test uses a fresh HOME, CODEX_HOME and CLAUDE_CONFIG_DIR and
an allowlisted subprocess environment; the user's sessions and credentials are
not read. `live:codex` / `live:claude` remain separate paid-provider checks.

| Required contract | Evidence |
| --- | --- |
| `codex-multi-client` | Native desktop RPC and two devices share streaming events; a second device approves a real command; cursor reconnect receives a new turn; desktop launch uses the shared socket. |
| `codex-restart` | Host restart restores native history once, then sends the previous context on the next model request. |
| `claude-handoff` | Native desktop CLI → ACP phone → native desktop CLI keeps the native ID and both directions of context; immediate reclaim does not duplicate late transcript writes. |
| `claude-active-handoff` | A real desktop inference stays in flight until the desktop process exits and acknowledges yield; ACP then resumes; allowed Bash writes a file and denied Bash does not. |

The runner checks every named contract exactly once and rejects missing, skipped,
failed, empty or truncated reports. A process failure or five-minute timeout is
also a failure. It kills its process group and removes its own temporary state on
completion, failure or SIGINT/SIGTERM. Vitest hooks clean individual sessions.
Ordinary `pnpm test` runs fast protocol fixtures and the report-verifier's negative
tests; the `.contract.ts` files run only through this separate configuration.

`.github/workflows/real-agents.yml` runs on every PR, main push, weekly schedule
and manual dispatch, on hosted Linux and macOS. It uses no secrets and uploads
`versions.json`, `vitest.json` and `summary.json` for seven days, including failure
evidence. Dependabot proposes weekly CLI/adapter updates; each PR runs the same
contracts with its proposed versions. There is no automatic merge or release.
Repository branch rules must separately require `real agents (ubuntu-latest)`
and `real agents (macos-15)` if merges should be blocked by these checks.

Local reports default to ignored `packages/host/build/real-agents`; override with
`LINKSHELL_REAL_AGENT_REPORT_DIR`. After reviewing them, remove that report
directory and this directory's `node_modules`. Tests do not install a host daemon.
This suite proves native protocol/process compatibility against its pinned
versions. It does not prove provider availability, GUI/TUI rendering, mobile
device behavior or compatibility with arbitrary user-installed versions.
