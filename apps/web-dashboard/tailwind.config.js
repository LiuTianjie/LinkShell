/** @type {import('tailwindcss').Config} */
// Colors use the `rgb(var(--c-x) / <alpha-value>)` channel pattern so every
// utility (incl. opacity modifiers like bg-surface/40 and frosted-glass layers)
// resolves against CSS variables — which the theme system swaps for light/dark.
const ch = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: ch("--c-canvas"),
        surface: {
          DEFAULT: ch("--c-surface"),
          raised: ch("--c-surface-raised"),
          overlay: ch("--c-surface-overlay"),
        },
        border: {
          DEFAULT: ch("--c-border"),
          strong: ch("--c-border-strong"),
        },
        content: {
          primary: ch("--c-content-primary"),
          secondary: ch("--c-content-secondary"),
          muted: ch("--c-content-muted"),
          faint: ch("--c-content-faint"),
        },
        brand: {
          DEFAULT: ch("--c-brand"),
          light: ch("--c-brand-light"),
          dark: ch("--c-brand-dark"),
        },
        accent: {
          DEFAULT: ch("--c-accent"),
          dim: ch("--c-accent-dim"),
        },
        diff: {
          add: ch("--c-diff-add"),
          addText: ch("--c-diff-add-text"),
          remove: ch("--c-diff-remove"),
          removeText: ch("--c-diff-remove-text"),
        },
        success: ch("--c-success"),
        warning: ch("--c-warning"),
        danger: ch("--c-danger"),
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateX(8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "drawer-in": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        // Right panel: slides in from the right edge with a subtle fade.
        // The 30px translate keeps the motion visible without overshooting.
        "panel-in-right": {
          from: { opacity: "0", transform: "translateX(30px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "panel-out-right": {
          from: { opacity: "1", transform: "translateX(0)" },
          to: { opacity: "0", transform: "translateX(30px)" },
        },
        // Terminal bottom panel: slides up from below / down to below.
        "panel-in-up": {
          from: { opacity: "0", transform: "translateY(100%)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "panel-out-down": {
          from: { opacity: "1", transform: "translateY(0)" },
          to: { opacity: "0", transform: "translateY(100%)" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 1.2s ease-in-out infinite",
        "fade-in": "fade-in 0.2s ease-out",
        "slide-in": "slide-in 0.22s cubic-bezier(0.16,1,0.3,1)",
        "drawer-in": "drawer-in 0.24s cubic-bezier(0.16,1,0.3,1)",
        "panel-in-right": "panel-in-right 0.22s cubic-bezier(0.16,1,0.3,1) both",
        "panel-out-right": "panel-out-right 0.22s cubic-bezier(0.16,1,0.3,1) both",
        "panel-in-up": "panel-in-up 0.24s cubic-bezier(0.16,1,0.3,1) both",
        "panel-out-down": "panel-out-down 0.24s cubic-bezier(0.16,1,0.3,1) both",
      },
    },
  },
  plugins: [],
};
