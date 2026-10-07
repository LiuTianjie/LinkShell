import { ComputerPreviewSubscription } from "@linkshell/client-core";
import type { PreviewFrameInfo } from "@linkshell/wire";
import Storage from "expo-sqlite/kv-store";
import { Buffer } from "buffer";
import { createContext, use, useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { create } from "zustand";
import { useConnection } from "./client";

export const ComputerPreviewVisible = createContext(true);

type Mode = "shown" | "collapsed" | "hidden";
interface Picture extends PreviewFrameInfo { uri: string }
const pictures = create<{ frames: Record<string, Picture> }>(() => ({ frames: {} }));
const modes = create<{ entries: Record<string, Mode> }>(() => ({ entries: {} }));
const persistedModes = new Map<string, Mode>();
const storageKey = (key: string) => `computer-preview-mode:${key}`;
function readMode(key: string): Mode {
  const cached = persistedModes.get(key);
  if (cached) return cached;
  let mode: Mode = "shown";
  try { const value = Storage.getItemSync(storageKey(key)); if (value === "hidden" || value === "collapsed") mode = value; } catch { /* Default to the picture. */ }
  persistedModes.set(key, mode);
  return mode;
}
export function setComputerPreviewMode(key: string, mode: Mode): void {
  persistedModes.set(key, mode);
  modes.setState(state => ({ entries: { ...state.entries, [key]: mode } }));
  try { Storage.setItemSync(storageKey(key), mode); } catch { /* The current process still remembers the choice. */ }
}
export function useComputerPreview(sessionId: string) {
  const { computer, link, streams } = useConnection();
  const visible = use(ComputerPreviewVisible);
  const key = JSON.stringify([computer.key, sessionId]);
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  const [active, setActive] = useState(AppState.currentState === "active");
  const frame = pictures(state => state.frames[key]);
  const mode = modes(state => state.entries[key] ?? readMode(key));
  useEffect(() => link.on("session.preview.show", event => {
    if (event.sessionId === sessionId) setComputerPreviewMode(key, "shown");
  }), [link, key, sessionId]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!visible || !focused || !active || mode !== "shown") return;
    const subscription = new ComputerPreviewSubscription(link, streams, sessionId, received => {
      const { bytes, ...info } = received;
      const uri = `data:${info.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      pictures.setState(state => {
        const frames = { ...state.frames, [key]: { ...info, uri } };
        const keys = Object.keys(frames);
        if (keys.length > 32) delete frames[keys.find(id => id !== key)!];
        return { frames };
      });
    }, pictures.getState().frames[key]?.id);
    return () => subscription.close();
  }, [key, sessionId, link, streams, visible, focused, active, mode]);
  return { frame, mode, setMode: (value: Mode) => setComputerPreviewMode(key, value) };
}
