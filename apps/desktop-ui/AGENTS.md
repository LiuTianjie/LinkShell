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
   - On macOS, `LinkShellNative.node` mounts an AppKit `CAMetalLayer` view above `WebContents`. Every open `<dialog>`, `[popover="auto" | "manual"]`, `[data-native-overlay]`, or measured customizable `<select>` picker (`::picker(select)`) tracked in `src/bridge/top-layer-registry.ts` MUST be cut out of it (`holes` in the layout message, boolean-subtracted in `DesktopScreenClipView` so overlapping holes stay transparent) until closed; an unmeasurable open `<select>` picker collapses the rect to `0×0`.
4. **First-Class 融合模式 (Fusion Mode)**:
   - `FusionLocal` runs as a headless `.accessory` media hub on macOS; its App Catalog, badged icons, and window controls live inside LinkShell Desktop (`fusion.start` / `fusion.stop` Host RPC + `fusionStart`, `fusionState`, `fusionIcons`, `fusionLaunchApp`, `fusionQuitApp`, `fusionStop` Electron IPC + app-lifetime `linkshell-fusion-tunnel` bridge).
   - Opening the Fusion page never starts Fusion: entry points start it, Disconnect sticks (`fusion-store`), and an unexpected drop reconnects with backoff from the store, page open or not.
5. **State belongs to what it describes**:
   - `SessionWorkspace` is keyed by `computerKey:sessionId`, and each inspector panel by its scope: attachments, drafts and scroll position never carry from one session into the next.
   - Unsaved file drafts live in `inspector-tabs-store`, so a session switch keeps them and closing a dirty tab asks first.
6. **Shortcuts come from one table**: `bridge/shortcuts.ts` (`DESKTOP_SHORTCUTS`) is what the shell binds and what the shortcuts sheet lists. A feature claims ⌘W through the cancelable `CLOSE_TAB_EVENT`; add a binding to the table, never as a stray `keydown` handler.
7. **Every string goes through a dictionary** in all three languages (`core/i18n.tsx`, `features/*/…i18n…`, `primitives/labels.ts` for the primitives' fallbacks, `apps/desktop/src/main/locale.ts` for native menus and dialogs). No hard-coded Chinese or English in TSX.

## How sessions are grouped into projects (`src/core/session-tree.ts`)

The sidebar and the projects page show sessions under projects. A session's working directory is never changed; only which project it is shown under is worked out, in two steps, the same on every system:

1. **Run folders are cut off.** The directory is cut at the first `runs` / `output` / `logs` / `tmp` / `.claude` / `.codex` / `.agents` / `.worktrees` / dated (`20261112-…`) or numbered (`run-3`, `07`) folder, to the folder that holds it: `shop/runs/20261112-x/03` is `shop`.
2. **It goes to the topmost ancestor that has a session or project of its own** (after step 1): a session in `shop/web` is shown under `shop` once something was opened in `shop` itself. With nothing at `shop`, `shop/web` is a project of its own.

Neither step goes above `minimumProjectDepth`: the home directory, the folders people keep projects in (`Desktop`, `Documents`, `Projects`, `code`, `source\repos`, … and `OneDrive` in front of them), a drive's root, `/tmp`. A session opened in one of those is listed under it and takes nothing below it.

Windows paths are compared without case and with either slash (`normalizeProjectPathKey`); the phone and the web console list each working directory as its own project and only merge spellings of one folder (`packages/client-core/src/projects.ts`).

What this does not know is where a repository's root is. The host does (git) and the summaries do not carry it. Until they do, do not go back to guessing it by depth: the earlier rule took "the folder N levels below the home directory" for the root, and one session in a run folder made `OneDrive`, or Visual Studio's `source\repos`, the project of everything inside it, while on another drive a project's subfolders never joined it.
