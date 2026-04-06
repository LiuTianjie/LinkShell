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
      if (mounted.current) setIsListening(false);
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
      if (mounted.current) {
        setIsListening(false);
        setError(e.error?.message ?? "Speech recognition error");
      }
    };

    return () => {
      mounted.current = false;
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, []);

  const start = useCallback(async (locale = "en-US") => {
    setPartialText("");
    setFinalText("");
    setError(null);
    await Voice.start(locale);
  }, []);

  const stop = useCallback(async () => {
    await Voice.stop();
  }, []);

  const cancel = useCallback(async () => {
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
