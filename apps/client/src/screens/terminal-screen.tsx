import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, useColorScheme, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { usePageInsets } from "@/components/adaptive-page";
import { Button } from "@/components/button";
import { BranchTag } from "@/components/branch-tag";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { KeyBar, withCtrl } from "@/components/terminal/key-bar";
import { darkTerminal, lightTerminal } from "@/components/terminal/themes";
import { NativeTerminal, type NativeTerminalHandle } from "../../modules/link-terminal/src";
import { useContentWidth } from "@/lib/content-width";
import { useConnection } from "@/lib/client";
import { shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { branchOf, useGitInfo } from "@/lib/worktree";
import { terminalState, useTerminals } from "@/lib/terminals";
import { pickFile, pickPhoto, shellQuote, upload, type Picked } from "@/lib/upload";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const FONT_SIZES = [11, 12, 13, 14, 16, 18];

/**
 * One host terminal, full screen. Output streams in by seq; after a reconnect
 * the host sends only what was missed, or a full redraw if it no longer can.
 */
export function TerminalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { link } = useConnection();
  const { terminals, loaded } = useTerminals();
  const info = terminals.find((terminal) => terminal.id === id);
  // Where the terminal started: its branch, when that's a git repository.
  const branch = branchOf(useGitInfo(info?.cwd));
  const insets = usePageInsets();
  const contentWidth = useContentWidth();
  const { fontScale } = useWindowDimensions();
  const terminalSize = useRef<{ id: string; cols: number; rows: number } | null>(null);
  const keyboardOpen = useKeyboardState((state) => state.isVisible);
  // Follow the keyboard frame by frame: the terminal shrinks with it, so the
  // prompt and the key bar stay just above the keys.
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(-keyboardHeight.value, 0) }));
  const theme = useColorScheme() === "dark" ? darkTerminal : lightTerminal;
  const view = useRef<NativeTerminalHandle>(null);
  const [fontSize, setFontSize] = useState(13);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  // Output ordering: chunks that race the attach replay are held and filtered by seq.
  const seq = useRef<number | undefined>(undefined);
  const attaching = useRef(true);
  const held = useRef<{ seq: number; data: string }[]>([]);

  const draw = useCallback((data: string, reset = false) => {
    if (reset) view.current?.reset();
    if (data) view.current?.write(data);
  }, []);

  const attach = useCallback(async () => {
    attaching.current = true;
    try {
      const result = await link.call("terminals.attach", { terminalId: id, fromSeq: seq.current });
      draw(result.replay, result.reset);
      seq.current = result.seq;
      for (const chunk of held.current) {
        if (chunk.seq > result.seq) {
          draw(chunk.data);
          seq.current = chunk.seq;
        }
      }
    } catch {
      // Gone (closed elsewhere) or offline: the list and banner say so.
    } finally {
      held.current = [];
      attaching.current = false;
    }
  }, [draw, id, link]);

  useEffect(() => {
    const offOutput = link.on("terminal.output", (chunk) => {
      if (chunk.terminalId !== id) return;
      if (attaching.current) {
        held.current.push(chunk);
        return;
      }
      if (seq.current !== undefined && chunk.seq <= seq.current) return;
      seq.current = chunk.seq;
      draw(chunk.data);
    });
    void attach();
    const offOnline = link.onOnline(() => void attach());
    return () => {
      offOutput();
      offOnline();
      void link.call("terminals.detach", { terminalId: id }).catch(() => {});
    };
  }, [attach, draw, id, link]);

  const send = useCallback(
    (data: string) => {
      const payload = ctrlRef.current ? withCtrl(data) : data;
      if (ctrlRef.current) setCtrl(false);
      void link.call("terminals.input", { terminalId: id, data: payload }).catch(() => {});
    },
    [id, link],
  );

  const state = info ? terminalState(info) : undefined;
  const ended = state?.ended ?? false;

  const close = () => {
    Alert.alert(ended ? "删除这条记录？" : "关闭这个终端？", ended ? "它的输出也会一起删除。" : "里面正在运行的程序会被结束，记录会一起删除。", [
      { text: "取消", style: "cancel" },
      {
        text: ended ? "删除" : "关闭",
        style: "destructive",
        onPress: () => {
          void link.call("terminals.close", { terminalId: id }).catch(() => {});
          router.back();
        },
      },
    ]);
  };

  // A file from the phone lands in the terminal's directory, and its path is
  // typed at the prompt, the way dropping a file on a desktop terminal does.
  const [uploading, setUploading] = useState<string | null>(null);
  const sendFile = async (pick: () => Promise<Picked | null>) => {
    if (!info) return;
    const file = await pick().catch(() => null);
    if (!file) return;
    setUploading(file.name);
    try {
      const path = await upload(link, file, info.cwd);
      haptics.success();
      void link.call("terminals.input", { terminalId: id, data: `${shellQuote(path)} ` }).catch(() => {});
    } catch (reason) {
      haptics.error();
      Alert.alert("上传失败", reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploading(null);
    }
  };

  const gone = loaded && !info;
  const rerun = () => {
    if (!info) return;
    haptics.medium();
    void link.call("terminals.create", { cwd: info.cwd, command: info.command, cols: info.cols, rows: info.rows }).then(({ terminal }) => {
      router.replace({ pathname: "/terminal/[id]", params: { id: terminal.id } });
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: insets.top }}>
      <Stack.Screen
        options={{
          title: state?.title ?? "终端",
          headerTitle: Platform.OS === "ios" ? undefined : () => (
            <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start", maxWidth: Math.max(100, Math.min(360, contentWidth - 144)) }}>
              <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
                {state?.title ?? "终端"}
              </Text>
              {info ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 240 }}>
                  <Text numberOfLines={1} style={[type.caption, { flexShrink: 1, color: colors.secondaryLabel }]}>
                    {shortPath(info.cwd)}
                    {branch ? "" : ` · ${ended ? state?.detail : state?.busy ? state.detail : `${info.cols}×${info.rows}`}`}
                  </Text>
                  {branch ? (
                    <View style={{ flexShrink: 0 }}>
                      <BranchTag branch={branch} max={16} />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          ),
          headerStyle: { backgroundColor: theme.background as string },
          headerShadowVisible: false,
          headerTransparent: false,
        }}
      />
      <HeaderActions
        actions={[
          {
            kind: "menu",
            key: "more",
            icon: { sf: "ellipsis", md: "more_vert" },
            label: "更多",
            items: [
              {
                title: "放大字号",
                icon: { sf: "textformat.size.larger", md: "text_increase" },
                onPress: () => setFontSize((size) => FONT_SIZES[Math.min(FONT_SIZES.indexOf(size) + 1, FONT_SIZES.length - 1)]!),
              },
              {
                title: "缩小字号",
                icon: { sf: "textformat.size.smaller", md: "text_decrease" },
                onPress: () => setFontSize((size) => FONT_SIZES[Math.max(FONT_SIZES.indexOf(size) - 1, 0)]!),
              },
              ...(info && !ended
                ? [
                    { title: "上传照片", icon: { sf: "photo", md: "image" } as const, onPress: () => void sendFile(pickPhoto) },
                    { title: "上传文件", icon: { sf: "doc.badge.arrow.up", md: "upload_file" } as const, onPress: () => void sendFile(pickFile) },
                  ]
                : []),
              ...(info ? [{ title: "预览网页", icon: { sf: "globe", md: "language" } as const, onPress: () => router.push({ pathname: "/ports", params: { cwd: info.cwd } }) }] : []),
              // Where the terminal started (the host doesn't follow its `cd`s); the home directory if it's gone.
              {
                title: "项目文件",
                icon: { sf: "folder", md: "folder_open" },
                onPress: () => router.push({ pathname: "/files", params: info ? { path: info.cwd } : {} }),
              },
              ...(info && !ended ? [{ title: "重新运行", icon: { sf: "arrow.clockwise", md: "refresh" } as const, onPress: rerun }] : []),
              { title: ended ? "删除记录" : "关闭终端", icon: { sf: ended ? "trash" : "xmark.circle", md: ended ? "delete" : "close" }, destructive: true, onPress: close },
            ],
          },
        ]}
      />
      {Platform.OS === "ios" && info ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
          <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, flex: 1 }]}>{shortPath(info.cwd)}</Text>
          {branch ? <BranchTag branch={branch} max={16} /> : null}
        </View>
      ) : null}
      <Animated.View style={[{ flex: 1 }, lift]}>
        <View style={{ flex: 1 }}>
          <NativeTerminal
            ref={view}
            theme={theme}
            fontSize={fontSize * fontScale}
            onInput={send}
            onResize={(cols, rows) => {
              // Rotation and folding can briefly report an empty native surface. Keep the running PTY valid.
              if (cols < 2 || rows < 1 || (terminalSize.current?.id === id && terminalSize.current?.cols === cols && terminalSize.current?.rows === rows)) return;
              terminalSize.current = { id, cols, rows };
              void link.call("terminals.resize", { terminalId: id, cols, rows }).catch(() => { terminalSize.current = null; });
            }}
            style={{ flex: 1, backgroundColor: theme.background }}
          />
          {uploading ? (
            <View pointerEvents="none" style={{ position: "absolute", top: 10, left: 0, right: 0, alignItems: "center" }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 18,
                  backgroundColor: colors.cardRaised,
                  boxShadow: "0 4px 16px rgba(12,14,30,0.16)",
                }}
              >
                <ActivityIndicator size="small" color={colors.secondaryLabel} />
                <Text numberOfLines={1} style={[type.footnote, { color: colors.label, maxWidth: 220 }]}>
                  正在上传 {uploading}
                </Text>
              </View>
            </View>
          ) : null}
          {gone ? (
            <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", backgroundColor: theme.background }}>
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>这个终端已经删除</Text>
            </View>
          ) : null}
        </View>
        <View style={{ backgroundColor: colors.plain, borderTopWidth: 0.5, borderTopColor: colors.separator, paddingBottom: keyboardOpen ? 0 : insets.bottom }}>
          {ended ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 }}>
              <Icon
                sf={state?.failed ? "exclamationmark.triangle.fill" : info?.interrupted ? "bolt.horizontal.circle.fill" : "checkmark.circle.fill"}
                md={state?.failed ? "warning" : info?.interrupted ? "power_off" : "check_circle"}
                size={16}
                color={state?.failed ? colors.danger : colors.secondaryLabel}
              />
              <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.secondaryLabel }]}>
                {state?.detail}
              </Text>
              <Button title="重新运行" variant="primary" size="small" onPress={rerun} />
            </View>
          ) : (
            <KeyBar
              ctrl={ctrl}
              onToggleCtrl={() => setCtrl((value) => !value)}
              onKey={send}
              onHideKeyboard={() => {
                haptics.selection();
                view.current?.blur();
              }}
            />
          )}
        </View>
      </Animated.View>
    </View>
  );
}
