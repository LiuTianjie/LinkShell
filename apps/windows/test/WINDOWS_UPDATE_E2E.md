# Windows automatic update E2E

Run `pnpm --filter @linkshell/windows test:update-e2e` after `build:standalone` on a disposable GitHub Windows runner. An optional first argument selects one `artifacts/windows-stage-*/LinkShell` bundle. Without it there must be exactly one stage. The existing Windows workflow runs this only for `workflow_dispatch`; PR runs retain the native installer/junction regression tests.

The harness refuses other operating systems and environments without `GITHUB_ACTIONS=true`. It never runs against the staged source itself or an installed app. It copies the stage into random temporary directories and uses a separate home and Electron profile, including spaces and Chinese characters. It refuses to overwrite an existing Start Menu shortcut. Only the shortcut pointing to this test bundle is removed afterward.

The copied baseline and payload receive synthetic `65530.0.1` / `65530.0.2` versions. A copied-only Electron hook isolates userData and redirects the three exact official release URLs to a loopback fixture server. It records the actual native dialog without choosing its result. UI Automation invokes the exact Chinese button inside the known PID's window. The production updater performs the streaming download, SHA-256 check and ready-file handshake. Installers compile the unchanged production C# UI and transaction with actual copied ZIP payloads.

The sequential lifecycle verifies:

1. A real bundled Node/CLI Host and Electron app report the baseline version.
2. Corrupt installer bytes fail the real checksum; the running Host PID is unchanged and no installer starts.
3. A valid installer containing a copied CLI that exits 74 only for `desktop --action recover-update` performs the real replacement, fails recovery, rolls back, and reopens the baseline through the native installer button.
4. Retrying with the normal payload installs and relaunches the new Electron app and Host, removes previous/failed bundles and clears the recovery marker.
5. Generated identity, machine, pairing fixture and home sentinel hashes stay equal. A synthetic session and its user/agent message events remain in SQLite and `PRAGMA integrity_check` returns `ok`.

The separate `installer-update.test.mjs` suite executes the native junction, ancestor-junction, missing-home, foreign-parent and handshake regressions on Windows. This harness does not claim live gateway pairing, signed release trust, real-agent turn continuity or WAN validation.

Only `artifacts/windows-update-e2e` is uploaded for this harness: scenario results, compiler output, sanitized event records, PID-scoped UI trees and window screenshots. Home, profile, identity secrets, environment, database, copied bundles and installers are never copied into the report. Cleanup terminates only processes executing within the run's random directory, then removes that directory and its owned shortcut.

`native-uia.ps1 -AppProcessId <PID> -ButtonName '安装并重启'` invokes a native button. `-InspectOnly` reads its UI tree without clicking. `-ScreenshotPath <PNG>` uses `PrintWindow` on a HWND whose owner PID is checked before and after; it never captures the desktop. `PrintWindow` can return a blank GPU/locked-session image. The JSON `screenshot.captured` field reports capture separately from button invocation. All calls have external process timeouts because native UI Automation and `PrintWindow` can block.

Prepared and syntax checked on macOS; **not yet run on Windows**. A passing CI report is required before claiming Windows automatic update E2E success.
