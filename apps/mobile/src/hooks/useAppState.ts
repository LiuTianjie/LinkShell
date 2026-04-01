import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";

export function useAppState(onForeground: () => void, onBackground: () => void): void {
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && nextState === "active") {
        onForeground();
      } else if (appState.current === "active" && nextState.match(/inactive|background/)) {
        onBackground();
      }
      appState.current = nextState;
    });
    return () => sub.remove();
  }, [onForeground, onBackground]);
}
