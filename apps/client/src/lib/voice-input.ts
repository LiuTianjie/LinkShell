import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  cancelNativeSpeech,
  hasNativeSpeechSupport,
  startNativeSpeech,
  stopNativeSpeech,
  subscribeNativeSpeech,
} from "../../modules/link-layout";
import { haptics } from "./haptics";

export const VOICE_WAVE_BAR_COUNT = 22;

/** Normalize a dBFS reading (-60..0) into a 0.08..1.0 bar height. */
export function normalizeDecibels(db: number | null | undefined): number {
  if (typeof db !== "number" || !Number.isFinite(db)) return 0.08;
  const clamped = Math.max(-56, Math.min(0, db));
  return Math.max(0.08, Math.min(1, (clamped + 56) / 50));
}

/** Merge a newly recognized speech segment onto the existing composer draft text. */
export function mergeVoiceTranscript(prefix: string, transcript: string): string {
  const cleanPrefix = prefix.trimEnd();
  const cleanSpeech = transcript.trim();
  if (!cleanSpeech) return prefix;
  if (!cleanPrefix) return cleanSpeech;
  const needsSpace = /[a-zA-Z0-9]$/.test(cleanPrefix) && /^[a-zA-Z0-9]/.test(cleanSpeech);
  return `${cleanPrefix}${needsSpace ? " " : "，"}${cleanSpeech}`;
}

interface LazyAudioRecorder {
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  getStatus: () => { metering?: number };
}

/**
 * Lazy `expo-audio` recorder wrapper for non-iOS platforms so constructing a
 * Composer never instantiates a native `AudioRecorder` or requires `ExpoAudio` on mount.
 */
async function releaseAudioSessionQuietly(): Promise<void> {
  try {
    const expoAudio = await import("expo-audio");
    await expoAudio.setAudioModeAsync({ allowsRecording: false });
    await expoAudio.setIsAudioActiveAsync(false);
  } catch {
    // Best-effort cleanup so background music resumes.
  }
}

export interface UseVoiceInputOptions {
  /** Current text in the input before recording starts. */
  currentText: string;
  /** Updates the text in real time as speech is recognized. */
  onChangeText: (next: string) => void;
  /** Optional callback when the user taps "直接发送" from the voice bar. */
  onSendAfterStop?: (finalText: string) => void;
  onError?: (message: string) => void;
}

