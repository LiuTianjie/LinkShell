import { ComputerPreviewVisible } from "@/lib/use-computer-preview";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Text, TextInput } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { ChangesContent } from "@/screens/changes-screen";
import { PreviewContent } from "@/screens/preview-screen";
import { ConsumedTopInset, usePageInsets } from "./adaptive-page";
import { MountedMotionPane, type PaneFrame } from "./mounted-motion-pane";
import { usePorts } from "@/lib/ports";
import { useClient } from "@/lib/client";
import { useLayoutGeometry } from "@/lib/use-layout-geometry";
import { workspaceLayout } from "@/lib/workspace-layout";
import { homeNavigationLayout } from "@/lib/home-layout";
import { SessionFoldLayoutContext } from "@/lib/session-fold-layout";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Icon } from "./icon";
import { Button } from "./button";
import { PortRow } from "./port-row";
import { positionOf } from "./session-row";
import { haptics } from "@/lib/haptics";
import { LayoutProbe } from "../../modules/link-layout";

type Panel = "changes" | "preview";
const Workspace = createContext<{ split: boolean; show: (panel: Panel) => void } | null>(null);
export const useSessionWorkspace = () => use(Workspace);

/** The conversation and browser stay mounted while the window folds or resizes. */
export function SessionWorkspace({ sessionId, initialPanel, children }: { sessionId: string; initialPanel?: Panel; children: ReactNode }) {
  const window = useWindowDimensions();
  const geometry = useLayoutGeometry();
  const { width, height } = geometry.frame;
  const regions = geometry.metrics?.divisions ?? [];
  const { split, folded, gap, axis, before, after } = workspaceLayout(width, window.fontScale, regions, height);
  const [panel, setPanel] = useState<Panel>(initialPanel ?? "changes");
  const [toolsOpen, setToolsOpen] = useState(!!initialPanel);
  const insets = usePageInsets();
  const systemInsets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const laptop = folded && axis === "column";
  const [motionAction, setMotionAction] = useState(0);
  const showPanel = useCallback((next: Panel) => {
    setMotionAction((value) => value + 1);
    setPanel(next);
    setToolsOpen(true);
  }, []);
  const closeTools = () => { setMotionAction((value) => value + 1); setToolsOpen(false); };
  const context = useMemo(() => ({ split, show: showPanel }), [split, showPanel]);
  const safeTop = Math.max(8, insets.top, Platform.OS === "ios" ? homeNavigationLayout(insets, systemInsets, headerHeight).contentTop : 0);
  const bottom = laptop ? insets.bottom : 0;
  const foldLayout = useMemo(() => laptop ? { bottomReserved: bottom } : null, [laptop, bottom]);
  const motionGeometry = [geometry.revision, width, height, folded, axis, before, after, gap, safeTop, bottom].join(":");
  const chatVisible = split || !toolsOpen;
  const chat: PaneFrame = laptop
    ? { left: 0, top: safeTop, width, height: Math.max(0, height - safeTop - bottom) }
    : folded && !toolsOpen
      ? { left: before + gap, top: safeTop, width: after, height: Math.max(0, height - safeTop) }
      : { left: 0, top: safeTop, width: chatVisible ? toolsOpen && split ? before : width : 0, height: Math.max(0, height - safeTop) };
  const tools: PaneFrame = split && axis === "column"
    ? { left: 0, top: safeTop, width, height: toolsOpen ? Math.max(0, before - safeTop) : 0 }
    : { left: toolsOpen ? split ? before + gap : 0 : width, top: safeTop, width: toolsOpen ? Math.max(0, split ? after - 12 : width) : 0, height: Math.max(0, height - safeTop - 12) };
  return (
    <Workspace value={context}>
      <View style={{ flex: 1, backgroundColor: colors.plain }}>
        <View onLayout={geometry.onLayout} style={{ flex: 1, overflow: "hidden" }}>
          <LayoutProbe onMetrics={geometry.onMetrics} revision={geometry.revision} />
          <MountedMotionPane frame={chat} visible={chatVisible} action={motionAction} geometry={motionGeometry}>
            <ConsumedTopInset height={chat.top}><SessionFoldLayoutContext value={foldLayout}><ComputerPreviewVisible value={chatVisible}>{children}</ComputerPreviewVisible></SessionFoldLayoutContext></ConsumedTopInset>
          </MountedMotionPane>
          <MountedMotionPane fixedWidth={Math.max(0, split && axis === "row" ? after - 12 : width)} frame={tools} visible={toolsOpen} action={motionAction} geometry={motionGeometry} style={{ borderRadius: 26, borderCurve: "continuous", backgroundColor: colors.background }}>
            <SessionTools sessionId={sessionId} panel={panel} onPanel={showPanel} onClose={closeTools} active={toolsOpen} motionAction={motionAction} motionGeometry={motionGeometry} />
          </MountedMotionPane>
        </View>
      </View>
    </Workspace>
  );
}

