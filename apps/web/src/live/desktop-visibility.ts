import { useEffect, useState } from "react";
import { DESKTOP_VISIBILITY_EVENT, isDesktop, shellVisible } from "./desktop";

/** AppKit hiding a window does not consistently update WebKit's Page Visibility API. */
export function useDesktopVisibility() {
  const [visible, setVisible] = useState(shellVisible);
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