export interface VoiceInputController {
  recording: boolean;
  canceling: boolean;
  elapsedSeconds: number;
  levels: number[];
  partialText: string;
  setCanceling: (canceling: boolean) => void;
  start: () => Promise<boolean>;
  stop: (sendImmediately?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
}

export function useVoiceInput({
  currentText,
  onChangeText,
  onSendAfterStop,
  onError,
}: UseVoiceInputOptions): VoiceInputController {
  const [recording, setRecording] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [partialText, setPartialText] = useState("");
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => 0.1));

  const prefixRef = useRef(currentText);
  const latestTranscriptRef = useRef("");
  const onChangeTextRef = useRef(onChangeText);
  const onSendAfterStopRef = useRef(onSendAfterStop);
  const onErrorRef = useRef(onError);
  onChangeTextRef.current = onChangeText;
  onSendAfterStopRef.current = onSendAfterStop;
  onErrorRef.current = onError;

  const activeRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubNativeRef = useRef<(() => void) | null>(null);
  // Lazily created only on Android / fallback when recording actually starts.
  const lazyRecorderRef = useRef<LazyAudioRecorder | null>(null);

  const clearTimersAndListeners = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (unsubNativeRef.current) {
      unsubNativeRef.current();
      unsubNativeRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimersAndListeners();
      if (activeRef.current) {
        activeRef.current = false;
        if (Platform.OS === "ios") {
          void cancelNativeSpeech();
        } else {
          try {
            void lazyRecorderRef.current?.stop();
          } catch {
            // Ignore unmount stop errors.
          }
          void releaseAudioSessionQuietly();
        }
      }
    };
  }, [clearTimersAndListeners]);

  const pushLevel = useCallback((level: number) => {
    const clamped = Math.max(0.08, Math.min(1, level));
    setLevels((prev) => [...prev.slice(1), clamped]);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (activeRef.current) return true;
    prefixRef.current = currentText;
    latestTranscriptRef.current = "";
    setPartialText("");
    setCanceling(false);
    setElapsedSeconds(0);
    setLevels(Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => 0.12));

    if (Platform.OS === "ios") {
      if (hasNativeSpeechSupport()) {
        unsubNativeRef.current = subscribeNativeSpeech({
          onResult: ({ text }) => {
            if (!activeRef.current) return;
            latestTranscriptRef.current = text;
            setPartialText(text);
            const merged = mergeVoiceTranscript(prefixRef.current, text);
            onChangeTextRef.current(merged);
          },
          onLevel: ({ level, db }) => {
            if (!activeRef.current) return;
            pushLevel(typeof level === "number" ? level : normalizeDecibels(db));
          },
          onError: () => {
            // Recognition task completion or silence timeout is normal when stopping.
          },
        });

        const res = await startNativeSpeech();
        if (!res.ok) {
          clearTimersAndListeners();
          haptics.error();
          onErrorRef.current?.(res.reason ?? "无法启动语音输入");
          return false;
        }
      }

      activeRef.current = true;
      setRecording(true);
      haptics.medium();
      const startedAt = Date.now();
      let tick = 0;
      timerRef.current = setInterval(() => {
        tick += 1;
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
        if (!hasNativeSpeechSupport()) {
          const wave = 0.22 + 0.35 * Math.abs(Math.sin(tick * 0.45)) + 0.18 * Math.abs(Math.cos(tick * 0.8));
          pushLevel(wave);
        }
      }, 100);
      return true;
    }

    // Android / fallback: lazy AudioRecorder initialization on demand.
    try {
      const expoAudio = await import("expo-audio");
      const perm = await expoAudio.AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        haptics.error();
        onErrorRef.current?.("请在系统设置中允许 LinkShell 使用麦克风");
        return false;
      }
      await expoAudio.setIsAudioActiveAsync(true);
      await expoAudio.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      if (!lazyRecorderRef.current) {
        lazyRecorderRef.current = new expoAudio.AudioModule.AudioRecorder({
          ...expoAudio.RecordingPresets.HIGH_QUALITY,
          isMeteringEnabled: true,
        });
      }
      await lazyRecorderRef.current.prepareToRecordAsync();
      lazyRecorderRef.current.record();
      activeRef.current = true;
      setRecording(true);
      haptics.medium();
      const startedAt = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
        const status = lazyRecorderRef.current?.getStatus();
        pushLevel(normalizeDecibels(status?.metering));
      }, 90);
      return true;
    } catch (error) {
      await releaseAudioSessionQuietly();
      haptics.error();
      onErrorRef.current?.(error instanceof Error ? error.message : "无法启动麦克风");
      return false;
    }
  }, [clearTimersAndListeners, currentText, pushLevel]);

  const stop = useCallback(
    async (sendImmediately = false) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      clearTimersAndListeners();
      setRecording(false);
      setCanceling(false);
      haptics.light();

      if (Platform.OS === "ios") {
        await stopNativeSpeech();
      } else {
        try {
          await lazyRecorderRef.current?.stop();
        } catch {
          // Ignore stop errors.
        } finally {
          await releaseAudioSessionQuietly();
        }
      }

      const finalMerged = mergeVoiceTranscript(prefixRef.current, latestTranscriptRef.current);
      if (latestTranscriptRef.current.trim()) {
        onChangeTextRef.current(finalMerged);
      }
      if (sendImmediately && finalMerged.trim()) {
        onSendAfterStopRef.current?.(finalMerged);
      }
    },
    [clearTimersAndListeners],
  );

  const cancel = useCallback(async () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearTimersAndListeners();
    setRecording(false);
    setCanceling(false);
    setPartialText("");
    haptics.selection();

    // Restore the text that was in the draft before voice recording began.
    onChangeTextRef.current(prefixRef.current);

    if (Platform.OS === "ios") {
      await cancelNativeSpeech();
    } else {
      try {
        await lazyRecorderRef.current?.stop();
      } catch {
        // Ignore stop errors.
      } finally {
        await releaseAudioSessionQuietly();
      }
    }
  }, [clearTimersAndListeners]);

  return {
    recording,
    canceling,
    elapsedSeconds,
    levels,
    partialText,
    setCanceling,
    start,
    stop,
    cancel,
  };
}