export function SessionTools({ sessionId, panel, onPanel, onClose, active = true, motionAction = 0, motionGeometry }: { sessionId: string; panel: Panel; onPanel: (panel: Panel) => void; onClose?: () => void; active?: boolean; motionAction?: number; motionGeometry?: string }) {
  const [port, setPort] = useState<number | null>(null);
  const [body, setBody] = useState({ width: 0, height: 0 });
  const [previewVisited, setPreviewVisited] = useState(panel === "preview");
  useEffect(() => { if (panel === "preview") setPreviewVisited(true); }, [panel]);
  const cwd = useClient((state) => state.sessions[sessionId]?.cwd);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", padding: 12, gap: 4 }}>
        {(["changes", "preview"] as const).map((item) => (
          <Pressable
            key={item}
            onPress={() => { haptics.selection(); onPanel(item); }}
            accessibilityRole="tab"
            accessibilityState={{ selected: panel === item }}
            accessibilityLabel={item === "changes" ? "改动面板" : "预览面板"}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 7, minHeight: 44, paddingHorizontal: 12, borderRadius: 14, backgroundColor: panel === item ? colors.card : "transparent", opacity: pressed ? 0.65 : 1 })}
          >
            <Icon sf={item === "changes" ? "plus.forwardslash.minus" : "globe"} md={item === "changes" ? "difference" : "language"} size={16} color={panel === item ? colors.label : colors.secondaryLabel} />
            <Text style={[type.subhead, { color: panel === item ? colors.label : colors.secondaryLabel, fontWeight: "600" }]}>{item === "changes" ? "改动" : "预览"}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        {panel === "preview" && port !== null ? <Button title="切换端口" variant="plain" size="small" onPress={() => setPort(null)} /> : null}
        {onClose ? <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="关闭侧栏，返回对话" hitSlop={6} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon sf="xmark" md="close" size={16} color={colors.secondaryLabel} /></Pressable> : null}
      </View>
      <View onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setBody((current) => current.width === width && current.height === height ? current : { width, height }); }} style={{ flex: 1, overflow: "hidden" }}>
        <MountedMotionPane frame={{ left: panel === "changes" ? 0 : -12, top: 0, ...body }} visible={panel === "changes"} action={motionAction} geometry={motionGeometry ?? `${body.width}:${body.height}`}>
          <ChangesContent sessionId={sessionId} embedded />
        </MountedMotionPane>
        <MountedMotionPane frame={{ left: panel === "preview" ? 0 : 12, top: 0, ...body }} visible={panel === "preview"} action={motionAction} geometry={motionGeometry ?? `${body.width}:${body.height}`}>
          {port !== null ? <PreviewContent key={port} port={port} embedded /> : null}
          <View style={{ flex: 1, display: port === null ? "flex" : "none" }}>{previewVisited || panel === "preview" ? <PreviewPicker cwd={cwd} onOpen={setPort} active={panel === "preview" && port === null && active} /> : null}</View>
        </MountedMotionPane>
      </View>
    </View>
  );
}

function PreviewPicker({ cwd, onOpen, active }: { cwd?: string; onOpen: (port: number) => void; active: boolean }) {
  const { ports, error } = usePorts(active);
  const insets = usePageInsets();
  const [typed, setTyped] = useState("");
  const port = Number(typed);
  const valid = Number.isInteger(port) && port > 0 && port < 65536;
  const sorted = useMemo(() => [...(ports ?? [])].sort((a, b) => Number(b.cwd === cwd) - Number(a.cwd === cwd)), [ports, cwd]);
  return (
    <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={16} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 16 }}>
      <View style={{ alignItems: "flex-start", gap: 10, paddingVertical: 12 }}>
        <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: colors.accentSoft }}><Icon sf="globe" md="language" size={24} color={colors.accent} /></View>
        <Text style={[type.title, { color: colors.label }]}>查看运行结果</Text>
        <Text style={[type.subhead, { color: colors.secondaryLabel, lineHeight: 22 }]}>打开电脑上的网页，在这里查看效果，继续和 Agent 对话。</Text>
      </View>
      {ports === null && !error ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><ActivityIndicator size="small" color={colors.secondaryLabel} /><Text style={[type.footnote, { color: colors.secondaryLabel }]}>正在查找网页服务…</Text></View> : null}
      {ports?.length === 0 ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>还没有发现网页服务，也可以直接输入端口。</Text> : null}
      {sorted.map((entry, index) => <PortRow key={entry.port} entry={entry} position={positionOf(index, sorted.length)} onPress={() => onOpen(entry.port)} />)}
      {error ? <Text style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.fill, padding: 10, borderRadius: 14 }}>
        <Text style={{ fontFamily: mono, color: colors.secondaryLabel }}>localhost:</Text>
        <TextInput accessibilityLabel="预览端口" value={typed} onChangeText={(value) => setTyped(value.replace(/\D/g, "").slice(0, 5))} placeholder="3000" placeholderTextColor={colors.placeholder as string} keyboardType="number-pad" onSubmitEditing={() => valid && onOpen(port)} style={{ flex: 1, minHeight: 44, color: colors.label, fontFamily: mono }} />
        <Button title="打开" size="small" disabled={!valid} onPress={() => onOpen(port)} />
      </View>
    </KeyboardAwareScrollView>
  );
}
