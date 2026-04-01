import React, { useCallback, useImperativeHandle, useMemo, useRef, forwardRef } from "react";
import { Clipboard, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { TERMINAL_HTML } from "../generated/terminal-html";
import { useTheme } from "../theme";

export interface TerminalViewHandle {
  write: (data: string) => void;
  clear: () => void;
  resize: (cols: number, rows: number) => void;
  refit: () => void;
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
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTap?: () => void;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ onInput, onResize, onTap }, ref) {
    const { theme } = useTheme();
    const webViewRef = useRef<WebView>(null);

    const terminalHtml = useMemo(() => {
      const termTheme = {
        background: theme.bgTerminal,
        foreground: theme.mode === "dark" ? "#e2e8f0" : "#0f172a",
        cursor: theme.accent,
        selectionBackground: theme.mode === "dark" ? "#334155" : "#cbd5e1",
      };

      const tapBridgeScript = `
<script>
(function(){
  var startX = 0;
  var startY = 0;
  var moved = false;
  var lastTouchTapAt = 0;

  function sendTap(){
    try {
      if (window.term && typeof window.term.focus === 'function') {
        window.term.focus();
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'terminal_tap'}));
    } catch (e) {}
  }

  document.addEventListener('touchstart', function(event){
    var touch = event.touches && event.touches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
    moved = false;
  }, { passive: true });

  document.addEventListener('touchmove', function(event){
    var touch = event.touches && event.touches[0];
    if (!touch) return;
    if (Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8) {
      moved = true;
    }
  }, { passive: true });

  document.addEventListener('touchend', function(){
    if (!moved) {
      lastTouchTapAt = Date.now();
      sendTap();
    }
  }, { passive: true });

  document.addEventListener('click', function(){
    if (Date.now() - lastTouchTapAt < 350) return;
    sendTap();
  }, true);
})();
</script>
`;

      const resizeBridgeScript = `
<script>
(function(){
  var scheduled = false;

  function runFit(){
    scheduled = false;
    try {
      if (window.fitAddon && window.term) {
        window.fitAddon.fit();
        if (typeof window.sendSize === 'function') {
          window.sendSize();
        }
      }
    } catch (e) {}
  }

  function scheduleFit(){
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(runFit);
  }

  if (typeof ResizeObserver !== 'undefined') {
    var observer = new ResizeObserver(function(){
      scheduleFit();
    });
    observer.observe(document.body);
    var terminalRoot = document.getElementById('terminal');
    if (terminalRoot) {
      observer.observe(terminalRoot);
    }
  }

  window.addEventListener('orientationchange', scheduleFit);
  setTimeout(scheduleFit, 0);
  setTimeout(scheduleFit, 80);
  setTimeout(scheduleFit, 220);
})();
</script>
`;

      return TERMINAL_HTML
        .replace(/background:#020617;display:flex;flex-direction:column/g, `background:${theme.bgTerminal};display:flex;flex-direction:column`)
        .replace(/background-color: #000;/g, `background-color: ${theme.bgTerminal};`)
        .replace(
          /\.xterm \.xterm-viewport \{\n    \/\* On OS X this is required in order for the scroll bar to appear fully opaque \*\/\n    background-color: #000;\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n\}/,
          `.xterm .xterm-viewport {\n    /* On OS X this is required in order for the scroll bar to appear fully opaque */\n    background-color: ${theme.bgTerminal};\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n    -webkit-overflow-scrolling: touch;\n    overscroll-behavior: contain;\n    touch-action: pan-y;\n  }`
        )
        .replace(
          /if \(term\.textarea\) \{\n  term\.textarea\.readOnly = true;\n  term\.textarea\.tabIndex = -1;\n  term\.textarea\.setAttribute\('inputmode', 'none'\);\n  term\.textarea\.blur\(\);\n\}/,
          "if (term.textarea) {\n  term.textarea.readOnly = false;\n  term.textarea.tabIndex = 0;\n  term.textarea.removeAttribute('inputmode');\n  term.textarea.setAttribute('autocapitalize', 'off');\n  term.textarea.setAttribute('autocorrect', 'off');\n  term.textarea.setAttribute('spellcheck', 'false');\n}"
        )
        .replace(/theme:\{background:'#020617',foreground:'#e2e8f0',cursor:'#3b82f6',selectionBackground:'#334155'\}/, `theme:${JSON.stringify(termTheme)}`)
        .replace("</body>", `${tapBridgeScript}${resizeBridgeScript}</body>`);
    }, [theme.accent, theme.bgTerminal, theme.mode]);

    const postToWebView = useCallback((msg: object) => {
      const js = `window.handleRNMessage(${JSON.stringify(JSON.stringify(msg))});true;`;
      webViewRef.current?.injectJavaScript(js);
    }, []);

    useImperativeHandle(ref, () => ({
      write(data: string) {
        postToWebView({ type: "write", data });
      },
      clear() {
        postToWebView({ type: "clear" });
      },
      resize(cols: number, rows: number) {
        postToWebView({ type: "resize", cols, rows });
      },
      refit() {
        webViewRef.current?.injectJavaScript("try{fitAddon.fit();sendSize();}catch(e){}true;");
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
        postToWebView({ type: "focus_cursor" });
      },
      blurCursor() {
        postToWebView({ type: "blur_cursor" });
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
        } else if (msg.type === "terminal_tap") {
          onTap?.();
        } else if (msg.type === "selection" && msg.data) {
          // Auto-copy selection to clipboard
          Clipboard.setString(msg.data);
        } else if (msg.type === "clipboard_copy" && msg.data) {
          Clipboard.setString(msg.data);
        }
      } catch {}
    }, [onInput, onResize, onTap]);

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
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          allowsInlineMediaPlayback
          mixedContentMode="always"
          onLoadEnd={() => {
            requestAnimationFrame(() => {
              webViewRef.current?.injectJavaScript("try{fitAddon.fit();sendSize();}catch(e){}true;");
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
