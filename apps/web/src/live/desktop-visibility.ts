import { useEffect, useState } from "react";
import { DESKTOP_VISIBILITY_EVENT, isDesktop } from "./desktop";

declare global {
  interface Window { __LINKSHELL_DESKTOP_VISIBLE__?: boolean }
}

/** AppKit hiding a window does not consistently update WebKit's Page Visibility API. */
export function useDesktopVisibility() {
  const [visible, setVisible] = useState(() => window.__LINKSHELL_DESKTOP_VISIBLE__ !== false);
  useEffect(() => {
    if (!isDesktop) return;
    const changed = (event: Event) => {
      const next = (event as CustomEvent<{ visible: boolean }>).detail?.visible;
      if (typeof next === "boolean") setVisible(next);
    };
    window.addEventListener(DESKTOP_VISIBILITY_EVENT, changed);
    return () => window.removeEventListener(DESKTOP_VISIBILITY_EVENT, changed);
  }, []);
  return visible;
}
