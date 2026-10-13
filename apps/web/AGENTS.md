# LinkShell Web

Read the repository's root `AGENTS.md` as well.

## Design direction

The user has chosen **Linear's product UI** as the design reference for the entire web workspace, superseding the earlier Cloudflare direction. See the product screenshot in [Linear's official Concepts documentation](https://linear.app/docs/conceptual-model).

- Use shadcn/ui (Radix) primitives from `src/components/ui` for navigation, buttons, forms, menus, tabs, tables, dialogs, status badges, loading and empty states. Extend shared component variants when necessary; keep page-level classes focused on layout.
- Use quiet cool neutrals, subtle borders and clear typography. Primary actions use restrained indigo with white text; navigation selection uses a neutral surface. Avoid orange/black buttons, vivid navigation stripes, oversized dashboard cards and heavy decorative shadows.
- Keep colors in the semantic light/dark pairs in `src/theme.ts`. Check text, hover, selected, focus, disabled, warning and error states in both themes. Keep status colors consistent; do not use the primary action color for every icon or piece of metadata.
- Preserve LinkShell's branding and Chinese product copy. Prioritize legibility, useful information and clear actions over decorative detail.

## Sidebar and layout

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
