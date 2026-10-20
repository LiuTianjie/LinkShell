import { useTerminalFontSize, setTerminalFontSize, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_DEFAULT } from "@/lib/terminal-preferences";
import * as Clipboard from "expo-clipboard";
import { File } from "expo-file-system";
import { restoreTerminalRecording, restoreTerminalState } from "@/lib/terminal-replay";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { usePageInsets } from "@/components/adaptive-page";
import { Button } from "@/components/button";
import { BranchTag } from "@/components/branch-tag";
import { Glass } from "@/components/glass";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { KeyBar } from "@/components/terminal/key-bar";
import { SnippetBar } from "@/components/terminal/snippet-bar";
import { darkTerminal, lightTerminal } from "@/components/terminal/themes";
import { VoiceInputBar } from "@/components/voice-input-bar";
import { NativeTerminal, type NativeTerminalHandle, type TerminalKeyModifiers } from "../../modules/link-terminal/src";
import { useContentWidth } from "@/lib/content-width";
import { useActions, useClient, useConnection } from "@/lib/client";
import { sessionTitle } from "@/lib/describe";
import { shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  chunkTerminalPasteText,
  cleanTerminalOutputForAgent,
  encodeTerminalKeySequence,
} from "@/lib/terminal-paste";
import { toggleTerminalSnippetsOpen, useTerminalSnippetsOpen } from "@/lib/terminal-snippets";
import { useVoiceInput } from "@/lib/voice-input";
import { branchOf, useGitInfo } from "@/lib/worktree";
import { terminalState, useTerminals } from "@/lib/terminals";
import { pickFile, pickPhoto, shellQuote, upload, type Picked } from "@/lib/upload";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

const MAX_RECENT_OUTPUT_CHARS = 65_536;

/**
 * One host terminal, full screen. Output streams in by seq; after a reconnect
 * the host sends only what was missed, or a full redraw if it no longer can.
 */
