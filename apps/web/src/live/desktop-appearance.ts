import { useEffect, useState } from "react";
import { applyDesktopTheme } from "../theme";
import { readLocal, saveLocal } from "./storage";
import { setDesktopAppearance, shellAppearance } from "./desktop";

export type Appearance = "system" | "light" | "dark";
const EVENT = "linkshell-desktop-appearance";

function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

function current(): Appearance {
  const native = shellAppearance();
  if (isAppearance(native)) return native;
  const saved = readLocal<string>("desktopAppearance", "system");
  return isAppearance(saved) ? saved : "system";
}

/**
 * The window's appearance and a way to choose it. Every caller sees the same value: the shell's
 * setting, kept current by its events; a choice made here is sent to the shell and announced as
 * the same event, so the shell (which doesn't echo a choice back) and every other caller follow.
 */
export function useDesktopAppearance(): [Appearance, (value: Appearance) => void] {
  const [appearance, setAppearance] = useState<Appearance>(current);
  useEffect(() => {
    const receive = (event: Event) => {
      const value = (event as CustomEvent<{ appearance?: unknown }>).detail?.appearance;
      if (isAppearance(value)) setAppearance(value);
    };
    window.addEventListener(EVENT, receive);
    return () => window.removeEventListener(EVENT, receive);
  }, []);
  const choose = (value: Appearance) => {
    setDesktopAppearance(value);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { appearance: value } }));
  };
  return [appearance, choose];
}

/** Applies the appearance to the page's colours, following the system when that is the choice. */
export function useApplyDesktopAppearance(appearance: Appearance) {
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyDesktopTheme(appearance === "system" ? (system.matches ? "dark" : "light") : appearance);
    update();
    saveLocal("desktopAppearance", appearance);
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, [appearance]);
}
