# LinkShell Desktop UI (`@linkshell/desktop-ui`)

Dedicated frontend package for the LinkShell Desktop client on **macOS** and **Windows** (`apps/desktop`, `apps/mac`, `apps/windows`), completely decoupled from the gateway browser console (`apps/web`).

## Browser Support Policy

- **Browser Support Policy (`apps/desktop-ui`)**: **Electron `44.9.3` / Chromium `152+`** (pinned identically across macOS `arm64`/`x64` and Windows `win32-x64`).
- Use native Chromium 152 HTML/CSS/DOM capabilities directly (`<dialog>` + `closedby`, `popover="auto" | "hint"`, `commandfor` / `command`, `interestfor`, CSS Anchor Positioning, `focusgroup`, customizable `<select>` with `appearance: base-select`, `light-dark()`, `field-sizing: content`, `element.startViewTransition()`, `Element.prototype.moveBefore()`, `scheduler.yield()`, `Element.prototype.setHTML()`).
- **Zero legacy UI bloat**: Do NOT introduce `@radix-ui/*`, `radix-ui`, `lucide-react`, `@floating-ui/*`, `tw-animate-css`, or `class-variance-authority`.
- **Safari-only exception**: `<input type="checkbox" switch>` is unsupported in Chromium; implement switches via `<input type="checkbox" role="switch">`.

## Architecture & Sacred Invariants

1. **Visual System Parity**:
   - Canonical brand and semantic colors live in `apps/client/src/theme/brand-colors.json` (`docs/design/visual-system.md`).
   - All light surfaces must maintain WCAG AA contrast (`secondaryLabel >= 4.5`, `tertiaryLabel >= 4.5`, `secondaryLabel - tertiaryLabel >= 1.0`).
   - Every icon goes through `<DesktopIcon>`, `<AgentMark>`, or `<SubagentGlyph>` (`src/icons/`).
2. **Smoke & Packaging Contracts**:
   - `pnpm --filter @linkshell/desktop-ui build` MUST emit `dist/index.html`, `dist/preview/bridge.html`, `dist/preview/bridge.js`, and `dist/preview/worker.js`.
   - Root container MUST render `.desktop-root` with `data-shell="electron"` and `data-platform="macos" | "windows" | "linux"`, and honor `#view=manage[:<page>]`.
3. **Native Metal `DesktopScreenSurface` Occlusion Guard**:
   - On macOS, `LinkShellNative.node` mounts an AppKit `CAMetalLayer` view above `WebContents`. Any open `<dialog>` or `[popover="auto" | "manual"]` tracked in `src/bridge/top-layer-registry.ts` MUST collapse the reported native screen layout rect to `0×0` until closed.
4. **First-Class 融合模式 (Fusion Mode)**:
   - `FusionLocal` runs as a headless `.accessory` media hub on macOS; its App Catalog, badged icons, and window controls live inside LinkShell Desktop (`fusion.start` / `fusion.stop` Host RPC + `fusionStart`, `fusionState`, `fusionIcons`, `fusionLaunchApp`, `fusionQuitApp`, `fusionStop` Electron IPC + app-lifetime `linkshell-fusion-tunnel` bridge).
   - Opening the Fusion page never starts Fusion: entry points start it, Disconnect sticks (`fusion-store`), and an unexpected drop reconnects with backoff from the store, page open or not.
5. **State belongs to what it describes**:
   - `SessionWorkspace` is keyed by `computerKey:sessionId`, and each inspector panel by its scope: attachments, drafts and scroll position never carry from one session into the next.
   - Unsaved file drafts live in `inspector-tabs-store`, so a session switch keeps them and closing a dirty tab asks first.
6. **Shortcuts come from one table**: `bridge/shortcuts.ts` (`DESKTOP_SHORTCUTS`) is what the shell binds and what the shortcuts sheet lists. A feature claims ⌘W through the cancelable `CLOSE_TAB_EVENT`; add a binding to the table, never as a stray `keydown` handler.
7. **Every string goes through a dictionary** in all three languages (`core/i18n.tsx`, `features/*/…i18n…`, `primitives/labels.ts` for the primitives' fallbacks, `apps/desktop/src/main/locale.ts` for native menus and dialogs). No hard-coded Chinese or English in TSX.
