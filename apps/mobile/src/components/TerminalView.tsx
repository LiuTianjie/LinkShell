import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Clipboard,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ListRenderItemInfo, LayoutChangeEvent } from "react-native";
import { InputBar, type InputBarHandle } from "./InputBar";
import type { TerminalStream } from "../hooks/useSession";
import { useTheme } from "../theme";
import {
  appendTerminalChunk,
  clearTerminalBuffer,
  createTerminalBuffer,
  createTerminalSnapshot,
  replaceTerminalBuffer,
  setTerminalSize,
  type TerminalRenderLine,
} from "../utils/terminal-buffer";

export interface TerminalViewHandle {
  clear: () => void;
  resize: (cols: number, rows: number) => void;
  refit: (stickToBottom?: boolean) => void;
  scrollToBottom: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusCursor: () => void;
  blurCursor: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
}

interface TerminalViewProps {
  stream: TerminalStream;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  disabled?: boolean;
}

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 22;

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ disabled = false, stream, onInput, onResize }, ref) {
    const { theme } = useTheme();
    const bufferRef = useRef(createTerminalBuffer());
    const inputRef = useRef<InputBarHandle>(null);
    const listRef = useRef<FlatList<TerminalRenderLine>>(null);
    const frameRef = useRef<number | null>(null);
    const shouldStickToBottomRef = useRef(true);
    const rowsRef = useRef(24);
    const colsRef = useRef(80);
    const viewportHeightRef = useRef(0);
    const viewportWidthRef = useRef(0);
    const charSizeRef = useRef({ width: DEFAULT_FONT_SIZE * 0.62, height: DEFAULT_FONT_SIZE * 1.35 });
    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
    const [isFocused, setIsFocused] = useState(false);
    const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
    const [snapshot, setSnapshot] = useState(() => createTerminalSnapshot(bufferRef.current));

    const lineHeight = useMemo(() => Math.round(fontSize * 1.35), [fontSize]);
    const fontFamily = useMemo(
      () => ({ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" as const }),
      [],
    );
    const selectedText = useMemo(() => {
      if (selectedLineId === null) {
        return "";
      }
      return snapshot.lines.find((line) => line.id === selectedLineId)?.plainText ?? "";
    }, [selectedLineId, snapshot.lines]);

    const flushSnapshot = useCallback(() => {
      const cursorRow = isFocused ? bufferRef.current.cursorRow : undefined;
      const cursorCol = isFocused ? bufferRef.current.cursorCol : undefined;
      setSnapshot(createTerminalSnapshot(bufferRef.current, {
        cursorRow,
        cursorCol,
        cursorStyle: isFocused
          ? { bg: theme.accent, fg: theme.textInverse }
          : undefined,
      }));
    }, [isFocused, theme.accent, theme.textInverse]);

    const scheduleFlush = useCallback(() => {
      if (frameRef.current !== null) {
        return;
      }

      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        flushSnapshot();
        if (shouldStickToBottomRef.current) {
          requestAnimationFrame(() => {
            listRef.current?.scrollToEnd({ animated: false });
          });
        }
      });
    }, [flushSnapshot]);

    const emitResize = useCallback(() => {
      const width = viewportWidthRef.current;
      const height = viewportHeightRef.current;
      const charWidth = charSizeRef.current.width;
      const charHeight = charSizeRef.current.height;
      if (width <= 0 || height <= 0 || charWidth <= 0 || charHeight <= 0) {
        return;
      }

      const nextCols = Math.max(1, Math.floor((width - 8) / charWidth));
      const nextRows = Math.max(1, Math.floor(Math.max(0, height - 8) / charHeight));
      colsRef.current = nextCols;
      rowsRef.current = nextRows;
      setTerminalSize(bufferRef.current, nextCols, nextRows);
      onResize?.(nextCols, nextRows);
      scheduleFlush();
    }, [onResize, scheduleFlush]);

    const scrollToBottom = useCallback((animated = false) => {
      shouldStickToBottomRef.current = true;
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated });
      });
    }, []);

    useEffect(() => {
      const initial = stream.getSnapshot();
      replaceTerminalBuffer(bufferRef.current, initial.chunks, colsRef.current, rowsRef.current);
      flushSnapshot();
    }, [flushSnapshot, stream]);

    useEffect(() => {
      const unsubscribe = stream.subscribe((event) => {
        if (event.type === "reset") {
          replaceTerminalBuffer(bufferRef.current, event.snapshot.chunks, colsRef.current, rowsRef.current);
          shouldStickToBottomRef.current = true;
          scheduleFlush();
          return;
        }

        appendTerminalChunk(bufferRef.current, event.chunk);
        scheduleFlush();
      });

      return unsubscribe;
    }, [scheduleFlush, stream]);

    useEffect(() => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    }, []);

    useEffect(() => {
      emitResize();
    }, [emitResize, fontSize, lineHeight]);

    useImperativeHandle(ref, () => ({
      clear() {
        clearTerminalBuffer(bufferRef.current);
        setSelectedLineId(null);
        shouldStickToBottomRef.current = true;
        scheduleFlush();
      },
      resize(cols: number, rows: number) {
        colsRef.current = cols;
        rowsRef.current = rows;
        setTerminalSize(bufferRef.current, cols, rows);
        scheduleFlush();
      },
      refit(stickToBottom = false) {
        if (stickToBottom) {
          shouldStickToBottomRef.current = true;
        }
        emitResize();
      },
      scrollToBottom() {
        scrollToBottom(false);
      },
      zoomIn() {
        setFontSize((current) => Math.min(MAX_FONT_SIZE, current + 1));
      },
      zoomOut() {
        setFontSize((current) => Math.max(MIN_FONT_SIZE, current - 1));
      },
      resetZoom() {
        setFontSize(DEFAULT_FONT_SIZE);
      },
      focusCursor() {
        if (disabled) {
          return;
        }
        inputRef.current?.focus();
        scrollToBottom(false);
      },
      blurCursor() {
        inputRef.current?.blur();
      },
      copy() {
        const text = selectedText || snapshot.plainText;
        if (text) {
          Clipboard.setString(text);
        }
      },
      async paste() {
        if (disabled) {
          return;
        }
        const text = await Clipboard.getString();
        if (text) {
          onInput?.(text);
        }
      },
      selectAll() {
        const text = snapshot.plainText;
        if (text) {
          Clipboard.setString(text);
        }
      },
    }), [disabled, emitResize, onInput, scheduleFlush, scrollToBottom, selectedText, snapshot.plainText]);

    const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      viewportWidthRef.current = width;
      viewportHeightRef.current = height;
      emitResize();
    }, [emitResize]);

    const handleCharMeasureLayout = useCallback((event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      if (width <= 0 || height <= 0) {
        return;
      }
      charSizeRef.current = {
        width: width / 10,
        height,
      };
      emitResize();
    }, [emitResize]);

    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      shouldStickToBottomRef.current =
        contentOffset.y + layoutMeasurement.height >= contentSize.height - lineHeight * 2;
    }, [lineHeight]);

    const handleContentSizeChange = useCallback(() => {
      if (shouldStickToBottomRef.current) {
        scrollToBottom(false);
      }
    }, [scrollToBottom]);

    const handleFocusChange = useCallback((focused: boolean) => {
      setIsFocused(focused);
      if (focused) {
        scrollToBottom(false);
      }
    }, [scrollToBottom]);

    const handleLinePress = useCallback((line: TerminalRenderLine) => {
      setSelectedLineId(line.id);
      if (!disabled) {
        inputRef.current?.focus();
      }
    }, [disabled]);

    const handleLineLongPress = useCallback((line: TerminalRenderLine) => {
      if (!line.plainText) {
        if (!disabled) {
          inputRef.current?.focus();
        }
        return;
      }
      setSelectedLineId(line.id);
      Clipboard.setString(line.plainText);
      if (!disabled) {
        inputRef.current?.focus();
      }
    }, [disabled]);

    const renderItem = useCallback(({ item }: ListRenderItemInfo<TerminalRenderLine>) => (
      <TerminalLineRow
        fontFamily={fontFamily}
        fontSize={fontSize}
        line={item}
        lineHeight={lineHeight}
        onLongPress={handleLineLongPress}
        onPress={handleLinePress}
        selected={item.id === selectedLineId}
        theme={theme}
      />
    ), [fontFamily, fontSize, handleLineLongPress, handleLinePress, lineHeight, selectedLineId, theme]);

    return (
      <View style={[styles.container, { backgroundColor: theme.bgTerminal }]} onLayout={handleViewportLayout}>
        <Text
          onLayout={handleCharMeasureLayout}
          style={[
            styles.measureText,
            fontFamily,
            { fontSize, lineHeight, color: theme.bgTerminal },
          ]}
        >
          MMMMMMMMMM
        </Text>

        <FlatList
          ref={listRef}
          data={snapshot.lines}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="always"
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          style={styles.list}
        />

        <InputBar
          ref={inputRef}
          disabled={disabled || !onInput}
          onFocusChange={handleFocusChange}
          onSendText={(text) => {
            scrollToBottom(false);
            onInput?.(text);
          }}
          onSpecialKey={(key) => {
            scrollToBottom(false);
            onInput?.(key);
          }}
        />
      </View>
    );
  },
);