export function TerminalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { link } = useConnection();
  const { send: sendSessionPrompt } = useActions();
  const sessions = useClient((state) => state.sessions);
  const hostPlatform = useClient((state) => state.machine?.platform);
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
  const fontDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snippetsOpen = useTerminalSnippetsOpen();
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [cmd, setCmd] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const attaching = useRef(true);
  const recentOutputRef = useRef("");
  const lastFrameRef = useRef<number | undefined>(undefined);

  const appendRecentOutput = useCallback((chunk: string) => {
    if (!chunk) return;
    const next = recentOutputRef.current + chunk;
    recentOutputRef.current =
      next.length > MAX_RECENT_OUTPUT_CHARS ? next.slice(-MAX_RECENT_OUTPUT_CHARS) : next;
  }, []);

  const handleDebouncedFontSize = useCallback((nextSize: number) => {
    if (fontDebounceRef.current) clearTimeout(fontDebounceRef.current);
    fontDebounceRef.current = setTimeout(() => {
      setTerminalFontSize(nextSize);
    }, 180);
  }, []);

  useEffect(() => {
    return () => {
      if (fontDebounceRef.current) clearTimeout(fontDebounceRef.current);
    };
  }, []);

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
    recentOutputRef.current = "";
    lastFrameRef.current = undefined;
    setRestoring(true);
    setRestoreError(null);

    const write = async (chunk: { seq: number; data: string; frame?: number }) => {
      if (!active || (seq !== undefined && chunk.seq <= seq)) return;
      const native = view.current;
      if (!native) throw new Error("终端尚未就绪");
      appendRecentOutput(chunk.data);
      await native.write(chunk.data);
      seq = chunk.seq;
      frame = chunk.frame;
      if (chunk.frame !== undefined) lastFrameRef.current = chunk.frame;
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
          // Wait for the native terminal surface to mount so supportsReplay() is accurate.
          await native.endReplay();
          const canReplayFrames = native.supportsReplay();
          const result = await link.call(
            "terminals.attach",
            canReplayFrames
              ? { terminalId: id, fromSeq: seq, replayFormat: "frames-v1", fromFrame: frame, snapshot: true }
              : { terminalId: id, fromSeq: seq },
          );
          if (!active || attempt !== generation) return;
          if (canReplayFrames && result.state) {
            const state = result.state;
            await restoreTerminalState(
              native,
              state,
              (offset) => link.call("terminals.state", { terminalId: id, snapshotId: state.snapshotId, offset }),
              () => active && attempt === generation,
            );
            frame = state.frame;
            lastFrameRef.current = state.frame;
          } else if (canReplayFrames && result.recording) {
            await restoreTerminalRecording(
              native,
              result.recording,
              async (afterFrame, throughFrame) => {
                const page = await link.call("terminals.replay", { terminalId: id, afterFrame, throughFrame });
                for (const f of page.frames) appendRecentOutput(f.data);
                return page;
              },
              () => active && attempt === generation,
            );
            frame = result.recording.throughFrame;
            lastFrameRef.current = result.recording.throughFrame;
          } else {
            appendRecentOutput(result.replay);
            await native.beginReplay(result.reset);
            try {
              await native.replay(result.replay, result.terminal.cols, result.terminal.rows);
            } finally {
              await native.endReplay();
            }
            frame = undefined;
          }
          seq = result.seq;
          if (overflowed) {
            overflowed = false;
            held = [];
            heldBytes = 0;
            attach();
            return;
          }
          heldBytes = 0;
          while (held.length && active && attempt === generation) await write(held.shift()!);
          if (!active || attempt !== generation) return;
          attaching.current = false;
          setRestoring(false);
          const size = terminalSize.current;
          if (size?.id === id) void link.call("terminals.resize", { terminalId: id, cols: size.cols, rows: size.rows }).catch(() => {});
        } catch (error) {
          seq = undefined;
          frame = undefined;
          held = [];
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
          if (heldBytes > 4 * 1024 * 1024) {
            held = [];
            overflowed = true;
          } else held.push(chunk);
        }
        return;
      }
      chain = chain.then(() => write(chunk)).catch(() => {
        if (active) attach();
      });
    });
    attach();
    const offOnline = link.onOnline(attach);
    return () => {
      active = false;
      generation++;
      offOutput();
      offOnline();
      void link.call("terminals.detach", { terminalId: id }).catch(() => {});
    };
  }, [appendRecentOutput, id, link, retry]);

  const send = useCallback(
    (data: string) => {
      if (attaching.current) return;
      if ((alt || cmd) && data.length === 1) {
        const encoded = encodeTerminalKeySequence(data, { ctrl, alt, cmd });
        setAlt(false);
        setCmd(false);
        if (encoded) {
          void link.call("terminals.input", { terminalId: id, data: encoded }).catch(() => {});
          return;
        }
      }
      void link.call("terminals.input", { terminalId: id, data }).catch(() => {});
    },
    [alt, cmd, ctrl, id, link],
  );

  const pasteSafeChunked = useCallback(
    async (rawText: string) => {
      if (attaching.current) return;
      const chunks = chunkTerminalPasteText(rawText);
      if (chunks.length === 0) return;
      for (const chunk of chunks) {
        await link.call("terminals.input", { terminalId: id, data: chunk });
      }
    },
    [id, link],
  );

  const handlePasteClipboard = useCallback(async () => {
    if (attaching.current) return;
    try {
      const clip = await Clipboard.getStringAsync();
      if (clip) {
        await pasteSafeChunked(clip);
        haptics.selection();
        return;
      }
    } catch {
      // Fall back to native pasteClipboard
    }
    await view.current?.pasteClipboard().catch(() => {});
  }, [pasteSafeChunked]);

  const handleKey = useCallback(
    (name: string, modifiers?: TerminalKeyModifiers) => {
      if (attaching.current) return;
      if (alt || cmd) {
        const seq = encodeTerminalKeySequence(name, {
          ...modifiers,
          ctrl: modifiers?.ctrl || ctrl,
          alt: modifiers?.alt || alt,
          cmd,
        });
        setAlt(false);
        setCmd(false);
        if (seq) {
          send(seq);
          return;
        }
      }
      void view.current?.key(name, modifiers).catch(() => {});
    },
    [alt, cmd, ctrl, send],
  );

  const captureOutputToAgent = useCallback(async () => {
    let raw = recentOutputRef.current;
    if (!raw.trim() && lastFrameRef.current && lastFrameRef.current > 0) {
      try {
        const throughFrame = lastFrameRef.current;
        const afterFrame = Math.max(0, throughFrame - 64);
        const page = await link.call("terminals.replay", { terminalId: id, afterFrame, throughFrame });
        raw = page.frames.map((f) => f.data).join("");
        appendRecentOutput(raw);
      } catch {
        // ignore replay fetch error
      }
    }
    const cleaned = cleanTerminalOutputForAgent(raw, 60);
    if (!cleaned.trim()) {
      Alert.alert("抓取终端输出", "当前终端暂无可发送的输出内容。");
      return;
    }
    const headerLabel = [info?.title ?? "终端", info?.cwd ? shortPath(info.cwd) : undefined].filter(Boolean).join(" · ");
    const formatted = `终端输出（${headerLabel}）：\n\`\`\`text\n${cleaned}\n\`\`\``;

    const liveSessions = Object.values(sessions)
      .filter((s) => !s.archived)
      .sort((a, b) => {
        const sameCwdA = info?.cwd && a.cwd === info.cwd ? 1 : 0;
        const sameCwdB = info?.cwd && b.cwd === info.cwd ? 1 : 0;
        return sameCwdB - sameCwdA || b.updatedAt - a.updatedAt;
      })
      .slice(0, 3);

    Alert.alert(
      "发送终端输出给 AI",
      `已抓取最近 ${cleaned.split("\n").length} 行终端输出`,
      [
        ...liveSessions.map((target) => ({
          text: `发送到：${sessionTitle(target).slice(0, 22)}`,
          onPress: () => {
            haptics.success();
            void sendSessionPrompt(target.id, [{ type: "text", text: formatted }]);
            router.push({ pathname: "/session/[id]", params: { id: target.id } });
          },
        })),
        {
          text: "仅复制干净输出",
          onPress: () => {
            void Clipboard.setStringAsync(cleaned);
            haptics.success();
          },
        },
        { text: "取消", style: "cancel" as const },
      ],
    );
  }, [appendRecentOutput, id, info?.cwd, info?.title, link, sendSessionPrompt, sessions]);

  const terminalVoice = useVoiceInput({
    currentText: voiceDraft,
    onChangeText: setVoiceDraft,
    onSendAfterStop: (finalText) => {
      if (!attaching.current && finalText.trim()) {
        send(`${finalText.trim()}\r`);
        setVoiceDraft("");
      }
    },
    onError: (msg) => Alert.alert("语音输入", msg),
  });
  const cancelTerminalVoice = terminalVoice.cancel;
  useFocusEffect(useCallback(() => {
    if (!id) return;
    return () => { void cancelTerminalVoice(); };
  }, [cancelTerminalVoice, id]));

  const state = info ? terminalState(info) : undefined;
  const ended = state?.ended ?? false;

  const close = () => {
    Alert.alert(ended ? "删除这条记录？" : "关闭这个终端？", ended ? "它的输出也会一起删除。" : "里面正在运行的程序会被结束，记录会一起删除。", [
      { text: "取消", style: "cancel" },
      {
        text: ended ? "删除" : "关闭",
        style: "destructive",
        onPress: async () => {
          try {
            await link.call("terminals.close", { terminalId: id });
            router.dismissTo("/");
          } catch (reason) {
            Alert.alert(ended ? "删除失败" : "关闭失败", reason instanceof Error ? reason.message : String(reason));
          }
        },
      },
    ]);
  };

  // A file from the phone lands in the terminal's directory, and its path is
  // typed at the prompt, the way dropping a file on a desktop terminal does.
  const [uploading, setUploading] = useState<string | null>(null);
  const uploadQueue = useRef(Promise.resolve());
  const uploadContext = useRef<string | null>(id);
  useEffect(() => {
    uploadContext.current = id;
    return () => {
      uploadContext.current = null;
    };
  }, [id]);
  const sendPickedFile = (file: Picked, temporary = false) => {
    const cleanup = () => {
      if (temporary) {
        try {
          new File(file.uri).delete();
        } catch {
          /* OS cache cleanup can race us. */
        }
      }
    };
    if (!info || ended || !view.current) {
      cleanup();
      return;
    }
    const destination = view.current;
    const cwd = info.cwd;
    uploadQueue.current = uploadQueue.current.catch(() => {}).then(async () => {
      if (uploadContext.current === id) setUploading(file.name);
      try {
        const path = await upload(link, file, cwd);
        if (uploadContext.current !== id || view.current !== destination) return;
        if (attaching.current) throw new Error("终端正在恢复，请恢复后再粘贴文件路径");
        await pasteSafeChunked(`${shellQuote(path)} `);
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

  const showCmd = !hostPlatform || hostPlatform === "darwin";

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
                title: "抓取输出发给 AI",
                icon: { sf: "sparkles", md: "auto_awesome" },
                onPress: () => void captureOutputToAgent(),
              },
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
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 14, paddingBottom: 6 }}>
          <Pressable
            onPress={() => {
              haptics.selection();
              router.push({ pathname: "/files", params: { path: info.cwd } });
            }}
            accessibilityRole="button"
            accessibilityLabel={`打开目录 ${shortPath(info.cwd)}`}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 10,
              height: 26,
              borderRadius: 13,
              borderCurve: "continuous",
              backgroundColor: pressed ? colors.fillStrong : colors.fill,
              flexShrink: 1,
            })}
          >
            <Icon sf="folder" md="folder_open" size={12} color={colors.secondaryLabel} />
            <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, fontWeight: "500", flexShrink: 1 }]}>
              {shortPath(info.cwd)}
            </Text>
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {branch ? <BranchTag branch={branch} max={18} /> : null}
            <View
              style={{
                paddingHorizontal: 8,
                height: 22,
                borderRadius: 11,
                borderCurve: "continuous",
                backgroundColor: colors.fill,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontFamily: mono, fontSize: 10.5, color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }}>
                {info.cols}×{info.rows}
              </Text>
            </View>
          </View>
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
            onFontSize={handleDebouncedFontSize}
            onModifiers={({ ctrl: active }) => setCtrl(active)}
            onResize={(cols, rows) => {
              if (cols < 2 || rows < 1 || (terminalSize.current?.id === id && terminalSize.current?.cols === cols && terminalSize.current?.rows === rows)) return;
              terminalSize.current = { id, cols: Math.max(10, cols), rows: Math.max(4, rows) };
              if (attaching.current) return;
              void link.call("terminals.resize", { terminalId: id, cols: Math.max(10, cols), rows: Math.max(4, rows) }).catch(() => {
                terminalSize.current = null;
              });
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
              <Glass style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18 }}>
                <ActivityIndicator size="small" color={colors.secondaryLabel} />
                <Text numberOfLines={1} style={[type.footnote, { color: colors.label, maxWidth: 220 }]}>
                  正在上传 {uploading}
                </Text>
              </Glass>
            </View>
          ) : null}
          {gone ? (
            <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", backgroundColor: theme.background }}>
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>这个终端已经删除</Text>
            </View>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 10, paddingTop: 4, paddingBottom: keyboardOpen ? 6 : insets.bottom + 8 }}>
          <Glass style={{ borderRadius: 24, overflow: "hidden" }}>
            {ended ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
                <Icon
                  sf={state?.failed ? "exclamationmark.triangle.fill" : info?.interrupted ? "bolt.horizontal.circle.fill" : "checkmark.circle.fill"}
                  md={state?.failed ? "warning" : info?.interrupted ? "power_off" : "check_circle"}
                  size={16}
                  color={state?.failed ? colors.danger : colors.secondaryLabel}
                />
                <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.secondaryLabel }]}>
                  {state?.detail}
                </Text>
                <Button title="发给 AI" variant="tonal" size="small" onPress={() => void captureOutputToAgent()} />
                <Button title="重新运行" variant="primary" size="small" onPress={rerun} />
              </View>
            ) : (
              <>
                {terminalVoice.recording ? (
                  <View style={{ paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }}>
                    {voiceDraft ? (
                      <Text numberOfLines={2} style={{ fontFamily: mono, fontSize: 13, color: colors.label, paddingHorizontal: 8, paddingBottom: 4 }}>
                        {voiceDraft}
                      </Text>
                    ) : null}
                    <VoiceInputBar
                      elapsedSeconds={terminalVoice.elapsedSeconds}
                      levels={terminalVoice.levels}
                      canceling={terminalVoice.canceling}
                      processing={terminalVoice.processing}
                      hasText={voiceDraft.trim().length > 0}
                      onCancel={() => {
                        void terminalVoice.cancel();
                      }}
                      onFinish={() => void terminalVoice.stop(false)}
                      onSendNow={() => void terminalVoice.stop(true)}
                      onInjectPhrase={(phrase) => setVoiceDraft(phrase)}
                    />
                  </View>
                ) : null}
                {!terminalVoice.recording && voiceDraft ? (
                  <View style={{ padding: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }}>
                    <TextInput
                      accessibilityLabel="语音识别草稿"
                      value={voiceDraft}
                      onChangeText={setVoiceDraft}
                      multiline
                      autoCorrect={false}
                      style={[type.callout, { color: colors.label, maxHeight: 100, minHeight: 44 }]}
                    />
                    <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                      <Button title="清除" variant="tonal" size="small" onPress={() => setVoiceDraft("")} />
                      <Button title="插入终端" variant="primary" size="small" onPress={() => {
                        if (attaching.current) return;
                        void pasteSafeChunked(voiceDraft.trim()).then(() => setVoiceDraft("")).catch(() => {});
                      }} />
                    </View>
                  </View>
                ) : null}
                {snippetsOpen ? (
                  <SnippetBar
                    onSendInput={send}
                    onPaste={(text) => {
                      if (!attaching.current) void pasteSafeChunked(text).catch(() => {});
                    }}
                    onKey={handleKey}
                    onCaptureOutput={() => void captureOutputToAgent()}
                  />
                ) : null}
                <KeyBar
                  ctrl={ctrl}
                  alt={alt}
                  cmd={cmd}
                  showCmd={showCmd}
                  keyboardOpen={keyboardOpen}
                  snippetsOpen={snippetsOpen}
                  onToggleSnippets={toggleTerminalSnippetsOpen}
                  onVoice={() => {
                    void terminalVoice.start();
                  }}
                  onToggleCtrl={() => {
                    if (!attaching.current) void view.current?.toggleCtrl().catch(() => {});
                  }}
                  onToggleAlt={() => setAlt((v) => !v)}
                  onToggleCmd={() => setCmd((v) => !v)}
                  onKey={handleKey}
                  onImage={() => {
                    if (!attaching.current) void sendFile(pickPhoto);
                  }}
                  onPaste={() => void handlePasteClipboard()}
                  onHideKeyboard={() => {
                    haptics.selection();
                    void view.current?.blur().catch(() => {});
                  }}
                />
              </>
            )}
          </Glass>
        </View>
      </Animated.View>
    </View>
  );
}
