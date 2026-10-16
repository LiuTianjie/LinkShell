import { router, useRootNavigationState } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { pendingNativeLiveActivityActionId, subscribeNativeLiveActivityActions } from "../../modules/link-layout";

/** Intent execution can precede the JS runtime on a cold launch. */
export function LiveActivityActionNavigation() {
  const navigation = useRootNavigationState();
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!navigation?.key) return;
    let disposed = false;
    const open = ({ id }: { id: string }) => {
      if (disposed || shown.current === id) return;
      shown.current = id;
      router.push({ pathname: "/activity", params: { action: id } });
    };
    const check = () => { void pendingNativeLiveActivityActionId().then((id) => { if (id) open({ id }); }).catch(() => {}); };
    const off = subscribeNativeLiveActivityActions(open);
    const state = AppState.addEventListener("change", (next) => { if (next === "active") check(); });
    check();
    return () => { disposed = true; off(); state.remove(); };
  }, [navigation?.key]);
  return null;
}
