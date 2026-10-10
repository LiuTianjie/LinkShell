import type { ContentBlock } from "@linkshell/wire";
import { Image } from "expo-image";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import { ActivityIndicator, Modal, Pressable, StatusBar, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { LayoutProbe } from "../../../modules/link-layout";
import { useLayoutGeometry } from "@/lib/use-layout-geometry";
import { safeContentInsets } from "@/lib/adaptive-insets";
import { nativeStatusBar } from "@/lib/native-status-bar";
import { useActions } from "@/lib/client";
import { useContentWidth } from "@/lib/content-width";
import { baseName } from "@/lib/format";
import { openLink } from "@/lib/links";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { PressableScale } from "../pressable-scale";
import { useTimelineSession } from "./context";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;
type AudioBlock = Extract<ContentBlock, { type: "audio" }>;
type LinkBlock = Extract<ContentBlock, { type: "resource_link" }>;

export function imageSource(block: ImageBlock | AudioBlock): { uri: string } {
  return { uri: block.uri && !block.data ? block.uri : `data:${block.mimeType};base64,${block.data ?? ""}` };
}

/** A picture the host kept back: fetched from it when shown (`loadImage`). */
const REFERENCE = /^linkshell-event:/;

/** A row flung past unmounts before this long, and never asks the computer for its picture. */
const FETCH_DELAY = 180;

/** Pictures already asked for: a row that comes back shows its picture without that wait. */
const requested = new Set<string>();

/** Width ÷ height of pictures seen, so a row keeps its height when it comes back. */
const ratios = new Map<string, number>();

export interface LoadedImage {
  /** Ready to draw; undefined while loading or after a failure. */
  uri?: string;
  failed: boolean;
  retry: () => void;
}

/**
 * What to draw for an image block. Pictures in history arrive as a reference
 * and are fetched when the row mounts: the list is virtualized, so that is
 * when they are about to be seen. Nothing loads a session's pictures up front.
 */
export function useImage(block: ImageBlock | AudioBlock): LoadedImage {
  const sessionId = useTimelineSession();
  const { loadImage } = useActions();
  const reference = sessionId && !block.data && block.uri && REFERENCE.test(block.uri) ? block.uri : undefined;
  const key = reference ? `${sessionId} ${reference}` : undefined;
  const [loaded, setLoaded] = useState<{ key: string; uri: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sessionId || !reference || !key) return;
    let cancelled = false;
    const load = () => {
      requested.add(key);
      loadImage(sessionId, reference).then(
        (uri) => {
          if (!cancelled) setLoaded({ key, uri });
        },
        () => {
          requested.delete(key);
          if (!cancelled) setFailed(key);
        },
      );
    };
    if (requested.has(key)) {
      load();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(load, FETCH_DELAY);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, reference, key, loadImage, attempt]);

  const retry = useCallback(() => {
    setFailed(null);
    setAttempt((value) => value + 1);
  }, []);

  if (!key) return { uri: imageSource(block).uri, failed: false, retry };
  // State from another picture (a recycled row) doesn't count.
  return { uri: loaded?.key === key ? loaded.uri : undefined, failed: failed === key, retry };
}

