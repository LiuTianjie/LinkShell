import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, forwardRef } from "react";
import { Clipboard, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { TERMINAL_HTML } from "../generated/terminal-html";
import type { TerminalStream } from "../hooks/useSession";
import { useTheme } from "../theme";

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

    const terminalHtml = useMemo(() => {
      const isDark = theme.mode === "dark";
      const termTheme = {
        background: theme.bgTerminal,
        foreground: isDark ? "#e2e8f0" : "#0f172a",
        cursor: theme.accent,
        selectionBackground: isDark ? "#334155" : "#cbd5e1",
      };
      // Keep the terminal responsive to orientation changes without continuously refitting on DOM mutations.
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

      return TERMINAL_HTML
        .replace('<html>', `<html style="color-scheme:${theme.mode}">`)
        .replace('<meta charset="utf-8"/>', `<meta charset="utf-8"/><meta name="color-scheme" content="${theme.mode}"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">`)
        .replace(/background:#020617;display:flex;flex-direction:column/g, `background:${theme.bgTerminal};display:flex;flex-direction:column`)
        .replace(/background-color: #000;/g, `background-color: ${theme.bgTerminal};`)
        .replace(
          /\.xterm-viewport\{-webkit-overflow-scrolling:touch !important;overscroll-behavior:contain !important;\}/,
          ".xterm-viewport{-webkit-overflow-scrolling:touch !important;touch-action:pan-y !important;overscroll-behavior:contain !important;}"
        )
        .replace(
          /\.xterm \.xterm-viewport \{\n    \/\* On OS X this is required in order for the scroll bar to appear fully opaque \*\/\n    background-color: #000;\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n\}/,
          `.xterm .xterm-viewport {\n    background-color: ${theme.bgTerminal};\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n    -webkit-overflow-scrolling: touch;\n  }`
        )
        // Let xterm own keyboard input so IME composition and candidate selection work natively.
        .replace(
          /if \(term\.textarea\) \{\n  term\.textarea\.readOnly = true;\n  term\.textarea\.tabIndex = -1;\n  term\.textarea\.setAttribute\('inputmode', 'none'\);\n  term\.textarea\.blur\(\);\n\}/,
          `if (term.textarea) {\n  term.textarea.readOnly = false;\n  term.textarea.tabIndex = 0;\n  term.textarea.style.colorScheme = '${theme.mode}';\n  term.textarea.setAttribute('autocapitalize', 'off');\n  term.textarea.setAttribute('autocorrect', 'off');\n  term.textarea.setAttribute('spellcheck', 'false');\n  term.textarea.setAttribute('autocomplete', 'off');\n}`
        )
        .replace("window.addEventListener('resize',function(){fitAddon.fit();});", "window.addEventListener('resize',function(){safeFit();sendSize();});")
        .replace(/theme:\{background:'#020617',foreground:'#e2e8f0',cursor:'#3b82f6',selectionBackground:'#334155'\}/, `theme:${JSON.stringify(termTheme)}`)
        .replace("</body>", `${resizeBridgeScript}<script>\n(function(){\n  // Disable xterm.js scroll, let WebView native scroll handle it\n  if(window.term) term.options.mouseWheelScrolling = false;\n  // Make xterm viewport not clip — let body scroll naturally\n  var vp = document.querySelector('.xterm-viewport');\n  if(vp){ vp.style.overflow='visible'; vp.style.position='relative'; }\n  var screen = document.querySelector('.xterm-screen');\n  if(screen){ screen.style.position='relative'; }\n  // Body scroll styles\n  document.body.style.cssText += '-webkit-overflow-scrolling:touch;overscroll-behavior:contain;overflow-y:auto;height:auto;';\n  document.documentElement.style.cssText += 'overflow-y:auto;height:auto;';\n  function viewport(){\n    return document.querySelector('.xterm-viewport');\n  }\n  function isNearBottom(){\n    return (document.documentElement.scrollTop + window.innerHeight) >= (document.documentElement.scrollHeight - 32);\n  }\n  function snapBottom(){\n    window.scrollTo(0, document.documentElement.scrollHeight);\n  }\n  function restoreChunks(chunks){\n    term.reset();\n    if(Array.isArray(chunks) && chunks.length > 0){\n      term.write(chunks.join(''));\n    }\n    safeFit();\n    setTimeout(function(){ snapBottom(); }, 50);\n    sendSize();\n  }\n  var prevHandle = window.handleRNMessage;\n  window.handleRNMessage = function(msg){\n    try{\n      var p = JSON.parse(msg);\n      if(p.type==='restore'){\n        restoreChunks(p.chunks);\n        return;\n      }\n      if(p.type==='refit'){\n        safeFit();\n        sendSize();\n        return;\n      }\n      if(p.type==='scroll_bottom'){\n        snapBottom();\n        return;\n      }\n      if(p.type==='write'){\n        var wasNear = isNearBottom();\n        term.write(p.data || '');\n        if(wasNear) setTimeout(function(){ snapBottom(); }, 10);\n        return;\n      }\n      if(p.type==='focus_cursor'){\n        focusCursor();\n        return;\n      }\n    } catch(e) {}\n    if(prevHandle){\n      prevHandle(msg);\n    }\n  };\n})();\n</script></body>`);
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

    useImperativeHandle(ref, () => ({
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
          `try{if(window.handleRNMessage){window.handleRNMessage(${JSON.stringify(JSON.stringify({ type: "focus_cursor" }))});}}catch(e){}true;`
        );
      },
      blurCursor() {
        webViewRef.current?.injectJavaScript("try{window.term.blur();document.activeElement&&document.activeElement.blur();}catch(e){}true;");
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
    }), [postToWebView]);

    const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data) as { type: string; data?: string; cols?: number; rows?: number };
        if (msg.type === "input" && msg.data && onInput) {
          onInput(msg.data);
        } else if (msg.type === "resize" && msg.cols && msg.rows && onResize) {
          onResize(msg.cols, msg.rows);
        } else if (msg.type === "selection" && msg.data) {
          // Auto-copy selection to clipboard
          Clipboard.setString(msg.data);
        } else if (msg.type === "clipboard_copy" && msg.data) {
          Clipboard.setString(msg.data);
        }
      } catch {}
    }, [onInput, onResize]);

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
          decelerationRate="normal"
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
});
