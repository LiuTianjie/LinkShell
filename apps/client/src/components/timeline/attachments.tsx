import type { ContentBlock } from "@linkshell/wire";
import { Image } from "expo-image";
import { memo, useState } from "react";
import { Modal, Pressable, StatusBar, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { baseName } from "@/lib/format";
import { openLink } from "@/lib/links";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { PressableScale } from "../pressable-scale";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;
type LinkBlock = Extract<ContentBlock, { type: "resource_link" }>;

export function imageSource(block: ImageBlock): { uri: string } {
  return { uri: block.uri && !block.data ? block.uri : `data:${block.mimeType};base64,${block.data ?? ""}` };
}

/** Pinch, pan and double-tap zoom; a downward swipe at 1× dismisses. */
function ZoomableImage({ block, onClose }: { block: ImageBlock; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const spring = { damping: 22, stiffness: 240 };

  const clamp = (value: number, limit: number) => {
    "worklet";
    return Math.min(Math.max(value, -limit), limit);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.min(Math.max(savedScale.value * event.scale, 0.8), 6);
    })
    .onEnd(() => {
      if (scale.value < 1) {
        scale.value = withSpring(1, spring);
        x.value = withSpring(0, spring);
        y.value = withSpring(0, spring);
      }
      savedScale.value = Math.max(scale.value, 1);
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onUpdate((event) => {
      if (savedScale.value > 1) {
        x.value = clamp(savedX.value + event.translationX, (width * (savedScale.value - 1)) / 2);
        y.value = clamp(savedY.value + event.translationY, (height * (savedScale.value - 1)) / 2);
      } else {
        y.value = Math.max(event.translationY, 0);
      }
    })
    .onEnd((event) => {
      if (savedScale.value <= 1) {
        if (event.translationY > 120 || event.velocityY > 900) runOnJS(onClose)();
        else y.value = withSpring(0, spring);
        return;
      }
      savedX.value = x.value;
      savedY.value = y.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      const zoomed = savedScale.value > 1;
      const target = zoomed ? 1 : 2.5;
      const toX = zoomed ? 0 : clamp((width / 2 - event.x) * (target - 1), (width * (target - 1)) / 2);
      const toY = zoomed ? 0 : clamp((height / 2 - event.y) * (target - 1), (height * (target - 1)) / 2);
      scale.value = withSpring(target, spring);
      x.value = withSpring(toX, spring);
      y.value = withSpring(toY, spring);
      savedScale.value = target;
      savedX.value = toX;
      savedY.value = toY;
    });

  const singleTap = Gesture.Tap()
    .requireExternalGestureToFail(doubleTap)
    .onEnd(() => {
      if (savedScale.value <= 1) runOnJS(onClose)();
    });

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: savedScale.value > 1 ? 1 : Math.max(1 - y.value / 400, 0.3),
  }));

  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap))}>
      <View style={{ flex: 1 }}>
        <Animated.View style={[{ ...StyleSheet.absoluteFill, backgroundColor: "#000000" }, backdropStyle]} />
        <Animated.View style={[{ width, height }, imageStyle]}>
          <Image source={imageSource(block)} style={{ width, height }} contentFit="contain" transition={180} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

