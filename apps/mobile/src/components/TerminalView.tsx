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
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ onInput, onResize }, ref) {
    const { theme } = useTheme();
    const webViewRef = useRef<WebView>(null);

    const terminalHtml = useMemo(() => {
      const isDark = theme.mode === "dark";
      const termTheme = {
        background: theme.bgTerminal,
        foreground: isDark ? "#e2e8f0" : "#0f172a",
        cursor: theme.accent,
        selectionBackground: isDark ? "#334155" : "#cbd5e1",
      };
      const kbtnBg = isDark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.78)";
      const kbtnBorder = isDark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.08)";
      const kbtnColor = isDark ? "#e2e8f0" : "#1e293b";
      const kbtnActive = isDark ? "rgba(255,255,255,0.16)" : "rgba(226,232,240,0.95)";
      const kdoneColor = theme.accent;

      // Resize observer + orientation + delayed fits
      const resizeBridgeScript = `
<script>
(function(){
  var sched=false;
  function run(){sched=false;try{if(window.fitAddon&&window.term){window.fitAddon.fit();if(typeof sendSize==='function')sendSize();}}catch(e){}}
  function schedule(){if(sched)return;sched=true;requestAnimationFrame(run);}
  if(typeof ResizeObserver!=='undefined'){
    var o=new ResizeObserver(schedule);o.observe(document.body);
    var r=document.getElementById('terminal');if(r)o.observe(r);
  }
  window.addEventListener('orientationchange',schedule);
  setTimeout(schedule,0);setTimeout(schedule,80);setTimeout(schedule,220);
})();
</script>`;

      const accessoryBarScript = `
<style>
#kbar{position:fixed;left:0;right:0;bottom:0;z-index:999;display:none;flex-direction:row;align-items:center;padding:6px 6px;gap:4px;background:transparent;}
#kbar .ks{display:flex;gap:4px;flex-direction:row;align-items:center;flex:1;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
#kbar .ks::-webkit-scrollbar{display:none;}
#kbar .kb{font-size:12px;font-weight:600;color:${kbtnColor};background:${kbtnBg};border:0.5px solid ${kbtnBorder};border-radius:8px;padding:6px 8px;text-align:center;white-space:nowrap;-webkit-tap-highlight-color:transparent;touch-action:manipulation;flex-shrink:0;}
#kbar .kb:active{background:${kbtnActive};}
#kbar .kd{font-size:14px;font-weight:600;color:${kdoneColor};background:transparent;border:none;padding:6px 8px;white-space:nowrap;flex-shrink:0;}
</style>
<div id="kbar">
  <div class="ks">
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x1b')">Esc</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\t')">Tab</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x03')">Ctrl+C</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x04')">Ctrl+D</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x0c')">Ctrl+L</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x1b[A')">↑</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x1b[B')">↓</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x1b[C')">→</button>
    <button class="kb" onmousedown="event.preventDefault()" onclick="sendKey('\\x1b[D')">←</button>
  </div>
  <button class="kd" ontouchend="dismissKb()" onclick="dismissKb()">完成</button>
</div>
<script>
function sendKey(d){try{window.ReactNativeWebView.postMessage(JSON.stringify({type:'input',data:d}));if(window.term)window.term.focus();}catch(e){}}
function dismissKb(){try{if(window.term&&window.term.textarea)window.term.textarea.blur();document.activeElement&&document.activeElement.blur();}catch(e){}}
(function(){
  var bar=document.getElementById('kbar');
  var hideTimer=null;
  function showBar(){if(hideTimer){clearTimeout(hideTimer);hideTimer=null;}bar.style.display='flex';}
  function hideBar(){if(hideTimer)return;hideTimer=setTimeout(function(){bar.style.display='none';hideTimer=null;},150);}
  function watchTextarea(){
    if(!window.term||!window.term.textarea){setTimeout(watchTextarea,200);return;}
    var ta=window.term.textarea;
    ta.addEventListener('focus',showBar);
    ta.addEventListener('blur',hideBar);
  }
  watchTextarea();
})();
</script>`;

      return TERMINAL_HTML
        .replace('<html>', `<html style="color-scheme:${theme.mode}">`)
        .replace('<meta charset="utf-8"/>', `<meta charset="utf-8"/><meta name="color-scheme" content="${theme.mode}">`)
        .replace(/background:#020617;display:flex;flex-direction:column/g, `background:${theme.bgTerminal};display:flex;flex-direction:column`)
        .replace(/background-color: #000;/g, `background-color: ${theme.bgTerminal};`)
        .replace(
          /\.xterm \.xterm-viewport \{\n    \/\* On OS X this is required in order for the scroll bar to appear fully opaque \*\/\n    background-color: #000;\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n\}/,
          `.xterm .xterm-viewport {\n    /* On OS X this is required in order for the scroll bar to appear fully opaque */\n    background-color: ${theme.bgTerminal};\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n    -webkit-overflow-scrolling: touch;\n    overscroll-behavior: contain;\n    touch-action: pan-y;\n  }`
        )
        // Let xterm own keyboard input so IME composition and candidate selection work natively.
        .replace(
          /if \(term\.textarea\) \{\n  term\.textarea\.readOnly = true;\n  term\.textarea\.tabIndex = -1;\n  term\.textarea\.setAttribute\('inputmode', 'none'\);\n  term\.textarea\.blur\(\);\n\}/,
          `if (term.textarea) {\n  term.textarea.readOnly = false;\n  term.textarea.tabIndex = 0;\n  term.textarea.style.colorScheme = '${theme.mode}';\n  term.textarea.setAttribute('autocapitalize', 'off');\n  term.textarea.setAttribute('autocorrect', 'off');\n  term.textarea.setAttribute('spellcheck', 'false');\n}`
        )
        .replace(/theme:\{background:'#020617',foreground:'#e2e8f0',cursor:'#3b82f6',selectionBackground:'#334155'\}/, `theme:${JSON.stringify(termTheme)}`)
        .replace("</body>", `${accessoryBarScript}${resizeBridgeScript}</body>`);
    }, [theme.accent, theme.bgTerminal, theme.mode]);

    const postToWebView = useCallback((msg: object) => {
      const js = `if(window.handleRNMessage){window.handleRNMessage(${JSON.stringify(JSON.stringify(msg))})}true;`;
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
      scrollToBottom() {
        webViewRef.current?.injectJavaScript("try{window.term.scrollToBottom();}catch(e){}true;");
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
        webViewRef.current?.injectJavaScript("try{window.term&&window.term.focus();}catch(e){}true;");
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
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          allowsInlineMediaPlayback
          mixedContentMode="always"
          injectedJavaScript={`document.documentElement.style.colorScheme='${theme.mode}';true;`}
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
