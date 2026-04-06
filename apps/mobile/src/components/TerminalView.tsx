import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import {
  Clipboard,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
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
    const scrollViewRef = useRef<ScrollView>(null);
    const readyRef = useRef(false);
    const [containerHeight, setContainerHeight] = useState(100);
    const [contentHeight, setContentHeight] = useState(100);
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
      const show = Keyboard.addListener("keyboardWillShow", (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      });
      const hide = Keyboard.addListener("keyboardWillHide", () => {
        setKeyboardHeight(0);
        setContentHeight((prev) => Math.min(prev, containerHeight));
        webViewRef.current?.injectJavaScript(
          "try{window.term.blur();document.activeElement&&document.activeElement.blur();}catch(e){}true;",
        );
        setTimeout(() => {
          scrollViewRef.current?.scrollToEnd({ animated: false });
        }, 150);
      });
      return () => {
        show.remove();
        hide.remove();
      };
    }, [containerHeight]);

    const availableHeight = containerHeight - keyboardHeight;

    useEffect(() => {
      if (keyboardHeight > 0) {
        setContentHeight((prev) => Math.min(prev, availableHeight));
      }
    }, [availableHeight, keyboardHeight]);

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
          if (stickToBottom) {
            requestAnimationFrame(() => {
              scrollViewRef.current?.scrollToEnd({ animated: false });
            });
          }
        },
        scrollToBottom() {
          requestAnimationFrame(() => {
            scrollViewRef.current?.scrollToEnd({ animated: false });
          });
          postToWebView({ type: "snap_bottom" });
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
            msg.type === "size_update" &&
            typeof msg.scrollHeight === "number" &&
            typeof msg.clientHeight === "number"
          ) {
            const nextContent = Math.max(
              containerHeight,
              msg.scrollHeight || containerHeight,
            );
            setContentHeight((prev) =>
              Math.abs(prev - nextContent) > 2 ? nextContent : prev,
            );
          }
        } catch {}
      },
      [onInput, onResize, containerHeight],
    );

    const terminalHtml = useMemo(() => {
      const isDark = theme.mode === "dark";
      const termTheme = {
        background: theme.bgTerminal,
        foreground: isDark ? "#e2e8f0" : "#0f172a",
        cursor: theme.accent,
        selectionBackground: isDark ? "#334155" : "#cbd5e1",
      };

      const sizeBridgeScript = `
<script>
(function(){
  var raf=false;
  function send(){
    var vp=document.querySelector('.xterm-viewport');
    if(!vp) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type:'size_update',
      scrollHeight:vp.scrollHeight,
      clientHeight:vp.clientHeight
    }));
  }
  function schedule(){
    if(raf) return;
    raf=true;
    requestAnimationFrame(function(){ raf=false; send(); });
  }
  var mo=new MutationObserver(schedule);
  mo.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});
  setTimeout(send,0);setTimeout(send,120);setTimeout(send,400);
})();
</script>`;

      const enhancedHandlerScript = `
<script>
(function(){
  function restoreChunks(chunks){
    term.reset();
    if(Array.isArray(chunks)&&chunks.length>0){
      term.write(chunks.join(''));
    }
    safeFit();
    setTimeout(function(){ snapBottom(); },50);
    sendSize();
  }
  var prevHandle=window.handleRNMessage;
  window.handleRNMessage=function(msg){
    try{
      var p=JSON.parse(msg);
      if(p.type==='restore'){ restoreChunks(p.chunks); return; }
      if(p.type==='refit'){ safeFit(); sendSize(); return; }
      if(p.type==='snap_bottom'){ snapBottom(); return; }
      if(p.type==='write'){
        var vp=document.querySelector('.xterm-viewport');
        var wasNear=vp?(vp.scrollTop+vp.clientHeight>=vp.scrollHeight-16):true;
        term.write(p.data||'');
        if(wasNear) setTimeout(function(){ snapBottom(); },10);
        return;
      }
      if(p.type==='focus_cursor'){ focusCursor(); return; }
      if(p.type==='zoom_in'){ setFontSize(term.options.fontSize+1); return; }
      if(p.type==='zoom_out'){ setFontSize(term.options.fontSize-1); return; }
      if(p.type==='zoom_reset'){ setFontSize(${13}); return; }
      if(p.type==='clear'){ term.clear(); safeFit(); sendSize(); return; }
      if(p.type==='copy'){ term.select(); return; }
      if(p.type==='select_all'){ term.selectAll(); return; }
      if(p.type==='resize'&&p.cols&&p.rows){ term.resize(p.cols,p.rows); safeFit(); sendSize(); return; }
    } catch(e){}
    if(prevHandle) prevHandle(msg);
  };
})();
</script>`;

      return TERMINAL_HTML.replace(
        "<html>",
        `<html style="color-scheme:${theme.mode}">`,
      )
        .replace(
          '<meta charset="utf-8"/>',
          `<meta charset="utf-8"/><meta name="color-scheme" content="${theme.mode}"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">`,
        )
        .replace(
          /background:#020617;display:flex;flex-direction:column/g,
          `background:${theme.bgTerminal};display:flex;flex-direction:column`,
        )
        .replace(
          /background-color: #000;/g,
          `background-color: ${theme.bgTerminal};`,
        )
        .replace(
          ".xterm-viewport::-webkit-scrollbar{width:4px}",
          ".xterm-viewport::-webkit-scrollbar{display:none;width:0}",
        )
        .replace(
          ".xterm-viewport::-webkit-scrollbar-thumb{background:#334155;border-radius:2px}",
          ".xterm-viewport::-webkit-scrollbar-thumb{display:none}",
        )
        .replace(
          /\.xterm-viewport\{-webkit-overflow-scrolling:touch !important;overscroll-behavior:contain !important;\}/,
          `.xterm-viewport{-webkit-overflow-scrolling:auto !important;touch-action:none !important;overscroll-behavior:contain !important;}`,
        )
        .replace(
          /\.xterm \.xterm-viewport \{\n    \/\* On OS X this is required in order for the scroll bar to appear fully opaque \*\/\n    background-color: #000;\n    overflow-y: scroll;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n\}/,
          `.xterm .xterm-viewport {\n    background-color: ${theme.bgTerminal};\n    overflow-y: hidden;\n    cursor: default;\n    position: absolute;\n    right: 0;\n    left: 0;\n    top: 0;\n    bottom: 0;\n    -webkit-overflow-scrolling: auto;\n    touch-action: none;\n  }`,
        )
        .replace(
          /if \(term\.textarea\) \{\n  term\.textarea\.readOnly = true;\n  term\.textarea\.tabIndex = -1;\n  term\.textarea\.setAttribute\('inputmode', 'none'\);\n  term\.textarea\.blur\(\);\n\}/,
          `if (term.textarea) {\n  term.textarea.readOnly = false;\n  term.textarea.tabIndex = 0;\n  term.textarea.style.colorScheme = '${theme.mode}';\n  term.textarea.setAttribute('autocapitalize', 'off');\n  term.textarea.setAttribute('autocorrect', 'off');\n  term.textarea.setAttribute('spellcheck', 'false');\n  term.textarea.setAttribute('autocomplete', 'off');\n}`,
        )
        .replace(
          "window.addEventListener('resize',function(){fitAddon.fit();});",
          "window.addEventListener('resize',function(){safeFit();sendSize();});",
        )
        .replace(
          /theme:\{background:'#020617',foreground:'#e2e8f0',cursor:'#3b82f6',selectionBackground:'#334155'\}/,
          `theme:${JSON.stringify(termTheme)}`,
        )
        .replace(
          "</body>",
          `${sizeBridgeScript}${enhancedHandlerScript}</body>`,
        );
    }, [theme.accent, theme.bgTerminal, theme.mode]);

    return (
      <View
        style={styles.container}
        onLayout={(event) => {
          const h = Math.max(100, event.nativeEvent.layout.height || 100);
          setContainerHeight((prev) => (Math.abs(prev - h) > 2 ? h : prev));
        }}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollView}
          bounces={false}
          overScrollMode="never"
          keyboardShouldPersistTaps="always"
          contentContainerStyle={{
            minHeight: Math.max(availableHeight, contentHeight),
          }}
        >
          <View
            style={[
              styles.webviewHost,
              { height: Math.max(availableHeight, contentHeight) },
            ]}
          >
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
                readyRef.current = true;
                requestAnimationFrame(() => {
                  restoreSnapshot();
                });
              }}
            />
            <Pressable
              style={styles.focusOverlay}
              onPress={() => {
                postToWebView({ type: "focus_cursor" });
              }}
            />
          </View>
        </ScrollView>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  webviewHost: {
    width: "100%",
    position: "relative",
  },
  webview: {
    flex: 1,
  },
  focusOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
});
