import { useRef, useState } from "react";
import { ActivityIndicator, ScrollView, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { PressableScale } from "@/components/pressable-scale";
import { Text } from "@/components/fixed-text";
import { type } from "@/theme/type";
import type { ScreenMode, ScreenShortcut, ScreenWidth } from "@/lib/settings";
import { NativeScreen, type NativeScreenHandle, type ScreenMetrics, type ScreenState } from "../../modules/link-screen";

interface Props {
  url: string;
  mode: ScreenMode;
  onMode: (mode: ScreenMode) => void;
  width: ScreenWidth;
  onWidth: (width: ScreenWidth) => void;
  shortcuts: ScreenShortcut[];
  fullscreen: boolean;
  onFullscreen: () => void;
  canRotate: boolean;
  onRotate: () => void;
  onCompatibility: () => void;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// This surface is always black, even while the surrounding app uses its light appearance.
function Button({ title, onPress, variant = "tonal", disabled = false }: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "tonal";
  disabled?: boolean;
  size?: "small";
}) {
  return <PressableScale onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title}
    accessibilityState={{ disabled }} outerStyle={{ flexShrink: 0 }}>
    <View style={{ minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, justifyContent: "center", borderRadius: 16, borderCurve: "continuous", backgroundColor: variant === "primary" ? "#4169ff" : "#242428", opacity: disabled ? 0.45 : 1 }}>
      <Text style={{ ...type.footnote, color: "#ffffff" }}>{title}</Text>
    </View>
  </PressableScale>;
}

