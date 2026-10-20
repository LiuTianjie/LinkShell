# LinkShell for Windows

Windows desktop workspace and native management/screen helper, backed by the existing LinkShell CLI and host. Targets Windows 10 1809+ / Windows 11 x64 with .NET Framework 4.8 and Microsoft Edge WebView2 Evergreen Runtime.

From the repository root:

```powershell
corepack pnpm build
corepack pnpm typecheck
corepack pnpm --filter @linkshell/windows test
node apps/windows/scripts/workspace-qa.mjs --native
corepack pnpm --filter @linkshell/windows build:standalone
```

The standalone installer and portable ZIP include Node, CLI, Host, ConPTY, and the screen helper. Agents are installed and authenticated separately. Windows releases currently ship without Authenticode signatures; download notes must identify them as unsigned and mention possible unknown-publisher or SmartScreen prompts. Release builds still require CI and package checksum verification. Windows ARM64 and automatic updates are not included yet.

Codex discovery first checks the CLI on PATH, then the Windows desktop app's versioned `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin`. Installing the Codex desktop app is sufficient for conversation discovery; a separate global CLI installation is not required. An explicitly configured command still takes precedence. The existing `CODEX_HOME` setting controls conversation storage.

`src/Workspace.cs` owns WebView2 and the bundled `desktop-workspace` CLI sidecar. The same web workspace as macOS handles local/remote conversations, approvals, terminals, files, worktrees and port-preview tabs. Local access uses named pipes without an account or gateway. The main-frame native bridge is origin-checked; preview/screen iframes receive no native authority. InPrivate browser storage is ephemeral; identity, pairings and drafts persist through the sidecar. Quit/reconnect waits for pending writes and asks before discarding a failed save. The Host stays running after the UI exits.

`src/Dashboard.cs` provides native management/tray UI. Both modes use the Mac workspace's 232px sidebar, 104px brand area and light/dark/system appearances. Ctrl+1/2 switches modes. Account management includes Pro refresh and redemption via stdin. WebRTC reception uses Chromium's video/GPU pipeline and existing direct input channels; leaving the screen or hiding/minimizing the app destroys the connection. This is not the Mac VideoToolbox/Metal receiver and does not guarantee hardware decode or 120fps. The screen helper and installer retain the existing capture, input, progress and rollback behavior.

The package includes checksum-pinned WebView2 SDK DLLs/license and freshly built workspace assets. Evergreen Runtime is supplied by Windows/Microsoft; missing-runtime errors offer an install/repair link while native management remains available. `workspace-qa.mjs` tests native origin/download policy; `--native` additionally runs an isolated Host and real WebView2 with a labeled Codex fixture, testing history, draft persistence, visibility and bridge/save acknowledgements. It does not exercise production OAuth or real redemption.

`node apps/windows/scripts/build.mjs --qa` builds an isolated live-host launcher (`LinkShell.QA.exe`), a labeled design preview (`LinkShell.Preview.exe`), and a harmless input fixture (`LinkShell.InputQA.exe`). These executables and preview fixtures are excluded from the standalone package. Agent marks reuse the mobile assets and the Mac light/dark treatments.

The WPF installer shows the destination, byte-based extraction progress, service recovery stages, safe cancellation before replacement, retryable errors, and an optional launch on completion. Application and installer icons share a rounded rectangle mask. `node apps/windows/scripts/installer.mjs` rebuilds only the installer from the checksum-verified portable ZIP; run a full standalone build if the bundled app changed. `node apps/windows/scripts/installer-qa.mjs` builds `LinkShell.SetupQA.exe`: it runs the real extractor in an isolated `build/install-qa-*` directory and substitutes the shortcut callback, without touching installed apps, user services, or the Start menu.

Screen sharing requires an unlocked interactive desktop. Native capture tests explicitly skip when Windows denies access to the input desktop; dry-run input tests do not prove real mouse or keyboard injection. See [the Windows guide](../../docs/windows-desktop.md) for installation, limitations, and the acceptance checklist.

Screen video prefers DXGI Desktop Duplication → D3D11 scaling → hardware H.264 → WebRTC DTLS-SRTP. It uses the existing Mac viewer/native iOS signaling protocol and four DataChannels. Reliable input and unordered pointer events travel independently of video; stale pointer positions are discarded. The initial video ceiling is 1920×1080 at 60 fps, subject to the display, receiver, hardware and network. NACK/RTX and periodic IDRs repair loss; receiver bandwidth feedback lowers the capture profile. A profile change currently restarts the encoder. Windows does not yet implement the Mac 120 fps, HEVC, FlexFEC, or cursor-shape capture.

`node apps/windows/scripts/media-runtime.mjs` fetches a checksum-pinned, shared LGPL FFmpeg runtime for development. Standalone packaging includes it automatically. AMD AMF, NVIDIA NVENC and Intel QSV are selected by the display adapter, with hardware Media Foundation as the next candidate. Drivers that reject GPU conversion can use CPU scaling/conversion with the hardware encoder. No software H.264 encoder is silently substituted. The native helper guards the interactive desktop/local opt-out and owns FFmpeg in a kill-on-close Windows Job Object; EOF, helper termination and host disconnect end capture. The shared DLLs and license notices remain separate and replaceable.

When video cannot start or ICE cannot connect, the same viewer falls back to JPEG. That path uses DXGI/GPU scaling with GDI compatibility, targets up to 30 fps, and keeps its bounded acknowledgement window, unchanged-frame suppression and sharper still frames. Both paths pause when the viewer is hidden. `LINKSHELL_SCREEN_VIDEO=off` forces this fallback; `LINKSHELL_WINDOWS_ENCODER=h264_amf|h264_nvenc|h264_qsv|h264_mf` selects an encoder for diagnostics. There is no TURN relay for the video track.

`node apps/windows/scripts/video-check.mjs` exercises real capture, encrypted video reception, input dry run, pause/resume and JPEG fallback. `node apps/windows/scripts/video-browser-check.mjs` runs the shipped viewer in isolated headless Edge and records decode/presentation metrics. These checks require an unlocked desktop; they do not replace physical-phone or other-GPU validation.

For diagnostics, `LINKSHELL_SCREEN_CAPTURE=gdi` selects the compatibility capture and `LINKSHELL_SCREEN_DIAGNOSTICS=1` prints capture timing averages to stderr. `node apps/windows/scripts/screen-benchmark.mjs <helper.exe> 1280 30 10` measures actual output on the current desktop; unchanged-frame suppression means a still desktop intentionally reports a low FPS. `test/ScreenPerformance.cs` provides an optional moving-text test window and is never shipped.