const TerminalLineRow = memo(function TerminalLineRow({
  fontFamily,
  fontSize,
  line,
  lineHeight,
  onLongPress,
  onPress,
  selected,
  theme,
}: {
  fontFamily: { fontFamily: string };
  fontSize: number;
  line: TerminalRenderLine;
  lineHeight: number;
  onLongPress: (line: TerminalRenderLine) => void;
  onPress: (line: TerminalRenderLine) => void;
  selected: boolean;
  theme: ReturnType<typeof useTheme>["theme"];
}) {
  return (
    <Pressable
      delayLongPress={250}
      onLongPress={() => onLongPress(line)}
      onPress={() => onPress(line)}
      style={({ pressed }) => [
        styles.linePressable,
        {
          backgroundColor: selected
            ? theme.accentLight
            : pressed
              ? theme.mode === "dark"
                ? "rgba(255,255,255,0.04)"
                : "rgba(58,95,200,0.06)"
              : "transparent",
        },
      ]}
    >
      <Text
        style={[
          styles.lineText,
          fontFamily,
          {
            color: theme.text,
            fontSize,
            lineHeight,
          },
        ]}
      >
        {line.segments.length > 0
          ? line.segments.map((segment, index) => {
            const fg = segment.style.inverse ? segment.style.bg ?? theme.bgTerminal : segment.style.fg ?? theme.text;
            const bg = segment.style.inverse ? segment.style.fg ?? theme.text : segment.style.bg;
            return (
              <Text
                key={`${line.id}:${index}`}
                style={{
                  color: fg,
                  backgroundColor: bg,
                  fontWeight: segment.style.bold ? "700" : "400",
                }}
              >
                {segment.text.length > 0 ? segment.text : " "}
              </Text>
            );
          })
          : "\u200b"}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  linePressable: {
    borderRadius: 6,
    paddingHorizontal: 2,
  },
  lineText: {
    includeFontPadding: false,
  },
  measureText: {
    position: "absolute",
    opacity: 0,
    left: -1000,
    top: -1000,
  },
});
