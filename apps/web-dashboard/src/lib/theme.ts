// Theme system: light / dark / system preference, applied as data-theme on
// <html>, persisted to localStorage, and observable for React via subscribe().

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const KEY = "linkshell_theme";
const listeners = new Set<() => void>();

let pref: ThemePref = readStoredPref();

function readStoredPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "dark"; // current default
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

export function resolveTheme(p: ThemePref = pref): ResolvedTheme {
  if (p === "system") return systemPrefersDark() ? "dark" : "light";
  return p;
}

function apply(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolveTheme());
}

export function getThemePref(): ThemePref {
  return pref;
}

export function setThemePref(next: ThemePref): void {
  pref = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  apply();
  for (const l of listeners) l();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply the stored theme immediately and keep "system" in sync with the OS. */
export function initTheme(): void {
  apply();
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (pref === "system") {
        apply();
        for (const l of listeners) l();
      }
    };
    mq.addEventListener?.("change", onChange);
  }
}
