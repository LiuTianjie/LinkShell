# Portable terminal state

The host mirrors PTY output with Ghostty's VT core. It has no PTY, terminal reply callback or file access. It emits a bootstrap using Ghostty's formatters, plus inline Kitty images, placements, both screens and keyboard stacks. The phone keeps using its existing native Ghostty renderer.

A new `terminals.attach` with `snapshot: true` returns a fixed state containing the current screen and at most 1,000 scrollback rows. `terminals.state` transfers that immutable state in 256 Ki-character chunks; it is not upward history pagination. Output after the attach boundary continues through `terminal.output`. Existing views reconnect incrementally by sequence number. The SQLite journal remains available for older clients and recovery; ended recordings are compacted on the host once, then checkpointed.

Image states that cannot be reconstructed faithfully with portable VT use the original journal: an incomplete multipart upload, implicit image IDs/image numbers, or placements whose dimensions depend on the original renderer's pixel metrics. The fallback batches up to 256 frames/512 KiB per request and combines adjacent frames with the same geometry before crossing the native bridge. It can still take longer for a large image-heavy journal. This choice preserves images and the foreground process instead of silently replacing their state. Completed images with explicit IDs and cell dimensions are included in snapshots.

The pinned core matches the Android VT dependency. `main.zig` is only the host binding/exporter. `ghostty-wasm.patch` enables inline graphics on freestanding WASM and disables file/shared-memory image sources. PNG decoding uses pngjs in Node. Each screen has an 8 MiB history budget and 32 MiB image budget; immutable transfers expire after two minutes and have a shared 256 MiB budget.

## Rebuild

Normal builds copy the checked-in `.wasm.gz`; users do not need Zig. To rebuild it:

```sh
ZIG=/path/to/zig-0.15.2/zig python3 packages/host/native/terminal-state/build.py
```

The script verifies the pinned source archive, applies the patch in a temporary directory, builds, and updates the artifact checksum in `manifest.json`. `GHOSTTY_ARCHIVE` can supply an already downloaded archive (the same checksum is required). On a Mac whose current SDK lacks an arm64 stub compatible with Zig 0.15, set `GHOSTTY_MACOS_SDK` to an installed compatible SDK; the script uses a private xcrun shim without changing xcode-select.

Validation: `pnpm --filter @linkshell/host test`, `pnpm --filter @linkshell/client test`, then the repository-wide build/typecheck and client lint. Tests exercise bounded history, Unicode, alternate screens, image pixels, partial controls, cursor wrap, keyboard stacks, checkpoint persistence, stable transfer boundaries and unchanged foreground PID/state. They do not establish phone rendering latency.