/** Its own tap gesture: RN touchables don't reliably get touches beside the zoom gestures. */
function CloseButton({ top, onClose }: { top: number; onClose: () => void }) {
  const tap = Gesture.Tap()
    .hitSlop(12)
    .onEnd(() => {
      runOnJS(onClose)();
    });
  return (
    <GestureDetector gesture={tap}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel="关闭"
        onAccessibilityTap={onClose}
        style={{
          position: "absolute",
          top,
          right: 16,
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: "rgba(255,255,255,0.16)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon sf="xmark" md="close" size={15} color="#ffffff" weight="semibold" />
      </View>
    </GestureDetector>
  );
}

function Viewer({ block, onClose }: { block: ImageBlock; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="fade" transparent statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ZoomableImage block={block} onClose={onClose} />
        <CloseButton top={insets.top + 8} onClose={onClose} />
      </GestureHandlerRootView>
    </Modal>
  );
}

/** A tappable thumbnail that opens the full-screen viewer. */
export const ImageThumb = memo(function ImageThumb({ block, size }: { block: ImageBlock; size: number | { width: number; height: number } }) {
  const [open, setOpen] = useState(false);
  const frame = typeof size === "number" ? { width: size, height: size } : size;
  return (
    <>
      <PressableScale
        onPress={() => {
          haptics.selection();
          setOpen(true);
        }}
        accessibilityRole="imagebutton"
        accessibilityLabel="查看图片"
      >
        <View style={{ ...frame, borderRadius: 14, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.fill }}>
          <Image source={imageSource(block)} style={frame} contentFit="cover" transition={160} />
        </View>
      </PressableScale>
      {open ? <Viewer block={block} onClose={() => setOpen(false)} /> : null}
    </>
  );
});

function linkIcon(uri: string): { sf: "globe" | "folder" | "doc"; md: "language" | "folder" | "description" } {
  if (/^https?:/i.test(uri)) return { sf: "globe", md: "language" };
  if (uri.endsWith("/")) return { sf: "folder", md: "folder" };
  return { sf: "doc", md: "description" };
}

/** A file or URL the message refers to. Web links open; local files just name themselves. */
export const LinkChip = memo(function LinkChip({ block, onBubble = false }: { block: LinkBlock; onBubble?: boolean }) {
  const web = /^https?:/i.test(block.uri);
  const skill = block.kind === "skill";
  const name = skill
    ? block.name
    : block.name && block.name !== block.uri
      ? block.name
      : web
        ? block.uri.replace(/^https?:\/\//i, "")
        : baseName(block.uri.replace(/^file:\/\//, ""));
  const icon = skill
    ? ({ sf: "wand.and.stars", md: "auto_fix_high" } as const)
    : block.kind === "agent"
      ? ({ sf: "person.2", md: "group" } as const)
      : linkIcon(block.uri);
  const tint = skill ? colors.accent : colors.secondaryLabel;
  return (
    <Pressable
      onPress={() => openLink(block.uri)}
      accessibilityRole="link"
      accessibilityLabel={skill ? `技能 ${name}` : name}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        alignSelf: "flex-start",
        maxWidth: "100%",
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 10,
        borderCurve: "continuous",
        // On the (grey) user bubble a chip sits on the page colour; elsewhere on a fill.
        backgroundColor: onBubble ? colors.plain : skill ? colors.accentSoft : colors.fill,
      }}
    >
      <Icon sf={icon.sf} md={icon.md} size={12} color={tint} />
      <Text numberOfLines={1} style={[type.footnote, { flexShrink: 1, color: skill ? colors.accent : colors.label, fontWeight: "500" }]}>
        {name}
      </Text>
    </Pressable>
  );
});

/** Images as a thumbnail strip, then link chips. */
export function Attachments({ blocks, align = "start", thumb = 120 }: { blocks: ContentBlock[]; align?: "start" | "end"; thumb?: number }) {
  const images = blocks.filter((b): b is ImageBlock => b.type === "image");
  const links = blocks.filter((b): b is LinkBlock => b.type === "resource_link");
  if (!images.length && !links.length) return null;
  const justify = align === "end" ? "flex-end" : "flex-start";
  return (
    <View style={{ gap: 6, alignItems: align === "end" ? "flex-end" : "flex-start" }}>
      {images.length === 1 ? (
        <SingleImage block={images[0]!} maxWidth={thumb >= 116 ? 240 : 200} maxHeight={thumb >= 116 ? 240 : 160} />
      ) : images.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: justify, maxWidth: thumb * 2 + 6 }}>
          {images.map((image, index) => (
            <ImageThumb key={index} block={image} size={thumb} />
          ))}
        </View>
      ) : null}
      {links.map((link, index) => (
        <LinkChip key={index} block={link} />
      ))}
    </View>
  );
}

/** One image keeps its own aspect ratio, bounded to a comfortable size. */
function SingleImage({ block, maxWidth: widest, maxHeight }: { block: ImageBlock; maxWidth: number; maxHeight: number }) {
  const [ratio, setRatio] = useState(4 / 3);
  const { width: screen } = useWindowDimensions();
  const maxWidth = Math.min(screen * 0.66, widest);
  // Fit inside maxWidth × maxHeight, but never narrower than a comfortable tap target.
  const width = Math.max(Math.min(maxWidth, maxHeight * ratio), 96);
  const height = Math.min(width / ratio, maxHeight);
  return (
    <View>
      <ImageThumb block={block} size={{ width, height }} />
      <Image
        source={imageSource(block)}
        style={{ width: 1, height: 1, position: "absolute", opacity: 0 }}
        onLoad={(event) => {
          const { width: w, height: h } = event.source;
          if (w > 0 && h > 0) setRatio(w / h);
        }}
      />
    </View>
  );
}
