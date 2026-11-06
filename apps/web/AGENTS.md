# LinkShell Web

Read the repository's root `AGENTS.md` as well.

## Design direction

Colours, radii, type sizes, motion and the shared components follow **[docs/design/visual-system.md](../../docs/design/visual-system.md)**, the one visual system for the app, the desktop, this web console and the site. It supersedes the earlier Linear and Codex references: they remain examples of restraint, not sources of colours or sizes. Change that document and `apps/client/src/theme/brand-colors.json` first, then every surface together.

- Use shadcn/ui (Radix) primitives from `src/components/ui` for navigation, buttons, forms, menus, tabs, tables, dialogs, status badges, loading and empty states. Extend shared component variants when necessary; keep page-level classes focused on layout.
- Use quiet neutrals, subtle borders and clear typography. Primary actions use LinkShell indigo (`accentFill`) with white text; navigation selection uses a neutral surface. Avoid pill-shaped buttons, vivid navigation stripes, oversized dashboard cards and heavy decorative shadows.
- Brand and status colours come from `brand-colors.json` through `src/theme.ts`; only neutrals are defined there. Check text, hover, selected, focus, disabled, warning and error states in both themes. Do not use the primary action color for every icon or piece of metadata.
- Use Lucide's rounded outlines throughout the workspace. Desktop icon weight and sizes come from the shared tokens in `desktop.css`: 1.75 stroke, 16px controls, 18px navigation and 12px carets. Avoid text glyphs for actions and local stroke overrides. Agent and provider brand marks retain their own artwork.
- Composer settings use the shared `toolbar` button variant and `SessionConfigIcon` in both new and existing sessions. Keep labels visible when the toolbar wraps. Computers use compact list rows with resource readings and actions; history and capacity details are collapsed until requested. Only the expanded CPU history uses the accent; memory uses a neutral grey.
- Preserve LinkShell's branding and Chinese product copy. Prioritize legibility, useful information and clear actions over decorative detail.

## Sidebar and layout

- Keep desktop projects, session families and their children ordered by creation time, newest first, with stable key tie-breaks. Activity belongs in the separate 活跃会话 section; progress, responses and attention changes must never reorder existing rows. Project creation comes from its earliest recorded session, including archived history.
- The desktop sidebar is 264px wide. Navigation rows use the shared `navigation` variant: an actual 40px height, 14px text and 18px icons. Use clear group separation and generous horizontal padding.
- The main workspace fills its parent below the global header; do not apply `100dvh` to it on narrow screens, which makes the shell overflow and lets focus scrolling hide the header.
- Sidebar chrome sits below the 56px global header. Use explicit pixels or a shared dimension for this offset: the root font size is 14px, so `top-14` is only 49px.
- Share navigation spacing between the desktop sidebar and mobile sheet via the header/content/footer children. A class passed to the desktop sidebar container does not automatically style its mobile sheet.
- At shorter window heights, reduce surrounding padding before shrinking navigation targets. Keep the computer switcher and help reachable; allow controlled scrolling when the window genuinely cannot contain everything.
- Verify computed dimensions in the browser. Tailwind utilities outrank the `components` layer; merely declaring a larger height in page CSS does not override a primitive's utility class.
- Keep tables, toolbars, content panels and the conversation composer on the same spacing and typography system. Give the remote desktop useful viewing space and keep its actions discoverable.

## Behavior and verification

- The quality bar applies to every web surface, especially the session list, conversation detail and terminals. Review real interaction states, not just the first screenshot: long content, keyboard/IME, streaming follow, history position, copy actions, multiple terminals, focus, reconnect and error recovery. Never call fixture coverage a complete production acceptance.

- A visual refactor must preserve handlers, form submission, keyboard interaction, permissions, capability checks, loading/error feedback and connection lifetimes. Do not replace working actions with cosmetic placeholders.
- Keep the screen iframe isolated. Do not loosen its sandbox or expose account/device credentials to implement UI features. Video stays in the media pipeline; React receives only small control/statistics messages.
- Run `pnpm --filter @linkshell/web build` and `pnpm --filter @linkshell/web lint`, plus tests relevant to changed behavior. Check light/dark desktop layouts and a narrow browser layout for visual changes; inspect menus and overflow as well as the initial screen.
- Describe validation accurately: fixture agents, local browser tests and compilation do not prove real-agent behavior, production OAuth, WAN connectivity or stable 120 fps. No native device test is required for a web-only style change.
- Keep the functional coverage and known gaps in [docs/v2/web-completeness.md](../../docs/v2/web-completeness.md) accurate when those areas change. Do not mark a gap resolved solely because its UI is present.
