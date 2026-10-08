import { Image } from "expo-image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useConnection } from "@/lib/client";
import { Modal, Pressable, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { useComputerPreview } from "@/lib/use-computer-preview";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";
import { Glass } from "./glass";
import { useTimelineSession } from "./timeline/context";

/** Only the independent preview subscription supplies pixels here. */
function SessionComputerUse({ sessionId, bounds }: { sessionId: string; bounds: { width: number; height: number } }) {
  const { computer } = useConnection();
  const positionKey = JSON.stringify([computer.key, sessionId]);
  const { frame, mode, setMode } = useComputerPreview(sessionId);
  const [expanded, setExpanded] = useState(false);
  if (mode === "hidden") return null;
  if (mode === "collapsed") return (
    <MovablePreview positionKey={positionKey} bounds={bounds} width={44} height={44}>
      <Glass interactive style={{ borderRadius: 22 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="展开电脑画面" onPress={() => setMode("shown")} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Icon sf="desktopcomputer" md="desktop_windows" size={20} color={colors.label} />
        </Pressable>
      </Glass>
    </MovablePreview>
  );
  if (!frame) return null;
  const width = Math.min(224, bounds.width * 0.85);
  const height = Math.min(bounds.height, Math.max(80, Math.min(200, width * frame.height / frame.width)));
  return (
    <>
      <MovablePreview positionKey={positionKey} bounds={bounds} width={width} height={height}>
      <View style={{ borderRadius: 14, borderCurve: "continuous", backgroundColor: colors.card, boxShadow: "0 6px 24px rgba(0,0,0,0.14)" }}>
        <Pressable accessibilityRole="imagebutton" accessibilityLabel="放大电脑画面" onPress={() => setExpanded(true)} style={{ height, borderRadius: 14, overflow: "hidden" }}>
          <Image source={{ uri: frame.uri }} style={{ width: "100%", height: "100%" }} contentFit="contain" cachePolicy="none" />
        </Pressable>
        <View style={{ position: "absolute", top: 0, right: 0, flexDirection: "row" }}>
          <Pressable accessibilityRole="button" accessibilityLabel="收起电脑画面" onPress={() => setMode("collapsed")} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            {({ pressed }) => (
              <View pointerEvents="none" style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: pressed ? "rgba(0,0,0,0.58)" : "rgba(0,0,0,0.28)", alignItems: "center", justifyContent: "center" }}>
                <Icon sf="chevron.down" md="expand_more" size={12} color="rgba(255,255,255,0.85)" />
              </View>
            )}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭电脑画面" onPress={() => setMode("hidden")} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            {({ pressed }) => (
              <View pointerEvents="none" style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: pressed ? "rgba(0,0,0,0.58)" : "rgba(0,0,0,0.28)", alignItems: "center", justifyContent: "center" }}>
                <Icon sf="xmark" md="close" size={12} color="rgba(255,255,255,0.85)" />
              </View>
            )}
          </Pressable>
        </View>
      </View>
      </MovablePreview>
      <Modal visible={expanded} animationType="fade" onRequestClose={() => setExpanded(false)} presentationStyle="pageSheet" supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]}>
        <SafeAreaProvider>
          <View style={{ flex: 1, backgroundColor: colors.plain }}><ExpandedPreview uri={frame.uri} onClose={() => setExpanded(false)} /></View>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}

function ExpandedPreview({ uri, onClose }: { uri: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}>
      <View style={{ alignItems: "flex-end" }}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭放大画面" onPress={onClose} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Icon sf="xmark" md="close" size={20} color={colors.label} />
        </Pressable>
      </View>
      <Image source={{ uri }} style={{ flex: 1 }} contentFit="contain" cachePolicy="none" />
    </View>
  );
}

type PreviewBounds = { width: number; height: number };
type PreviewPosition = { horizontal: number; vertical: number };
const positions = new Map<string, PreviewPosition>();

/** Store relative positions so rotation, split panes and the keyboard keep the window reachable. */
function MovablePreview({ positionKey, bounds, width, height, children }: {
  positionKey: string; bounds: PreviewBounds; width: number; height: number; children: ReactNode;
}) {
  const position = useRef(positions.get(positionKey) ?? { horizontal: 0, vertical: 0 });
  const maxX = Math.max(0, bounds.width - width);
  const maxY = Math.max(0, bounds.height - height);
  const x = useSharedValue(-position.current.horizontal * maxX);
  const y = useSharedValue(position.current.vertical * maxY);
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  useEffect(() => {
    x.value = -position.current.horizontal * maxX;
    y.value = position.current.vertical * maxY;
  }, [maxX, maxY, x, y]);
  const remember = (horizontal: number, vertical: number) => {
    const value = { horizontal, vertical };
    position.current = value;
    positions.delete(positionKey); positions.set(positionKey, value);
    if (positions.size > 64) positions.delete(positions.keys().next().value!);
  };
  const pan = Gesture.Pan().minDistance(8).maxPointers(1)
    .onStart(() => { originX.value = x.value; originY.value = y.value; })
    .onUpdate(event => {
      x.value = Math.max(-maxX, Math.min(0, originX.value + event.translationX));
      y.value = Math.max(0, Math.min(maxY, originY.value + event.translationY));
    })
    .onFinalize((_event, success) => {
      if (success) runOnJS(remember)(maxX ? -x.value / maxX : 0, maxY ? y.value / maxY : 0);
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }] }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[{ position: "absolute", top: 0, right: 0, width, height }, style]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

/** A sibling of the list, so token streaming and scrolling never move it. */
export function FloatingComputerUse({ top }: { top: number }) {
  const sessionId = useTimelineSession();
  const [bounds, setBounds] = useState<PreviewBounds>({ width: 0, height: 0 });
  if (!sessionId) return null;
  return (
    <View pointerEvents="box-none" onLayout={({ nativeEvent: { layout } }) => setBounds({ width: layout.width, height: layout.height })}
      style={{ position: "absolute", top: top + 8, bottom: 8, left: 12, right: 12, zIndex: 2 }}>
      {bounds.width > 0 && bounds.height > 0 ? <SessionComputerUse key={sessionId} sessionId={sessionId} bounds={bounds} /> : null}
    </View>
  );
}
