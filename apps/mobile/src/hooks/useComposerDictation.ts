import { useEffect, useRef, useState } from "react";
import { PanResponder } from "react-native";
import * as Haptics from "expo-haptics";
import { useVoiceInput } from "./useVoiceInput";

// Drag the mic up past this many points (negative dy) to discard the dictation
// instead of inserting it — mirrors the terminal VoiceBar's slide-to-cancel.
const CANCEL_THRESHOLD = -70;

export interface ComposerDictation {
  /** True while the user is holding the mic button. */
  pressing: boolean;
  /** True when the finger has slid into the "release to cancel" zone. */
  inCancelZone: boolean;
  /** Live partial transcript to show while listening. */
  liveText: string;
  /** Whether on-device speech recognition is available at all. */
  available: boolean;
  /** Spread onto the mic button to drive press-and-hold dictation. */
  panHandlers: ReturnType<typeof PanResponder.create>["panHandlers"];
}

/**
 * Press-and-hold dictation for a text composer. Holds to listen, slide up to
 * cancel, release to insert the recognized text via `onInsert`. Reuses the
 * same `useVoiceInput` engine and gesture model the terminal screen already
 * ships, but inserts into a draft instead of sending immediately.
 */
export function useComposerDictation(
  onInsert: (text: string) => void,
  locale: "zh-CN" | "en-US" = "zh-CN",
): ComposerDictation {
  const { isAvailable, partialText, finalText, start, stop, cancel } = useVoiceInput();
  const [pressing, setPressing] = useState(false);
  const [inCancelZone, setInCancelZone] = useState(false);
  const [waitingForResult, setWaitingForResult] = useState(false);
  // Latest values captured for the PanResponder closure (created once).
  const partialRef = useRef("");
  const finalRef = useRef("");
  const onInsertRef = useRef(onInsert);
  const localeRef = useRef(locale);

  useEffect(() => {
    onInsertRef.current = onInsert;
  }, [onInsert]);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  useEffect(() => {
    partialRef.current = partialText;
  }, [partialText]);
  useEffect(() => {
    finalRef.current = finalText;
  }, [finalText]);

  // Some engines (notably Android) deliver the final transcript a beat after
  // stop(); when we released without any text yet, insert it once it lands.
  useEffect(() => {
    if (!waitingForResult || !finalText.trim()) return;
    setWaitingForResult(false);
    onInsertRef.current(finalText.trim());
  }, [finalText, waitingForResult]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        setPressing(true);
        setInCancelZone(false);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        start(localeRef.current).catch(() => {});
      },
      onPanResponderMove: (_evt, gestureState) => {
        setInCancelZone(gestureState.dy < CANCEL_THRESHOLD);
      },
      onPanResponderRelease: (_evt, gestureState) => {
        setPressing(false);
        setInCancelZone(false);
        if (gestureState.dy < CANCEL_THRESHOLD) {
          cancel();
          setWaitingForResult(false);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
          return;
        }
        const captured = finalRef.current || partialRef.current;
        if (captured.trim()) {
          cancel();
          setWaitingForResult(false);
          onInsertRef.current(captured.trim());
        } else {
          // No text captured yet — stop gracefully and wait for the late final.
          stop();
          setWaitingForResult(true);
        }
      },
      onPanResponderTerminate: () => {
        setPressing(false);
        setInCancelZone(false);
        cancel();
      },
    }),
  ).current;

  return {
    pressing,
    inCancelZone,
    liveText: pressing ? partialText : "",
    available: isAvailable,
    panHandlers: panResponder.panHandlers,
  };
}
