import { useCallback, useEffect, useRef, useState } from "react";
import Voice, {
  SpeechErrorEvent,
  SpeechResultsEvent,
} from "@react-native-voice/voice";

export interface UseVoiceInputReturn {
  isListening: boolean;
  isAvailable: boolean;
  partialText: string;
  finalText: string;
  error: string | null;
  start: (locale?: string) => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [isListening, setIsListening] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [partialText, setPartialText] = useState("");
  const [finalText, setFinalText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const localeRef = useRef("en-US");
  const activeRef = useRef(false); // whether voice mode is active (should auto-restart)

  const restartListening = useCallback(() => {
    if (!mounted.current || !activeRef.current) return;
    setTimeout(() => {
      if (mounted.current && activeRef.current) {
        Voice.start(localeRef.current).catch(() => {});
      }
    }, 300);
  }, []);

  useEffect(() => {
    mounted.current = true;

    Voice.isAvailable().then((available) => {
      if (mounted.current) setIsAvailable(!!available);
    });

    Voice.onSpeechStart = () => {
      if (mounted.current) {
        setIsListening(true);
        setError(null);
      }
    };

    Voice.onSpeechEnd = () => {
      if (mounted.current) {
        setIsListening(false);
        // Auto-restart if voice mode is still active
        restartListening();
      }
    };

    Voice.onSpeechPartialResults = (e: SpeechResultsEvent) => {
      if (mounted.current && e.value?.[0]) {
        setPartialText(e.value[0]);
      }
    };

    Voice.onSpeechResults = (e: SpeechResultsEvent) => {
      if (mounted.current && e.value?.[0]) {
        setFinalText(e.value[0]);
        setPartialText("");
      }
    };

    Voice.onSpeechError = (e: SpeechErrorEvent) => {
      if (!mounted.current) return;
      setIsListening(false);
      // "no speech" / "speech not detected" — just silently restart
      const msg = e.error?.message ?? "";
      if (/no.?speech|not.?detected|no.?match/i.test(msg)) {
        restartListening();
      } else {
        setError(msg || "Speech recognition error");
        // Still try to restart after a real error
        restartListening();
      }
    };

    return () => {
      mounted.current = false;
      activeRef.current = false;
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, [restartListening]);

  const start = useCallback(async (locale = "en-US") => {
    localeRef.current = locale;
    activeRef.current = true;
    setPartialText("");
    setFinalText("");
    setError(null);
    await Voice.start(locale);
  }, []);

  const stop = useCallback(async () => {
    activeRef.current = false;
    await Voice.stop();
  }, []);

  const cancel = useCallback(async () => {
    activeRef.current = false;
    await Voice.cancel();
    setPartialText("");
    setFinalText("");
    setIsListening(false);
  }, []);

  return {
    isListening,
    isAvailable,
    partialText,
    finalText,
    error,
    start,
    stop,
    cancel,
  };
}
