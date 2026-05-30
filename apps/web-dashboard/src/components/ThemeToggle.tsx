import { useSyncExternalStore } from "react";
import { getThemePref, setThemePref, subscribeTheme, type ThemePref } from "../lib/theme";
import { IconSun, IconMoon, IconMonitor } from "./icons";

// Cycles light → dark → system. Shows the icon for the current preference.
const ORDER: ThemePref[] = ["light", "dark", "system"];
const LABEL: Record<ThemePref, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

export function ThemeToggle() {
  const pref = useSyncExternalStore(subscribeTheme, getThemePref, getThemePref);
  const next = () => setThemePref(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]);
  const Icon = pref === "light" ? IconSun : pref === "dark" ? IconMoon : IconMonitor;
  return (
    <button
      onClick={next}
      className="codex-btn-ghost px-2 py-1.5"
      title={`主题：${LABEL[pref]}（点击切换）`}
      aria-label={`主题：${LABEL[pref]}`}
    >
      <Icon size={15} />
    </button>
  );
}
