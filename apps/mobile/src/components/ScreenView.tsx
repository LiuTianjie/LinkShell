import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { WebView } from "react-native-webview";
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
  // WebRTC signaling from host
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }[];
  onStart: (fps: number, quality: number, scale: number) => void;
  onStop: () => void;
  onSignal: (type: "screen.answer" | "screen.ice", payload: any) => void;
}

const WEBRTC_PLAYER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#000}
video{width:100%;height:100%;object-fit:contain;background:#000}
</style>
</head>
<body>
<video id="v" autoplay playsinline muted></video>
<script>
var pc = null;
var video = document.getElementById('v');

function post(msg) {
  window.ReactNativeWebView.postMessage(JSON.stringify(msg));
}

async function handleOffer(sdp) {
  var config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };
  pc = new RTCPeerConnection(config);

  pc.ontrack = function(event) {
    video.srcObject = event.streams[0] || new MediaStream([event.track]);
  };

  pc.onicecandidate = function(event) {
    if (event.candidate) {
      post({
        type: 'ice',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      });
    }
  };

  pc.onconnectionstatechange = function() {
    post({ type: 'state', state: pc.connectionState });
  };

  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdp }));
  var answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  post({ type: 'answer', sdp: answer.sdp });
}

async function addIce(candidate, sdpMid, sdpMLineIndex) {
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate({
      candidate: candidate,
      sdpMid: sdpMid || '0',
      sdpMLineIndex: sdpMLineIndex || 0
    }));
  } catch(e) {}
}

function cleanup() {
  if (pc) { try { pc.close(); } catch(e) {} pc = null; }
  video.srcObject = null;
}