/** Pinch, pan and double-tap zoom; a downward swipe at 1× dismisses. */
function ZoomableImage({ block, onClose, width, height }: { block: ImageBlock; onClose: () => void; width: number; height: number }) {
  const image = useImage(block);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const spring = { damping: 22, stiffness: 240 };

  // A folded or rotated viewport must not leave the zoomed picture off-screen.
  useEffect(() => {
    const limitX = width * Math.max(0, savedScale.value - 1) / 2;
    const limitY = height * Math.max(0, savedScale.value - 1) / 2;
    savedX.value = x.value = Math.max(-limitX, Math.min(limitX, x.value));
    savedY.value = y.value = Math.max(-limitY, Math.min(limitY, y.value));
  }, [width, height, savedScale, savedX, savedY, x, y]);

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

  // Only these two cross into the gesture worklet, not the picture itself.
  const { failed, retry } = image;
  const singleTap = Gesture.Tap()
    .requireExternalGestureToFail(doubleTap)
    .onEnd(() => {
      if (failed) runOnJS(retry)();
      else if (savedScale.value <= 1) runOnJS(onClose)();
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
        <Animated.View style={[{ width, height, alignItems: "center", justifyContent: "center" }, imageStyle]}>
          {image.uri ? (
            <Image source={{ uri: image.uri }} style={{ width, height }} contentFit="contain" transition={180} />
          ) : image.failed ? (
            <View style={{ alignItems: "center", gap: 10 }}>
              <Icon sf="arrow.clockwise" md="refresh" size={22} color="#ffffff" />
              <Text style={[type.subhead, { color: "#ffffff" }]}>加载失败，点按重试</Text>
            </View>
          ) : (
            <ActivityIndicator color="#ffffff" />
          )}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

/** Its own tap gesture: RN touchables don't reliably get touches beside the zoom gestures. */
function CloseButton({ top, right, onClose }: { top: number; right: number; onClose: () => void }) {
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
          right,
          width: 44,
          height: 44,
          borderRadius: 22,
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

function ViewerContent({ block, onClose }: { block: ImageBlock; onClose: () => void }) {
  const fallback = useSafeAreaInsets();
  const window = useWindowDimensions();
  const geometry = useLayoutGeometry();
  const insets = safeContentInsets(geometry.metrics, fallback);
  return (
    <GestureHandlerRootView onLayout={geometry.onLayout} style={{ flex: 1 }}>
      <LayoutProbe revision={geometry.revision} onMetrics={geometry.onMetrics} />
      <ZoomableImage block={block} onClose={onClose} width={geometry.frame.width || window.width} height={geometry.frame.height || window.height} />
      <CloseButton top={insets.top + 8} right={insets.right + 16} onClose={onClose} />
    </GestureHandlerRootView>
  );
}

function Viewer({ block, onClose }: { block: ImageBlock; onClose: () => void }) {
  return (
    <Modal visible animationType="fade" transparent supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]} statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      {!nativeStatusBar ? <StatusBar barStyle="light-content" /> : null}
      <SafeAreaProvider><ViewerContent block={block} onClose={onClose} /></SafeAreaProvider>
    </Modal>
  );
}

/** A tappable thumbnail that opens the full-screen viewer. Its frame is the placeholder while the picture loads. */
export const ImageThumb = memo(function ImageThumb({
  block,
  size,
  onRatio,
}: {
  block: ImageBlock;
  size: number | { width: number; height: number };
  /** Reports the picture's width ÷ height once it has loaded. */
  onRatio?: (ratio: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const image = useImage(block);
  const frame = typeof size === "number" ? { width: size, height: size } : size;
  return (
    <>
      <PressableScale
        onPress={() => {
          haptics.selection();
          // The viewer loads the picture itself, so it opens on one that isn't here yet.
          if (image.failed) image.retry();
          else setOpen(true);
        }}
        accessibilityRole="imagebutton"
        accessibilityLabel={image.failed ? "图片加载失败，点按重试" : "查看图片"}
      >
        <View
          style={{
            ...frame,
            borderRadius: 14,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: colors.fill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {image.uri ? (
            <Image
              source={{ uri: image.uri }}
              style={frame}
              contentFit="cover"
              transition={160}
              onLoad={
                onRatio
                  ? (event) => {
                      const { width: w, height: h } = event.source;
                      if (w > 0 && h > 0) onRatio(w / h);
                    }
                  : undefined
              }
            />
          ) : image.failed ? (
            <View style={{ alignItems: "center", gap: 4, paddingHorizontal: 6 }}>
              <Icon sf="arrow.clockwise" md="refresh" size={15} color={colors.secondaryLabel} />
              <Text style={[type.caption, { color: colors.secondaryLabel, textAlign: "center" }]}>加载失败，点按重试</Text>
            </View>
          ) : (
            <ActivityIndicator size="small" color={colors.tertiaryLabel} />
          )}
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
      ? ({ sf: "square.stack.3d.up", md: "layers" } as const)
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
        minHeight: 44,
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
  const media = blocks.filter((block) => block.type === "audio" || block.type === "resource");
  if (!images.length && !links.length && !media.length) return null;
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
      {media.map((block, index) => block.type === "audio" ? <AudioAttachment key={index} block={block} /> : block.type === "resource" ? <EmbeddedResource key={index} block={block} /> : null)}
    </View>
  );
}

function AudioAttachment({ block }: { block: AudioBlock }) {
  const loaded = useImage(block);
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const cached = useRef<File | null>(null);
  const source = useRef<string | undefined>(undefined);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (pending.current && status.isLoaded) { pending.current = false; player.play(); }
  }, [player, status.isLoaded]);
  useEffect(() => () => { try { cached.current?.delete(); } catch { /* Only this row's cache file is removed. */ } }, []);
  const play = async () => {
    setError(undefined);
    if (loaded.failed) { loaded.retry(); return; }
    if (!loaded.uri) return;
    try {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
      if (status.playing) { player.pause(); return; }
      if (source.current !== loaded.uri) {
        let uri = loaded.uri;
        if (uri.startsWith("data:")) {
          const ext = block.mimeType.includes("wav") ? "wav" : block.mimeType.includes("mp4") || block.mimeType.includes("aac") ? "m4a" : block.mimeType.includes("ogg") ? "ogg" : "mp3";
          const file = new File(Paths.cache, `linkshell-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
          file.create(); file.write(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
          try { cached.current?.delete(); } catch { /* A previous cached source may already have been evicted. */ }
          cached.current = file; uri = file.uri;
        }
        source.current = loaded.uri; pending.current = true; player.replace({ uri });
      } else {
        if (status.didJustFinish || status.duration > 0 && status.currentTime >= status.duration) await player.seekTo(0);
        player.play();
      }
    } catch (reason) { pending.current = false; setError(reason instanceof Error ? reason.message : "音频无法播放"); }
  };
  const seconds = Math.max(0, Math.floor(status.currentTime));
  return <View style={{ gap: 4, minWidth: 180, maxWidth: 300 }}>
    <Pressable onPress={() => void play()} disabled={!loaded.uri && !loaded.failed} accessibilityRole="button" accessibilityLabel={status.playing ? "暂停音频" : "播放音频"} style={{ minHeight: 48, borderRadius: 16, paddingHorizontal: 14, backgroundColor: colors.fill, flexDirection: "row", alignItems: "center", gap: 12 }}>
      {!loaded.uri && !loaded.failed ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon sf={status.playing ? "pause.fill" : "play.fill"} md={status.playing ? "pause" : "play_arrow"} size={18} color={colors.accent} />}
      <Text style={[type.footnote, { color: colors.label }]}>{loaded.failed ? "重新加载音频" : `音频 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${status.duration ? ` / ${Math.floor(status.duration)} 秒` : ""}`}</Text>
    </Pressable>
    {error ? <Text style={[type.caption, { color: colors.danger }]}>{error}</Text> : null}
  </View>;
}

function EmbeddedResource({ block }: { block: Extract<ContentBlock, { type: "resource" }> }) {
  const [expanded, setExpanded] = useState(false);
  const resource = block.resource;
  const mimeType = resource.mimeType ?? "application/octet-stream";
  if (/^image\//.test(mimeType) && (resource.blob || resource.assetUri)) return <SingleImage block={{ type: "image", mimeType, data: resource.blob, uri: resource.assetUri }} maxWidth={240} maxHeight={240} />;
  if (/^audio\//.test(mimeType) && (resource.blob || resource.assetUri)) return <AudioAttachment block={{ type: "audio", mimeType, data: resource.blob, uri: resource.assetUri }} />;
  let label = baseName(resource.uri);
  try { label = decodeURIComponent(label.replace(/^attachment:/, "")); } catch { /* Keep the original resource name. */ }
  return <View style={{ gap: 6, padding: 12, borderRadius: 14, backgroundColor: colors.fill, maxWidth: 320 }}>
    <Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded }} style={{ minHeight: 32, flexDirection: "row", gap: 8, alignItems: "center" }}>
      <Icon sf="doc.text" md="description" size={16} color={colors.accent} /><Text numberOfLines={2} style={[type.footnote, { color: colors.label, flexShrink: 1 }]}>{label}</Text>
    </Pressable>
    <Text style={[type.caption, { color: colors.secondaryLabel }]}>{mimeType}{resource.blob ? ` · ${Math.ceil(resource.blob.length * 0.75 / 1024)} KB` : ""}</Text>
    {expanded ? <Text selectable style={[type.footnote, { color: colors.label }]}>{resource.text ?? resource.uri}</Text> : resource.text ? <Text numberOfLines={3} style={[type.footnote, { color: colors.secondaryLabel }]}>{resource.text}</Text> : null}
  </View>;
}

/** One image keeps its own aspect ratio, bounded to a comfortable size. */
function SingleImage({ block, maxWidth: widest, maxHeight }: { block: ImageBlock; maxWidth: number; maxHeight: number }) {
  const sessionId = useTimelineSession();
  const known = sessionId && !block.data && block.uri ? `${sessionId} ${block.uri}` : undefined;
  const [ratio, setRatio] = useState(() => (known ? ratios.get(known) : undefined) ?? 4 / 3);
  const onRatio = useCallback(
    (value: number) => {
      if (known) ratios.set(known, value);
      setRatio(value);
    },
    [known],
  );
  const screen = useContentWidth();
  const maxWidth = Math.min(screen * 0.66, widest);
  // Fit inside maxWidth × maxHeight, but never narrower than a comfortable tap target.
  const width = Math.max(Math.min(maxWidth, maxHeight * ratio), 96);
  const height = Math.min(width / ratio, maxHeight);
  return (
    <View>
      <ImageThumb block={block} size={{ width, height }} onRatio={onRatio} />
    </View>
  );
}
