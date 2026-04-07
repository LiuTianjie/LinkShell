import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  forwardRef,
} from "react";
import {
  Animated,
  Clipboard,
  PanResponder,
  StyleSheet,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { TERMINAL_HTML } from "../generated/terminal-html";
import type { TerminalStream } from "../hooks/useSession";
import { useTheme } from "../theme";

const SCROLLBAR_WIDTH = 6;
const SCROLLBAR_MARGIN = 2;
const MIN_THUMB_HEIGHT = 30;
const SCROLLBAR_HIDE_DELAY = 1500;
const SCROLLBAR_HIT_WIDTH = 30;

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
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ stream, onInput, onResize }, ref) {
    const { theme } = useTheme();
    const webViewRef = useRef<WebView>(null);
    const readyRef = useRef(false);

    // Scrollbar state (refs to avoid re-renders)
    const scrollInfoRef = useRef({
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    });
    const trackHeightRef = useRef(0);
    const thumbTopAnim = useRef(new Animated.Value(0)).current;
    const thumbHeightRef = useRef(0);
    const scrollbarOpacity = useRef(new Animated.Value(0)).current;
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isDraggingRef = useRef(false);
    const dragStartThumbTop = useRef(0);
    const showScrollbarRef = useRef(false);

    const flashScrollbar = useCallback(() => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      Animated.timing(scrollbarOpacity, {
        toValue: 1,
        duration: 120,
        useNativeDriver: true,
      }).start();
      hideTimerRef.current = setTimeout(() => {
        if (!isDraggingRef.current) {
          Animated.timing(scrollbarOpacity, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }).start();
        }
      }, SCROLLBAR_HIDE_DELAY);
    }, [scrollbarOpacity]);

    const updateThumbPosition = useCallback(
      (info: {
        scrollTop: number;
        scrollHeight: number;
        clientHeight: number;
      }) => {
        const trackH = trackHeightRef.current;
        if (trackH <= 0 || info.scrollHeight <= info.clientHeight) {
          showScrollbarRef.current = false;
          return;
        }
        showScrollbarRef.current = true;
        const thumbH = Math.max(
          MIN_THUMB_HEIGHT,
          (info.clientHeight / info.scrollHeight) * trackH,
        );
        thumbHeightRef.current = thumbH;
        const maxThumbTop = trackH - thumbH;
        const ratio = info.scrollTop / (info.scrollHeight - info.clientHeight);
        const top = Math.max(0, Math.min(maxThumbTop, ratio * maxThumbTop));
        thumbTopAnim.setValue(top);
      },
      [thumbTopAnim],
    );

    const panResponder = useRef(
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          isDraggingRef.current = true;
          dragStartThumbTop.current = (thumbTopAnim as any)._value ?? 0;
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          Animated.timing(scrollbarOpacity, {
            toValue: 1,
            duration: 80,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderMove: (_, gs) => {
          const info = scrollInfoRef.current;
          const trackH = trackHeightRef.current;
          if (trackH <= 0 || info.scrollHeight <= info.clientHeight) return;
          const thumbH = thumbHeightRef.current;
          const maxThumbTop = trackH - thumbH;
          const newTop = Math.max(
            0,
            Math.min(maxThumbTop, dragStartThumbTop.current + gs.dy),
          );
          thumbTopAnim.setValue(newTop);
          const scrollRatio = maxThumbTop > 0 ? newTop / maxThumbTop : 0;
          const newScrollTop =
            scrollRatio * (info.scrollHeight - info.clientHeight);
          scrollInfoRef.current.scrollTop = newScrollTop;
          const js = `(function(){try{var line=Math.round(${scrollRatio}*(term.buffer.active.baseY||0));term.scrollToLine(line);}catch(e){}})();true;`;
          webViewRef.current?.injectJavaScript(js);
        },
        onPanResponderRelease: () => {
          isDraggingRef.current = false;
          flashScrollbar();
        },
        onPanResponderTerminate: () => {
          isDraggingRef.current = false;
          flashScrollbar();
        },
      }),
    ).current;

    const terminalHtml = useMemo(() => {
      const isDark = theme.mode === "dark";
      const termTheme = {
        background: theme.bgTerminal,
        foreground: isDark ? "#e2e8f0" : "#0f172a",
        cursor: theme.accent,
        selectionBackground: isDark ? "#334155" : "#cbd5e1",
      };

      // Resize bridge: refit on orientation/resize
      const resizeBridgeScript = `
<script>
(function(){
  var sched=false;
  function run(){sched=false;try{if(window.fitAddon&&window.term){if(typeof safeFit==='function')safeFit();else window.fitAddon.fit();if(typeof sendSize==='function')sendSize();}}catch(e){}}
  function schedule(){if(sched)return;sched=true;requestAnimationFrame(run);}
  window.addEventListener('orientationchange',schedule);
  window.addEventListener('resize',schedule);
  setTimeout(schedule,0);setTimeout(schedule,80);setTimeout(schedule,220);
})();
</script>`;

      // Enhance handleRNMessage with restore/refit/scroll_bottom/write/focus_cursor/set_scroll
      const enhancedHandlerScript = `
<script>
(function(){
  function restoreChunks(chunks){
    term.reset();
    if(Array.isArray(chunks) && chunks.length > 0){
      term.write(chunks.join(''));
    }
    safeFit();
    setTimeout(function(){ snapBottom(); }, 50);
    sendSize();
  }
  var prevHandle = window.handleRNMessage;
  window.handleRNMessage = function(msg){
    try{
      var p = JSON.parse(msg);
      if(p.type==='restore'){
        restoreChunks(p.chunks);
        return;
      }
      if(p.type==='refit'){
        safeFit();
        sendSize();
        return;
      }
      if(p.type==='scroll_bottom'){
        snapBottom();
        return;
      }
      if(p.type==='write'){
        var wasNear = term.buffer.active.viewportY >= term.buffer.active.baseY;
        term.write(p.data || '');
        if(wasNear) setTimeout(function(){ snapBottom(); }, 10);
        return;
      }
      if(p.type==='focus_cursor'){
        focusCursor();
        return;
      }
      if(p.type==='set_scroll'){
        if(typeof p.line==='number') term.scrollToLine(p.line);
        return;
      }
    } catch(e) {}
    if(prevHandle){
      prevHandle(msg);
    }
  };
})();
</script>`;

      // Scroll bridge: send scroll position to RN
      const scrollBridgeScript = `
<script>
(function(){
  var raf=false;
  function send(){
    raf=false;
    if(!window.term)return;
    var buf=term.buffer.active;
    var baseY=buf.baseY||0;
    var viewportY=buf.viewportY||0;
    var rows=term.rows||24;
    var totalLines=baseY+rows;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'scroll_update',
      scrollTop:viewportY,
      scrollHeight:totalLines,
      clientHeight:rows
    }));
  }
  function schedule(){if(raf)return;raf=true;requestAnimationFrame(send);}
  setTimeout(function(){
    var vp=document.querySelector('.xterm-viewport');
    if(vp)vp.addEventListener('scroll',schedule,{passive:true});
    schedule();
  },200);
})();
</script>`;

      return (
        TERMINAL_HTML.replace(
          "<html>",
          `<html style="color-scheme:${theme.mode}">`,
        )
          .replace(
            '<meta charset="utf-8"/>',
            `<meta charset="utf-8"/><meta name="color-scheme" content="${theme.mode}"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">`,
          )
          // Theme: body background
          .replace(
            /background:#020617;display:flex;flex-direction:column/g,
            `background:${theme.bgTerminal};display:flex;flex-direction:column`,
          )
          .replace(
            /background-color: #000;/g,
            `background-color: ${theme.bgTerminal};`,
          )
          // Hide xterm native scrollbar (we use our own)
          .replace(
            ".xterm-viewport::-webkit-scrollbar{width:4px}",
            ".xterm-viewport::-webkit-scrollbar{display:none;width:0}",
          )
          .replace(
            ".xterm-viewport::-webkit-scrollbar-thumb{background:#334155;border-radius:2px}",
            ".xterm-viewport::-webkit-scrollbar-thumb{display:none}",
          )
          // xterm viewport: smooth iOS touch scrolling
          .replace(
            /\.xterm-viewport\{-webkit-overflow-scrolling:touch !important;overscroll-behavior:contain !important;\}/,
            `.xterm-viewport{-webkit-overflow-scrolling:touch !important;touch-action:pan-y !important;overscroll-behavior:contain !important;}`,
          )
          // Hide xterm 6.x scrollable-element scrollbar
          .replace(
            "</style>",
            `.xterm .xterm-scrollable-element>.xterm-scrollbar{display:none !important;width:0 !important;}\n</style>`,
          )
          // Let xterm own keyboard input for IME
          .replace(
            /if \(term\.textarea\) \{\n  term\.textarea\.readOnly = true;\n  term\.textarea\.tabIndex = -1;\n  term\.textarea\.setAttribute\('inputmode', 'none'\);\n  term\.textarea\.blur\(\);\n\}/,
            `if (term.textarea) {\n  term.textarea.readOnly = false;\n  term.textarea.tabIndex = 0;\n  term.textarea.style.colorScheme = '${theme.mode}';\n  term.textarea.setAttribute('autocapitalize', 'off');\n  term.textarea.setAttribute('autocorrect', 'off');\n  term.textarea.setAttribute('spellcheck', 'false');\n  term.textarea.setAttribute('autocomplete', 'off');\n}`,
          )
          .replace(
            "window.addEventListener('resize',function(){fitAddon.fit();});",
            "window.addEventListener('resize',function(){safeFit();sendSize();});",
          )
          // Theme colors
          .replace(
            /theme:\{background:'#020617',foreground:'#e2e8f0',cursor:'#3b82f6',selectionBackground:'#334155'\}/,
            `theme:${JSON.stringify(termTheme)}`,
          )
          // Inject enhanced handler + resize bridge + scroll bridge before </body>
          .replace(
            "</body>",
            `${resizeBridgeScript}${enhancedHandlerScript}${scrollBridgeScript}</body>`,
          )
      );
    }, [theme.accent, theme.bgTerminal, theme.mode]);

    const postToWebView = useCallback((msg: object) => {
      const js = `if(window.handleRNMessage){window.handleRNMessage(${JSON.stringify(JSON.stringify(msg))})}true;`;
      webViewRef.current?.injectJavaScript(js);
    }, []);

    const restoreSnapshot = useCallback(() => {
      const snapshot = stream.getSnapshot();
      if (!readyRef.current) return;
      postToWebView({ type: "restore", chunks: snapshot.chunks });
    }, [postToWebView, stream]);

    useEffect(() => {
      const unsubscribe = stream.subscribe((event) => {
        if (!readyRef.current) return;
        if (event.type === "reset") {
          postToWebView({ type: "restore", chunks: event.snapshot.chunks });
          return;
        }
        postToWebView({ type: "write", data: event.chunk });
      });

      return unsubscribe;
    }, [postToWebView, stream]);

    useImperativeHandle(
      ref,
      () => ({
        clear() {
          postToWebView({ type: "clear" });
        },
        resize(cols: number, rows: number) {
          postToWebView({ type: "resize", cols, rows });
        },
        refit(stickToBottom = false) {
          postToWebView({ type: "refit", stickToBottom });
        },
        scrollToBottom() {
          postToWebView({ type: "scroll_bottom" });
        },
        zoomIn() {
          postToWebView({ type: "zoom_in" });
        },
        zoomOut() {
          postToWebView({ type: "zoom_out" });
        },
        resetZoom() {
          postToWebView({ type: "zoom_reset" });
        },
        focusCursor() {
          webViewRef.current?.injectJavaScript(
            `try{if(window.handleRNMessage){window.handleRNMessage(${JSON.stringify(JSON.stringify({ type: "focus_cursor" }))});}}catch(e){}true;`,
          );
        },
        blurCursor() {
          webViewRef.current?.injectJavaScript(
            "try{window.term.blur();document.activeElement&&document.activeElement.blur();}catch(e){}true;",
          );
        },
        copy() {
          postToWebView({ type: "copy" });
        },
        async paste() {
          const text = await Clipboard.getString();
          if (text) postToWebView({ type: "paste", data: text });
        },
        selectAll() {
          postToWebView({ type: "select_all" });
        },
      }),
      [postToWebView],
    );

    const handleMessage = useCallback(
      (event: { nativeEvent: { data: string } }) => {
        try {
          const msg = JSON.parse(event.nativeEvent.data) as {
            type: string;
            data?: string;
            cols?: number;
            rows?: number;
            scrollTop?: number;
            scrollHeight?: number;
            clientHeight?: number;
          };
          if (msg.type === "input" && msg.data && onInput) {
            onInput(msg.data);
          } else if (
            msg.type === "resize" &&
            msg.cols &&
            msg.rows &&
            onResize
          ) {
            onResize(msg.cols, msg.rows);
          } else if (msg.type === "selection" && msg.data) {
            Clipboard.setString(msg.data);
          } else if (msg.type === "clipboard_copy" && msg.data) {
            Clipboard.setString(msg.data);
          } else if (
            msg.type === "scroll_update" &&
            msg.scrollTop != null &&
            msg.scrollHeight != null &&
            msg.clientHeight != null
          ) {
            const info = {
              scrollTop: msg.scrollTop,
              scrollHeight: msg.scrollHeight,
              clientHeight: msg.clientHeight,
            };
            scrollInfoRef.current = info;
            updateThumbPosition(info);
            if (!isDraggingRef.current) flashScrollbar();
          }
        } catch {}
      },
      [onInput, onResize, updateThumbPosition, flashScrollbar],
    );

    return (
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ html: terminalHtml }}
          style={[styles.webview, { backgroundColor: theme.bgTerminal }]}
          originWhitelist={["*"]}
          javaScriptEnabled
          domStorageEnabled
          onMessage={handleMessage}
          scrollEnabled
          bounces={false}
          overScrollMode="never"
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          allowsInlineMediaPlayback
          mixedContentMode="always"
          injectedJavaScript={`document.documentElement.style.colorScheme='${theme.mode}';true;`}
          onLoadEnd={() => {
            readyRef.current = true;
            requestAnimationFrame(() => {
              restoreSnapshot();
            });
          }}
        />
        {/* Native scrollbar overlay */}
        <View
          style={styles.scrollbarTrack}
          onLayout={(e) => {
            trackHeightRef.current = e.nativeEvent.layout.height;
          }}
          pointerEvents="box-none"
        >
          <Animated.View
            {...panResponder.panHandlers}
            pointerEvents="auto"
            style={{
              position: "absolute",
              right: 0,
              width: SCROLLBAR_HIT_WIDTH,
              opacity: scrollbarOpacity,
              height: Math.max(
                MIN_THUMB_HEIGHT,
                thumbHeightRef.current || MIN_THUMB_HEIGHT,
              ),
              transform: [{ translateY: thumbTopAnim }],
              alignItems: "flex-end",
              paddingRight: SCROLLBAR_MARGIN,
            }}
          >
            <View
              style={{
                width: SCROLLBAR_WIDTH,
                height: "100%",
                borderRadius: SCROLLBAR_WIDTH / 2,
                backgroundColor:
                  theme.mode === "dark"
                    ? "rgba(255,255,255,0.35)"
                    : "rgba(0,0,0,0.3)",
              }}
            />
          </Animated.View>
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  scrollbarTrack: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: SCROLLBAR_HIT_WIDTH,
  },
});