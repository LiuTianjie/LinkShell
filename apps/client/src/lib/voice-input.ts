import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { cancelNativeSpeech, hasNativeSpeechSupport, startNativeSpeech, stopNativeSpeech, subscribeNativeSpeech } from "../../modules/link-layout";
import { haptics } from "./haptics";
import { VoiceSession, type VoicePhase } from "./voice-session";
export { mergeVoiceTranscript } from "./voice-session";

export const VOICE_WAVE_BAR_COUNT = 22;

/** Normalize iOS dBFS readings; Android supplies an already normalized RMS level. */
export function normalizeDecibels(db: number | null | undefined): number {
  if (typeof db !== "number" || !Number.isFinite(db)) return 0.08;
  return Math.max(0.08, Math.min(1, (Math.max(-56, Math.min(0, db)) + 56) / 50));
}

export interface UseVoiceInputOptions {
  currentText: string;
  onChangeText: (next: string) => void;
  onSendAfterStop?: (finalText: string) => void;
  onError?: (message: string) => void;
}

export interface VoiceInputController {
  recording: boolean;
  processing: boolean;
  canceling: boolean;
  elapsedSeconds: number;
  levels: number[];
  partialText: string;
  setCanceling: (canceling: boolean) => void;
  start: () => Promise<boolean>;
  stop: (sendImmediately?: boolean) => Promise<string | null>;
  cancel: () => Promise<void>;
}

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInputController {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [canceling, setCanceling] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [partialText, setPartialText] = useState("");
  const [levels, setLevels] = useState<number[]>(() => Array(VOICE_WAVE_BAR_COUNT).fill(0.08));
  const mounted = useRef(true);
  const [session] = useState(() => new VoiceSession({
    available: hasNativeSpeechSupport,
    start: async (isCurrent) => {
      if (Platform.OS === "android") {
        // Ask only on an explicit voice action; SpeechRecognizer owns the microphone.
        const { AudioModule } = await import("expo-audio");
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) return { ok: false, reason: "请在系统设置中允许 LinkShell 使用麦克风" };
        if (!isCurrent() || !mounted.current || AppState.currentState !== "active") return { ok: false };
      }
      return startNativeSpeech();
    },
    stop: stopNativeSpeech,
    cancel: cancelNativeSpeech,
    subscribe: subscribeNativeSpeech,
  }, {
    phase: (next) => { if (mounted.current) setPhase(next); },
    text: (merged, transcript) => {
      if (!mounted.current) return;
      setPartialText(transcript);
      callbacks.current.onChangeText(merged);
    },
    level: ({ level, db }) => {
      if (!mounted.current) return;
      const value = Number.isFinite(level) ? Math.max(0.08, Math.min(1, level)) : normalizeDecibels(db);
      setLevels((old) => [...old.slice(1), value]);
    },
    error: (message) => {
      if (!mounted.current) return;
      haptics.error();
      callbacks.current.onError?.(message);
    },
    send: (text) => { if (mounted.current) callbacks.current.onSendAfterStop?.(text); },
  }));

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void session.cancel(false);
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      void session.cancel(false);
    };
  }, [session]);

  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, [phase]);

  const start = useCallback(async () => {
    if (session.phase !== "idle") return false;
    setPartialText(""); setCanceling(false); setElapsedSeconds(0);
    setLevels(Array(VOICE_WAVE_BAR_COUNT).fill(0.08));
    const started = await session.start(callbacks.current.currentText);
    if (started) haptics.medium();
    return started;
  }, [session]);
  const stop = useCallback(async (send = false) => {
    setCanceling(false);
    return session.stop(send);
  }, [session]);
  const cancel = useCallback(async () => {
    setCanceling(false);
    await session.cancel();
  }, [session]);

  return { recording: phase !== "idle", processing: phase === "starting" || phase === "stopping", canceling, elapsedSeconds, levels, partialText, setCanceling, start, stop, cancel };
}
