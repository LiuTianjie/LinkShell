import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

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

    // Check availability
    const available = ExpoSpeechRecognitionModule.isRecognitionAvailable();
    if (mounted.current) setIsAvailable(available);

    // Event listeners
    const startSub = ExpoSpeechRecognitionModule.addListener("start", () => {
      if (mounted.current) {
        setIsListening(true);
        setError(null);
      }
    });

    const endSub = ExpoSpeechRecognitionModule.addListener("end", () => {
      if (mounted.current) {
        setIsListening(false);
      }
    });

    const resultSub = ExpoSpeechRecognitionModule.addListener("result", (event) => {
      if (!mounted.current) return;
      const transcript = event.results?.[0]?.transcript ?? "";
      if (event.isFinal) {
        setFinalText(transcript);
        setPartialText("");
      } else {
        setPartialText(transcript);
      }
    });

    const errorSub = ExpoSpeechRecognitionModule.addListener("error", (event) => {
      if (!mounted.current) return;
      setIsListening(false);
      // Silently ignore "no speech" errors
      if (event.error === "no-speech" || event.error === "speech-timeout") {
        return;
      }
      setError(event.message || event.error || "Speech recognition error");
    });

    return () => {
      mounted.current = false;
      startSub.remove();
      endSub.remove();
      resultSub.remove();
      errorSub.remove();
      ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  const start = useCallback(async (locale = "en-US") => {
    setPartialText("");
    setFinalText("");
    setError(null);
    // Request permissions if needed
    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      setError("Permission denied");
      return;
    }
    ExpoSpeechRecognitionModule.start({
      lang: locale,
      interimResults: true,
      ...(Platform.OS === "ios" ? { addsPunctuation: true } : {}),
      continuous: false,
    });
  }, []);

  const stop = useCallback(async () => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  const cancel = useCallback(async () => {
    ExpoSpeechRecognitionModule.abort();
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
