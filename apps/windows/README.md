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

Packaging follows macOS's runtime pruning: it retains the Claude SDK and ACP adapter, but excludes their unused native Claude executables because the Host passes the user's installed Claude to ACP. It also removes ARM64 terminal files, debug symbols, type declarations, source maps and node-pty build sources, including from reused staging directories. The x64 terminal runtime, executable JS, licenses and replaceable FFmpeg DLLs remain bundled. The package smoke check covers the external-agent route and a real ConPTY process.

Codex discovery first checks the CLI on PATH, then the Windows desktop app's versioned `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin`. Installing the Codex desktop app is sufficient for conversation discovery; a separate global CLI installation is not required. An explicitly configured command still takes precedence. The existing `CODEX_HOME` setting controls conversation storage.

`src/Workspace.cs` owns WebView2 and the bundled `desktop-workspace` CLI sidecar. The same web workspace as macOS handles local/remote conversations, approvals, terminals, files, worktrees and port-preview tabs. Local access uses named pipes without an account or gateway. The main-frame native bridge is origin-checked; preview/screen iframes receive no native authority. InPrivate browser storage is ephemeral; identity, pairings and drafts persist through the sidecar. Quit/reconnect waits for pending writes and asks before discarding a failed save. The Host stays running after the UI exits.

`src/Dashboard.cs` provides native management/tray UI. Both modes use the Mac workspace's 232px sidebar, 104px brand area and light/dark/system appearances. Ctrl+1/2 switches modes. Account management includes Pro refresh and redemption via stdin. WebRTC reception uses Chromium's video/GPU pipeline and existing direct input channels; leaving the screen or hiding/minimizing the app destroys the connection. This is not the Mac VideoToolbox/Metal receiver and does not guarantee hardware decode or 120fps. The screen helper and installer retain the existing capture, input, progress and rollback behavior.

The package includes checksum-pinned WebView2 SDK DLLs/license and freshly built workspace assets. Evergreen Runtime is supplied by Windows/Microsoft; missing-runtime errors offer an install/repair link while native management remains available. `workspace-qa.mjs` tests native origin/download policy; `--native` additionally runs an isolated Host and real WebView2 with a labeled Codex fixture, testing history, draft persistence, visibility and bridge/save acknowledgements. It does not exercise production OAuth or real redemption.

`node apps/windows/scripts/build.mjs --qa` builds an isolated live-host launcher (`LinkShell.QA.exe`), a labeled design preview (`LinkShell.Preview.exe`), and a harmless input fixture (`LinkShell.InputQA.exe`). These executables and preview fixtures are excluded from the standalone package. Agent marks reuse the mobile assets and the Mac light/dark treatments.

The WPF installer shows the destination, byte-based extraction progress, service recovery stages, safe cancellation before replacement, retryable errors, and an optional launch on completion. Application and installer icons share a rounded rectangle mask. `node apps/windows/scripts/installer.mjs` rebuilds only the installer from the checksum-verified portable ZIP; run a full standalone build if the bundled app changed. `node apps/windows/scripts/installer-qa.mjs` builds `LinkShell.SetupQA.exe`: it runs the real extractor in an isolated `build/install-qa-*` directory and substitutes the shortcut callback, without touching installed apps, user services, or the Start menu.

Screen sharing requires an unlocked interactive desktop. Native capture tests explicitly skip when Windows denies access to the input desktop; dry-run input tests do not prove real mouse or keyboard injection. See [the Windows guide](../../docs/windows-desktop.md) for installation, limitations, and the acceptance checklist.

Screen video and Fusion media run in the native C++20 `libwebrtc` engine (`LinkShell.Media.exe`, built from `apps/windows/media/` against checksum-pinned prebuilt Google `libwebrtc` M150 static libraries for x64 and ARM64). It uses GPU zero-copy Windows.Graphics.Capture / DXGI Desktop Duplication → D3D11 VideoProcessor NV12 conversion → Media Foundation hardware MFT (H.264 and H.265/HEVC on NVIDIA/AMD/Intel/Qualcomm GPUs, with live zero-restart `SetRates` and instant PLI IDR), plus `WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0`, FlexFEC-03, live `rtc.configure` reuse, physical key scan codes (`keys: true`), cursor shape sync, and WASAPI loopback audio. The bundle no longer ships FFmpeg.

For headless machines or resolution matching, the bundle ships the SignPath-signed MIT IddCx Virtual Display Driver (`vdd/`, `VirtualDrivers/Virtual-Display-Driver`, x64 and ARM64), which users can install, enable, disable, or uninstall with one click from LinkShell Desktop Settings. `LinkShell.Screen.exe` is built from the same C++20 CMake project (`apps/windows/media/`) as a standalone static-CRT (`/MT`) Win32 binary without `libwebrtc`, handling the optional `LocalSystem` elevated control/UAC service, Fusion window/Start-menu/clipboard helper, DXGI/GDI JPEG fallback, and offline driver installation (only the outer setup wrapper `LinkShell.Setup.exe` still uses `.NET Framework 4.8` WPF).

When video cannot start or ICE cannot connect, the same viewer falls back to JPEG. That path uses DXGI/GPU scaling with GDI compatibility, targets up to 30 fps, and keeps its bounded acknowledgement window, unchanged-frame suppression and sharper still frames. Both paths pause when the viewer is hidden. `LINKSHELL_SCREEN_VIDEO=off` forces this fallback; `LINKSHELL_WINDOWS_ENCODER=h264_amf|h264_nvenc|h264_qsv|h264_mf` selects an encoder for diagnostics. There is no TURN relay for the video track.

`node apps/windows/scripts/video-check.mjs` exercises real capture, encrypted video reception, input dry run, pause/resume and JPEG fallback. `node apps/windows/scripts/video-browser-check.mjs` runs the shipped viewer in isolated headless Edge and records decode/presentation metrics. These checks require an unlocked desktop; they do not replace physical-phone or other-GPU validation.

For diagnostics, `LINKSHELL_SCREEN_CAPTURE=gdi` selects the compatibility capture and `LINKSHELL_SCREEN_DIAGNOSTICS=1` prints capture timing averages to stderr. `node apps/windows/scripts/screen-benchmark.mjs <helper.exe> 1280 30 10` measures actual output on the current desktop; unchanged-frame suppression means a still desktop intentionally reports a low FPS. `media/test/helper_core_test.cpp` provides portable C++20 unit coverage for the helper's protocol, XML, INF, Fusion app resolution, and scan-code logic.
