import { useTerminalFontSize, setTerminalFontSize, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_DEFAULT } from "@/lib/terminal-preferences";
import { File } from "expo-file-system";
import { restoreTerminalRecording, restoreTerminalState } from "@/lib/terminal-replay";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, useColorScheme, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { usePageInsets } from "@/components/adaptive-page";
import { Button } from "@/components/button";
import { BranchTag } from "@/components/branch-tag";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { KeyBar } from "@/components/terminal/key-bar";
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
  const terminalSize = useRef<{ id: string; cols: number; rows: number } | null>(null);
  const keyboardOpen = useKeyboardState((state) => state.isVisible);
  // Follow the keyboard frame by frame: the terminal shrinks with it, so the
  // prompt and the key bar stay just above the keys.
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(-keyboardHeight.value, 0) }));
  const theme = useColorScheme() === "dark" ? darkTerminal : lightTerminal;
  const view = useRef<NativeTerminalHandle>(null);
  const fontSize = useTerminalFontSize();
  const [ctrl, setCtrl] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const attaching = useRef(true);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let seq: number | undefined;
    let frame: number | undefined;
    let held: { seq: number; data: string; frame?: number }[] = [];
    let heldBytes = 0;
    let overflowed = false;
    let chain = Promise.resolve();
    attaching.current = true;
    setRestoring(true);
    setRestoreError(null);

    const write = async (chunk: { seq: number; data: string; frame?: number }) => {
      if (!active || (seq !== undefined && chunk.seq <= seq)) return;
      const native = view.current;
      if (!native) throw new Error("终端尚未就绪");
      await native.write(chunk.data);
      seq = chunk.seq;
      frame = chunk.frame;
    };
    const attach = () => {
      const attempt = ++generation;
      attaching.current = true;
      setRestoring(true);
      setRestoreError(null);
      chain = chain.catch(() => {}).then(async () => {
        if (!active || attempt !== generation) return;
        try {
          const native = view.current;
          if (!native) throw new Error("终端尚未就绪");
          const result = await link.call("terminals.attach", { terminalId: id, fromSeq: seq, replayFormat: "frames-v1", fromFrame: frame, snapshot: true });
          if (!active || attempt !== generation) return;
          if (result.state) {
            const state = result.state;
            await restoreTerminalState(native, state,
              (offset) => link.call("terminals.state", { terminalId: id, snapshotId: state.snapshotId, offset }),
              () => active && attempt === generation);
            frame = state.frame;
          } else if (result.recording) {
            await restoreTerminalRecording(native, result.recording,
              (afterFrame, throughFrame) => link.call("terminals.replay", { terminalId: id, afterFrame, throughFrame }),
              () => active && attempt === generation);
            frame = result.recording.throughFrame;
          } else {
            // Older hosts expose a text snapshot; mute its terminal queries too.
            await native.beginReplay(result.reset);
            try { await native.replay(result.replay, result.terminal.cols, result.terminal.rows); }
            finally { await native.endReplay(); }
            frame = undefined;
          }
          seq = result.seq;
          if (overflowed) { overflowed = false; held = []; heldBytes = 0; attach(); return; }
          heldBytes = 0;
          while (held.length && active && attempt === generation) await write(held.shift()!);
          if (!active || attempt !== generation) return;
          attaching.current = false;
          setRestoring(false);
          const size = terminalSize.current;
          if (size?.id === id) void link.call("terminals.resize", { terminalId: id, cols: size.cols, rows: size.rows }).catch(() => {});
        } catch (error) {
          seq = undefined; frame = undefined; held = [];
          if (active && attempt === generation) {
            setRestoring(false);
            setRestoreError(error instanceof Error ? error.message : "终端恢复失败");
          }
        }
      });
    };
    const offOutput = link.on("terminal.output", (chunk) => {
      if (chunk.terminalId !== id) return;
      if (attaching.current) {
        if (!overflowed) {
          heldBytes += chunk.data.length;
          if (heldBytes > 4 * 1024 * 1024) { held = []; overflowed = true; }
          else held.push(chunk);
        }
        return;
      }
      chain = chain.then(() => write(chunk)).catch(() => { if (active) attach(); });
    });
    attach();
    const offOnline = link.onOnline(attach);
    return () => {
      active = false; generation++;
      offOutput(); offOnline();
      void link.call("terminals.detach", { terminalId: id }).catch(() => {});
    };
  }, [id, link, retry]);

  const send = useCallback((data: string) => {
    if (attaching.current) return;
    void link.call("terminals.input", { terminalId: id, data }).catch(() => {});
  }, [id, link]);

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
  const uploadQueue = useRef(Promise.resolve());
  const uploadContext = useRef<string | null>(id);
  useEffect(() => { uploadContext.current = id; return () => { uploadContext.current = null; }; }, [id]);
  const sendPickedFile = (file: Picked, temporary = false) => {
    const cleanup = () => {
      if (temporary) { try { new File(file.uri).delete(); } catch { /* OS cache cleanup can race us. */ } }
    };
    if (!info || ended || !view.current) { cleanup(); return; }
    const destination = view.current;
    const cwd = info.cwd;
    uploadQueue.current = uploadQueue.current.catch(() => {}).then(async () => {
      if (uploadContext.current === id) setUploading(file.name);
      try {
        const path = await upload(link, file, cwd);
        if (uploadContext.current !== id || view.current !== destination) return;
        if (attaching.current) throw new Error("终端正在恢复，请恢复后再粘贴文件路径");
        await destination.paste(`${shellQuote(path)} `);
        haptics.success();
      } catch (reason) {
        if (uploadContext.current === id) {
          haptics.error();
          Alert.alert("上传失败", reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        cleanup();
        if (uploadContext.current === id) setUploading(null);
      }
    });
  };
  const sendFile = async (pick: () => Promise<Picked | null>) => {
    const file = await pick().catch(() => null);
    if (file) sendPickedFile(file);
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
                title: `放大字号（${fontSize}）`,
                icon: { sf: "textformat.size.larger", md: "text_increase" },
                onPress: () => setTerminalFontSize(Math.min(fontSize + 1, TERMINAL_FONT_MAX)),
              },
              {
                title: fontSize <= TERMINAL_FONT_MIN ? `已是最小字号（${TERMINAL_FONT_MIN}）` : `缩小字号（${fontSize}）`,
                icon: { sf: "textformat.size.smaller", md: "text_decrease" },
                onPress: () => setTerminalFontSize(Math.max(fontSize - 1, TERMINAL_FONT_MIN)),
              },
              {
                title: `恢复默认字号（${TERMINAL_FONT_DEFAULT}）`,
                icon: { sf: "arrow.counterclockwise", md: "restart_alt" },
                onPress: () => setTerminalFontSize(TERMINAL_FONT_DEFAULT),
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
            fontSize={fontSize}
            onInput={send}
            onFile={(file) => sendPickedFile(file, true)}
            onError={(message) => Alert.alert("终端", message)}
            onFontSize={setTerminalFontSize}
            onModifiers={({ ctrl: active }) => setCtrl(active)}
            onResize={(cols, rows) => {
              // Rotation and folding can briefly report an empty native surface. Keep the running PTY valid.
              if (cols < 2 || rows < 1 || (terminalSize.current?.id === id && terminalSize.current?.cols === cols && terminalSize.current?.rows === rows)) return;
              terminalSize.current = { id, cols: Math.max(10, cols), rows: Math.max(4, rows) };
              if (attaching.current) return;
              void link.call("terminals.resize", { terminalId: id, cols: Math.max(10, cols), rows: Math.max(4, rows) }).catch(() => { terminalSize.current = null; });
            }}
            style={{ flex: 1, backgroundColor: theme.background }}
          />
          {restoring || restoreError ? (
            <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: theme.background }}>
              {restoring ? <ActivityIndicator color={colors.secondaryLabel} /> : null}
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{restoreError || "正在恢复终端…"}</Text>
              {restoreError ? <Button title="重试" onPress={() => setRetry((value) => value + 1)} /> : null}
            </View>
          ) : null}
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
              onToggleCtrl={() => { if (!attaching.current) void view.current?.toggleCtrl().catch(() => {}); }}
              onKey={(name, modifiers) => { if (!attaching.current) void view.current?.key(name, modifiers).catch(() => {}); }}
              onImage={() => { if (!attaching.current) void sendFile(pickPhoto); }}
              onPaste={() => { if (!attaching.current) void view.current?.pasteClipboard().catch(() => {}); }}
              onHideKeyboard={() => {
                haptics.selection();
                void view.current?.blur().catch(() => {});
              }}
            />
          )}
        </View>
      </Animated.View>
    </View>
  );
}
