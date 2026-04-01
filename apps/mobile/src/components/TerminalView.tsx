import React, { useCallback, useImperativeHandle, useMemo, useRef, forwardRef } from "react";
import { Clipboard, Keyboard, StyleSheet, View } from "react-native";
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
      const isDark = theme.mode === "dark";
      const termTheme = {
        background: theme.bgTerminal,
        foreground: isDark ? "#e2e8f0" : "#0f172a",
        cursor: theme.accent,
        selectionBackground: isDark ? "#334155" : "#cbd5e1",
      };

      // Tap → focus xterm textarea (one single input owner)
      const tapBridgeScript = `
<script>
(function(){
  var startX=0,startY=0,moved=false,lastTap=0;
  function doTap(){
    try{
      if(window.term)window.term.focus();
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'terminal_tap'}));
    }catch(e){}
  }
  document.addEventListener('touchstart',function(e){
    var t=e.touches&&e.touches[0];if(!t)return;startX=t.clientX;startY=t.clientY;moved=false;
  },{passive:true});
  document.addEventListener('touchmove',function(e){
    var t=e.touches&&e.touches[0];if(!t)return;
    if(Math.abs(t.clientX-startX)>8||Math.abs(t.clientY-startY)>8)moved=true;
  },{passive:true});
  document.addEventListener('touchend',function(){if(!moved){lastTap=Date.now();doTap();}},{passive:true});
  document.addEventListener('click',function(){if(Date.now()-lastTap<350)return;doTap();},true);
})();
</script>`;

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

      // Accessory bar with shortcut keys (rendered in HTML, shown when keyboard is up)
      const kbarBg = "transparent";
      const kbarBorder = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.1)";
      const kbtnBg = isDark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.75)";
      const kbtnBorder = isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.85)";
      const kbtnColor = isDark ? "#e2e8f0" : "#1e293b";
      const kbtnActive = isDark ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.95)";
      const kdoneColor = theme.accent;

      const accessoryBarScript = `
<style>
#kbar{position:fixed;left:0;right:0;bottom:0;z-index:999;display:none;flex-direction:row;align-items:center;padding:6px 6px;gap:4px;background:${kbarBg};}
#kbar .ks{display:flex;gap:4px;flex-direction:row;align-items:center;flex:1;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
#kbar .ks::-webkit-scrollbar{display:none;}
#kbar .kb{font-size:12px;font-weight:600;color:${kbtnColor};background:${kbtnBg};border:0.5px solid ${kbtnBorder};border-radius:6px;padding:6px 8px;text-align:center;white-space:nowrap;-webkit-tap-highlight-color:transparent;touch-action:manipulation;box-shadow:0 1px 1px rgba(0,0,0,0.06);flex-shrink:0;}
#kbar .kb:active{background:${kbtnActive};}
#kbar .kd{font-size:14px;font-weight:600;color:${kdoneColor};background:transparent;border:none;padding:6px 8px;-webkit-tap-highlight-color:transparent;white-space:nowrap;flex-shrink:0;}
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
function dismissKb(){try{if(window.term&&window.term.textarea)window.term.textarea.blur();document.activeElement&&document.activeElement.blur();window.ReactNativeWebView.postMessage(JSON.stringify({type:'dismiss_keyboard'}));}catch(e){}}
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
        // Enable xterm textarea for keyboard input (WebView owns the keyboard)
        .replace(
          /if \(term\.textarea\) \{\n  term\.textarea\.readOnly = true;\n  term\.textarea\.tabIndex = -1;\n  term\.textarea\.setAttribute\('inputmode', 'none'\);\n  term\.textarea\.blur\(\);\n\}/,
          `if (term.textarea) {\n  term.textarea.readOnly = false;\n  term.textarea.tabIndex = 0;\n  term.textarea.style.colorScheme = '${theme.mode}';\n  term.textarea.setAttribute('autocapitalize', 'off');\n  term.textarea.setAttribute('autocorrect', 'off');\n  term.textarea.setAttribute('spellcheck', 'false');\n  term.textarea.setAttribute('inputmode', 'url');\n}`
        )
        .replace(/theme:\{background:'#020617',foreground:'#e2e8f0',cursor:'#3b82f6',selectionBackground:'#334155'\}/, `theme:${JSON.stringify(termTheme)}`)
        .replace("</body>", `${accessoryBarScript}${tapBridgeScript}${resizeBridgeScript}</body>`);
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
        webViewRef.current?.injectJavaScript("try{window.term.focus();}catch(e){}true;");
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
        } else if (msg.type === "terminal_tap") {
          onTap?.();
        } else if (msg.type === "selection" && msg.data) {
          // Auto-copy selection to clipboard
          Clipboard.setString(msg.data);
        } else if (msg.type === "clipboard_copy" && msg.data) {
          Clipboard.setString(msg.data);
        } else if (msg.type === "dismiss_keyboard") {
          Keyboard.dismiss();
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
