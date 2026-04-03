import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "../theme";

interface ScreenFrame {
  data: string;
  width: number;
  height: number;
  frameId: number;
}

interface ScreenViewProps {
  sessionId: string;
  active: boolean;
  mode: "webrtc" | "fallback" | "off";
  error?: string;
  screenFrame: ScreenFrame | null;
  onStart: (fps: number, quality: number, scale: number) => void;
  onStop: () => void;
}

export function ScreenView({
  sessionId,
  active,
  mode,
  error,
  screenFrame,
  onStart,
  onStop,
}: ScreenViewProps) {
  const { theme } = useTheme();
  const [fps, setFps] = useState(5);
  const [quality, setQuality] = useState(60);
  const [scale, setScale] = useState(0.5);
  const [paused, setPaused] = useState(false);
  const [displayFps, setDisplayFps] = useState(0);
  const frameCountRef = useRef(0);
  const lastFrameIdRef = useRef(-1);

  // FPS counter
  useEffect(() => {
    const timer = setInterval(() => {
      setDisplayFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Count frames
  useEffect(() => {
    if (screenFrame && screenFrame.frameId !== lastFrameIdRef.current) {
      lastFrameIdRef.current = screenFrame.frameId;
      frameCountRef.current++;
    }
  }, [screenFrame]);

  const handleStart = useCallback(() => {
    setPaused(false);
    onStart(fps, quality, scale);
  }, [fps, quality, scale, onStart]);

  const handleStop = useCallback(() => {
    setPaused(false);
    onStop();
  }, [onStop]);

  const handleTogglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  const cycleFps = useCallback(() => {
    const options = [2, 5, 10];
    const next = options[(options.indexOf(fps) + 1) % options.length] ?? 5;
    setFps(next);
    if (active) onStart(next, quality, scale);
  }, [fps, quality, scale, active, onStart]);

  const cycleQuality = useCallback(() => {
    const options = [40, 60, 80];
    const next = options[(options.indexOf(quality) + 1) % options.length] ?? 60;
    setQuality(next);
    if (active) onStart(fps, next, scale);
  }, [fps, quality, scale, active, onStart]);

  const isOff = mode === "off" || !active;
  const hasError = Boolean(error);
  const showFrame = screenFrame && !isOff && !paused;

  return (
    <View style={[styles.container, { backgroundColor: theme.bgTerminal }]}>
      {showFrame ? (
        <Image
          source={{ uri: `data:image/jpeg;base64,${screenFrame.data}` }}
          style={styles.screenImage}
          resizeMode="contain"
        />
      ) : (
        <View style={styles.placeholder}>
          {hasError ? (
            <>
              <Text style={styles.placeholderIcon}>!</Text>
              <Text style={[styles.placeholderText, { color: theme.error }]}>{error}</Text>
            </>
          ) : paused ? (
            <>
              <Text style={styles.placeholderIcon}>||</Text>
              <Text style={[styles.placeholderText, { color: theme.textSecondary }]}>Paused</Text>
            </>
          ) : isOff ? (
            <>
              <Text style={styles.placeholderIcon}>🖥</Text>
              <Text style={[styles.placeholderText, { color: theme.textSecondary }]}>
                Tap Start to view desktop
              </Text>
              <Text style={[styles.placeholderHint, { color: theme.textTertiary }]}>
                CLI must be started with --screen flag
              </Text>
            </>
          ) : (
            <>
              <ActivityIndicator color={theme.accent} size="large" />
              <Text style={[styles.placeholderText, { color: theme.textSecondary }]}>
                Waiting for frames...
              </Text>
            </>
          )}
        </View>
      )}

      {/* Control bar */}
      <View style={[styles.controlBar, { backgroundColor: theme.bgElevated, borderTopColor: theme.border }]}>
        <View style={styles.controlLeft}>
          {isOff ? (
            <Pressable style={[styles.controlBtn, { backgroundColor: theme.accent }]} onPress={handleStart}>
              <Text style={[styles.controlBtnText, { color: theme.textInverse }]}>Start</Text>
            </Pressable>
          ) : (
            <>
              <Pressable style={[styles.controlBtn, { backgroundColor: theme.errorLight }]} onPress={handleStop}>
                <Text style={[styles.controlBtnText, { color: theme.error }]}>Stop</Text>
              </Pressable>
              <Pressable style={[styles.controlBtn, { backgroundColor: theme.bgInput }]} onPress={handleTogglePause}>
                <Text style={[styles.controlBtnText, { color: theme.text }]}>{paused ? "Resume" : "Pause"}</Text>
              </Pressable>
            </>
          )}
        </View>

        <View style={styles.controlRight}>
          {!isOff && (
            <Text style={[styles.fpsLabel, { color: theme.textTertiary }]}>
              {displayFps} fps
            </Text>
          )}
          <Pressable style={[styles.settingBtn, { backgroundColor: theme.bgInput }]} onPress={cycleFps}>
            <Text style={[styles.settingBtnText, { color: theme.textSecondary }]}>{fps}fps</Text>
          </Pressable>
          <Pressable style={[styles.settingBtn, { backgroundColor: theme.bgInput }]} onPress={cycleQuality}>
            <Text style={[styles.settingBtnText, { color: theme.textSecondary }]}>Q{quality}</Text>
          </Pressable>
          <View style={[styles.modeBadge, { backgroundColor: mode === "fallback" ? "rgba(251,191,36,0.15)" : theme.bgInput }]}>
            <Text style={[styles.modeBadgeText, { color: mode === "fallback" ? "#fbbf24" : theme.textTertiary }]}>
              {mode === "off" ? "OFF" : mode === "fallback" ? "IMG" : "RTC"}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  screenImage: { flex: 1, width: "100%" },
  placeholder: {
    flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 40,
  },
  placeholderIcon: { fontSize: 48 },
  placeholderText: { fontSize: 15, fontWeight: "600", textAlign: "center" },
  placeholderHint: { fontSize: 13, textAlign: "center" },
  controlBar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, gap: 8,
  },
  controlLeft: { flexDirection: "row", gap: 6 },
  controlRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  controlBtn: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  controlBtnText: { fontSize: 13, fontWeight: "700" },
  fpsLabel: { fontSize: 11, fontWeight: "600", marginRight: 4 },
  settingBtn: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  settingBtnText: { fontSize: 11, fontWeight: "600" },
  modeBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  modeBadgeText: { fontSize: 10, fontWeight: "700" },
});
