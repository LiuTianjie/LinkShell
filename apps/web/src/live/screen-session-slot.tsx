import { useEffect, useState, type ReactNode } from "react";
import { isDesktop } from "./desktop";

export const SCREEN_RETAIN_MS = 120_000;

/** Keep the iframe in the same DOM parent while another workspace page is open. */
export function ScreenSessionSlot({
  activeKey,
  selectedKey,
  enabled = true,
  children,
}: {
  activeKey?: string;
  selectedKey?: string;
  enabled?: boolean;
  children: (key: string, active: boolean) => ReactNode;
}) {
  const [retained, setRetained] = useState(activeKey);
  // In the desktop app WebKit reports the page hidden while its window goes in or out of full
  // screen (about half a second): following that unmounted the screen mid-transition, and its
  // cleanup cancelled the full screen it had just asked for. The app says when the window is
  // really hidden (`enabled`, from its own visibility).
  const [visible, setVisible] = useState(() => isDesktop || !document.hidden);
  useEffect(() => {
    if (isDesktop) return;
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!enabled || !visible) {
      setRetained(undefined);
      return;
    }
    if (activeKey) {
      setRetained(activeKey);
      return;
    }
    if (retained && retained !== selectedKey) {
      setRetained(undefined);
      return;
    }
    if (!retained) return;
    const timer = window.setTimeout(() => setRetained(undefined), SCREEN_RETAIN_MS);
    return () => window.clearTimeout(timer);
  }, [activeKey, selectedKey, retained, enabled, visible]);
  const key = enabled && visible
    ? activeKey ?? (retained === selectedKey ? retained : undefined)
    : undefined;
  if (!key) return null;
  const active = key === activeKey;
  return (
    <div key={key} hidden={!active} className={active ? "contents" : undefined}>
      {children(key, active)}
    </div>
  );
}
