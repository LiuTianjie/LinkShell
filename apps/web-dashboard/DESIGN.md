# LinkShell Web — Design System (ChatGPT/Codex-inspired)

Goal: calm, spacious, refined developer console. Implemented via existing CSS-var theming (`--c-*`) + Tailwind.

## 1. Spacing & density
- Page gutters: `px-6` (mobile) → content lives in a centered column.
- **Reading column max-width: `max-w-[46rem]` (~736px)** — ChatGPT/Codex use ~720–768px. Centered.
- Message vertical rhythm: **`gap-8`** between turns (was gap-6 / too tight).
- Card padding: `p-4` (16px) for cards, `px-3.5 py-2.5` for compact rows.
- Sidebar item: `px-3 py-2` (was px-2 py-1 — too cramped), `gap-2.5`, rows `rounded-lg`.
- Composer: outer `p-2`, textarea `px-3 py-2.5`, big rounded `rounded-2xl`.
- Section gaps in sidebar: `py-3` groups, dividers via spacing not borders where possible.

## 2. Color & elevation (CSS vars already defined; refine)
Dark: layered charcoal — canvas `#0b0d0f`, surface `#16181c`, raised `#1c1f24`, overlay `#23262c`. Borders near-invisible hairline `rgb(255 255 255 / 0.07)`.
Light: warm near-white — canvas `#ffffff`, surface `#ffffff`, raised `#f7f7f6`, overlay `#efefee`, border `#e8e8e6` (hairline).
Elevation: e0 flat (no shadow), e1 card `0 1px 2px rgb(0 0 0 / .06)`, e2 floating `0 8px 30px -12px rgb(0 0 0 / .25)`. Light mode shadows much softer.
Accent: keep teal but use sparingly — only active states, primary button, focus ring.

## 3. Typography
- Title: `text-[15px] font-semibold` (app/section headers — ChatGPT is restrained).
- Message body: `text-[15px] leading-7` (relaxed line-height = breathing room).
- Metadata/timestamps: `text-xs text-content-muted`.
- Code/mono: `text-[13px] leading-relaxed font-mono`.
- Sidebar label: `text-[13px]`; group header `text-2xs font-semibold uppercase tracking-wider text-content-faint`.

## 4. Components
- **Assistant message**: NO bubble — full-width text on canvas, like ChatGPT. `text-[15px] leading-7`. Small role label above optional.
- **User message**: subtle rounded panel, right-aligned OR (better, Codex-style) full-width with a left accent rail + muted bg `bg-surface-raised rounded-2xl px-4 py-3`.
- **Tool/command/diff cards**: `rounded-xl border border-border bg-surface` collapsed pill row; hairline borders.
- **Composer**: `rounded-2xl border border-border bg-surface shadow-[e2]` floating; focus ring accent/30.
- **Buttons**: primary solid accent; ghost = hover bg-surface-overlay; outline hairline. Radius `rounded-lg`, `h-9 px-3.5`.
- **Chips**: `rounded-full bg-surface-overlay px-2.5 py-1 text-xs`.
- **Empty state**: large centered, icon + muted helper text, generous `py-20`.

## 5. Motion
- Message fade-in: `animate-fade-in` (existing, 0.2s). Stagger not needed.
- Hover: `transition-colors duration-150` only (no layout-shifting scale).
- Drawer/queued: `animate-slide-in`.
- Respect `prefers-reduced-motion`.

## 6. Layout
`[sidebar 264px] [flex-1 centered reading column] [optional right drawer 40-46%]`.
- Sidebar: own bg-surface, hairline right border, collapsible.
- Center: canvas bg, scroll area with centered `max-w-[46rem]`, composer pinned bottom in same column width.
- Top bar: `glass-bar` sticky, `h-12`, hairline bottom.