window.handleRNMessage = function(msg) {
  try {
    var p = JSON.parse(msg);
    if (p.type === 'offer') handleOffer(p.sdp);
    else if (p.type === 'ice') addIce(p.candidate, p.sdpMid, p.sdpMLineIndex);
    else if (p.type === 'close') cleanup();
  } catch(e) {}
};
</script>
</body>
</html>`;

export function ScreenView({
  sessionId,
  active,
  mode,
  error,
  screenFrame,
  pendingOffer,
  pendingIceCandidates,
  onStart,
  onStop,
  onSignal,
}: ScreenViewProps) {
  const { theme } = useTheme();
  const { width: winW, height: winH } = useWindowDimensions();
  const webViewRef = useRef<WebView>(null);
  const [fps, setFps] = useState(5);
  const [quality, setQuality] = useState(60);
  const [scale, setScale] = useState(0.5);
  const [paused, setPaused] = useState(false);
  const [displayFps, setDisplayFps] = useState(0);
  const [rtcState, setRtcState] = useState<string>("new");
  const [fullscreen, setFullscreen] = useState(false);
  const frameCountRef = useRef(0);
  const lastFrameIdRef = useRef(-1);
  const webViewReady = useRef(false);
  const pendingInjects = useRef<string[]>([]);
  const isLandscape = winW > winH;

  // FPS counter
  useEffect(() => {
    const timer = setInterval(() => {
      setDisplayFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Count fallback frames
  useEffect(() => {
    if (screenFrame && screenFrame.frameId !== lastFrameIdRef.current) {
      lastFrameIdRef.current = screenFrame.frameId;
      frameCountRef.current++;
    }
  }, [screenFrame]);

  // Safe inject: queues JS if WebView isn't loaded yet
  const safeInject = useCallback((js: string) => {
    if (webViewReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(js);
    } else {
      pendingInjects.current.push(js);
    }
  }, []);

  const handleWebViewLoad = useCallback(() => {
    webViewReady.current = true;
    for (const js of pendingInjects.current) {
      webViewRef.current?.injectJavaScript(js);
    }
    pendingInjects.current = [];
  }, []);

  // Reset readiness when WebView unmounts (mode switches away from webrtc)
  useEffect(() => {
    if (mode !== "webrtc") {
      webViewReady.current = false;
      pendingInjects.current = [];
    }
  }, [mode]);

  // Forward SDP offer to WebView
  useEffect(() => {
    if (pendingOffer && mode === "webrtc") {
      const js = `window.handleRNMessage(${JSON.stringify(JSON.stringify({ type: "offer", sdp: pendingOffer.sdp }))});true;`;
      safeInject(js);
    }
  }, [pendingOffer, mode, safeInject]);

  // Forward ICE candidates to WebView
  useEffect(() => {
    if (pendingIceCandidates.length > 0 && mode === "webrtc") {
      for (const ice of pendingIceCandidates) {
        const js = `window.handleRNMessage(${JSON.stringify(JSON.stringify({ type: "ice", ...ice }))});true;`;
        safeInject(js);
      }
    }
  }, [pendingIceCandidates, mode, safeInject]);

  const handleWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as any;
      if (msg.type === "answer") {
        onSignal("screen.answer", { sdp: msg.sdp });
      } else if (msg.type === "ice") {
        onSignal("screen.ice", {
          candidate: msg.candidate,
          sdpMid: msg.sdpMid,
          sdpMLineIndex: msg.sdpMLineIndex,
        });
      } else if (msg.type === "state") {
        setRtcState(msg.state);
      }
    } catch {}
  }, [onSignal]);

  const handleStart = useCallback(() => {
    setPaused(false);
    setRtcState("new");
    onStart(fps, quality, scale);
  }, [fps, quality, scale, onStart]);

  const handleStop = useCallback(() => {
    setPaused(false);
    webViewReady.current = false;
    pendingInjects.current = [];
    // Tell WebView to close RTCPeerConnection
    webViewRef.current?.injectJavaScript(`window.handleRNMessage('{"type":"close"}');true;`);
    setRtcState("new");
    onStop();
  }, [onStop]);

  const handleTogglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => !f);
  }, []);

  const isOff = mode === "off" || !active;

  // Auto-fullscreen in landscape when active
  useEffect(() => {
    if (isLandscape && active && !isOff) {
      setFullscreen(true);
    } else if (!isLandscape) {
      setFullscreen(false);
    }
  }, [isLandscape, active, isOff]);

  const cycleFps = useCallback(() => {
    const options = [2, 5, 10, 15, 30];
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

  const hasError = Boolean(error);
  const showFallbackFrame = screenFrame && mode === "fallback" && !paused;
  const showWebRTC = mode === "webrtc" && !isOff;

  return (
    <View style={[
      styles.container,
      { backgroundColor: theme.bgTerminal },
      fullscreen && { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 },
    ]}>
      {fullscreen && <StatusBar hidden />}
      {/* WebRTC video player (always mounted when active, hidden when fallback) */}
      {showWebRTC ? (
        <WebView
          ref={webViewRef}
          source={{ html: WEBRTC_PLAYER_HTML }}
          style={styles.videoView}
          originWhitelist={["*"]}
          javaScriptEnabled
          domStorageEnabled
          onMessage={handleWebViewMessage}
          onLoad={handleWebViewLoad}
          scrollEnabled={false}
          bounces={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mixedContentMode="always"
        />
      ) : showFallbackFrame ? (
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
              {mode === "fallback" && (
                <Pressable style={[styles.controlBtn, { backgroundColor: theme.bgInput }]} onPress={handleTogglePause}>
                  <Text style={[styles.controlBtnText, { color: theme.text }]}>{paused ? "Resume" : "Pause"}</Text>
                </Pressable>
              )}
            </>
          )}
        </View>

        <View style={styles.controlRight}>
          {!isOff && mode === "fallback" && (
            <Text style={[styles.fpsLabel, { color: theme.textTertiary }]}>
              {displayFps} fps
            </Text>
          )}
          {!isOff && mode === "webrtc" && (
            <Text style={[styles.fpsLabel, { color: rtcState === "connected" ? theme.success : theme.textTertiary }]}>
              {rtcState}
            </Text>
          )}
          <Pressable style={[styles.settingBtn, { backgroundColor: theme.bgInput }]} onPress={cycleFps}>
            <Text style={[styles.settingBtnText, { color: theme.textSecondary }]}>{fps}fps</Text>
          </Pressable>
          <Pressable style={[styles.settingBtn, { backgroundColor: theme.bgInput }]} onPress={cycleQuality}>
            <Text style={[styles.settingBtnText, { color: theme.textSecondary }]}>Q{quality}</Text>
          </Pressable>
          <View style={[styles.modeBadge, {
            backgroundColor: mode === "webrtc" ? "rgba(74,222,128,0.15)" : mode === "fallback" ? "rgba(251,191,36,0.15)" : theme.bgInput,
          }]}>
            <Text style={[styles.modeBadgeText, {
              color: mode === "webrtc" ? "#4ade80" : mode === "fallback" ? "#fbbf24" : theme.textTertiary,
            }]}>
              {mode === "off" ? "OFF" : mode === "fallback" ? "IMG" : "RTC"}
            </Text>
          </View>
          {!isOff && (
            <Pressable style={[styles.settingBtn, { backgroundColor: fullscreen ? theme.accent : theme.bgInput }]} onPress={toggleFullscreen}>
              <Text style={[styles.settingBtnText, { color: fullscreen ? theme.textInverse : theme.textSecondary }]}>
                {fullscreen ? "Exit" : "Full"}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  videoView: { flex: 1, backgroundColor: "#000" },
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