/** UI commands cross into native occasionally; gestures, packets and frames stay in native. */
export function NativeScreenPane(props: Props) {
  const screen = useRef<NativeScreenHandle>(null);
  const [state, setState] = useState<ScreenState>({ state: "connecting" });
  const [trusted, setTrusted] = useState(false);
  const [permission, setPermission] = useState("");
  const [diagnostics, setDiagnostics] = useState(false);
  const [maxFps, setMaxFps] = useState<60 | 120>(60);
  const [metrics, setMetrics] = useState<ScreenMetrics | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [draft, setDraft] = useState("");
  const [attempt, setAttempt] = useState(0);
  const receive = (next: ScreenState) => {
    if (next.state === "control") { setTrusted(next.trusted === true); setPermission(next.message ?? ""); }
    else { setState(next); if (next.state === "connecting") { setTrusted(false); setMetrics(null); } }
  };
  const send = async () => {
    if (!draft || !trusted) return;
    try {
      if (!screen.current) throw new Error("控制连接尚未就绪");
      await screen.current.sendText(draft);
      setDraft("");
    } catch { setPermission("控制连接尚未就绪，文字已保留"); setTrusted(false); }
  };
  const textStyle = { ...type.caption, color: "rgba(255,255,255,0.65)" };
  return (
    <View style={{ flex: 1, paddingTop: props.top, paddingBottom: props.bottom, paddingLeft: props.left, paddingRight: props.right }}>
      <View style={{ flex: 1, minHeight: 80 }}>
        <NativeScreen key={`${props.url}:${attempt}:${diagnostics}`} ref={screen} url={props.url} mode={props.mode} maxFps={maxFps} diagnostics={diagnostics} onState={receive} onMetrics={setMetrics} style={{ flex: 1 }} />
        {state.state === "connecting" ? <View pointerEvents="none" style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", gap: 10 }}><ActivityIndicator color="#fff" /><Text style={textStyle}>正在连接屏幕…</Text></View> : null}
        {state.state === "failed" ? (
          <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", padding: 24, gap: 12, backgroundColor: "#000" }}>
            <Text style={{ ...textStyle, textAlign: "center" }}>{state.message}</Text>
            <Button title="重试" size="small" variant="tonal" onPress={() => setAttempt((value) => value + 1)} />
            <Button title="使用兼容模式" size="small" variant="tonal" onPress={props.onCompatibility} />
          </View>
        ) : null}
      </View>
      {props.mode !== "view" && !trusted && permission ? (
        <View style={{ padding: 10, gap: 6 }}>
          <Text style={textStyle}>{permission}</Text>
          <Button title="在电脑上打开权限设置" size="small" variant="tonal" onPress={() => void screen.current?.requestPermission()} />
        </View>
      ) : null}
      {diagnostics ? (
        <View style={{ paddingHorizontal: 12, paddingVertical: 6, gap: 2 }}>
          <Text style={textStyle}>诊断抽样 · 切换会重连 · 每 5 秒更新 · 性能仅作诊断参考</Text>
          {metrics ? <Text style={textStyle}>{[
            metrics.decodedFps == null ? null : `${Math.round(metrics.decodedFps)} 解码帧/秒`,
            metrics.sender?.frameRate == null ? null : `${Math.round(metrics.sender.frameRate)} 发送帧/秒`,
            metrics.sender?.encodeMs == null ? null : `编码 ${metrics.sender.encodeMs.toFixed(1)} ms`,
            metrics.rttMs == null ? null : `往返 ${metrics.rttMs.toFixed(1)} ms`,
            metrics.decodeP95Ms == null ? null : `解码 p95 ${metrics.decodeP95Ms.toFixed(1)} ms`,
            metrics.decodeToPresentP95Ms == null ? null : `解码后到显示 p95 ${metrics.decodeToPresentP95Ms.toFixed(1)} ms`,
            metrics.decodeSamples == null ? null : `解码样本 ${metrics.decodeSamples} 帧`,
          ].filter(Boolean).join(" · ")}</Text> : null}
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 8, gap: 6, alignItems: "center" }}>
        {(["view", "trackpad", "touch"] as const).map((mode) => <Button key={mode} title={{ view: "观看", trackpad: "触控板", touch: "触摸" }[mode]} size="small" variant={props.mode === mode ? "primary" : "tonal"} onPress={() => props.onMode(mode)} />)}
        <Button title="适应屏幕" size="small" variant="tonal" onPress={() => void screen.current?.fit()} />
        <Button title={keyboard ? "收起键盘" : "键盘"} size="small" variant="tonal" onPress={() => { if (props.mode === "view") props.onMode("trackpad"); setKeyboard((value) => !value); }} />
        <Button title={props.fullscreen ? "退出全屏" : "全屏"} size="small" variant="tonal" onPress={props.onFullscreen} />
        {props.canRotate ? <Button title="旋转" size="small" variant="tonal" onPress={props.onRotate} /> : null}
        <Button title={diagnostics ? "关闭诊断" : "诊断信息"} size="small" variant="tonal" onPress={() => setDiagnostics((value) => !value)} />
        <Button title="兼容模式" size="small" variant="tonal" onPress={props.onCompatibility} />
      </ScrollView>
      {keyboard ? <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 8, gap: 6 }}>
          {[{ name: "Esc", k: "escape", m: [] }, { name: "Tab", k: "tab", m: [] }, { name: "⌘C", k: "c", m: ["cmd"] }, { name: "⌘V", k: "v", m: ["cmd"] }, { name: "←", k: "left", m: [] }, { name: "↑", k: "up", m: [] }, { name: "↓", k: "down", m: [] }, { name: "→", k: "right", m: [] }, { name: "退格", k: "backspace", m: [] }, { name: "回车", k: "return", m: [] }, ...props.shortcuts].map((shortcut, index) => (
            <Button key={`${shortcut.name}:${index}`} title={shortcut.name} size="small" variant="tonal" disabled={!trusted} onPress={() => void screen.current?.sendKey(shortcut.k, shortcut.m)} />
          ))}
        </ScrollView>
        <View style={{ padding: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextInput value={draft} onChangeText={setDraft} autoFocus multiline placeholder="输入文字后发送到电脑" placeholderTextColor="#888" maxLength={20_000} style={{ flex: 1, minHeight: 40, maxHeight: 100, padding: 10, borderRadius: 12, backgroundColor: "#222", color: "#fff" }} />
          <Button title="粘贴" size="small" variant="tonal" onPress={() => void Clipboard.getStringAsync().then((text) => setDraft(text.slice(0, 20_000))).catch(() => {})} />
          <Button title="发送" size="small" disabled={!trusted || !draft} onPress={() => void send()} />
        </View>
      </> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 6, gap: 6 }}>
        {([60, 120] as const).map((fps) => <Button key={fps} title={`${fps} 帧上限`} size="small" variant={maxFps === fps ? "primary" : "tonal"} onPress={() => setMaxFps(fps)} />)}
        {(["1280", "1920", "2560", "native"] as const).map((width) => <Button key={width} title={width === "native" ? "原始尺寸" : width} size="small" variant={props.width === width ? "primary" : "tonal"} onPress={() => props.onWidth(width)} />)}
      </ScrollView>
    </View>
  );
}
