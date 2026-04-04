/**
 * Reads xterm.js, addon-fit, addon-web-links and xterm.css from node_modules
 * and generates a TypeScript file with the full HTML inlined.
 * Run: node scripts/build-terminal-html.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const xtermJs = readFileSync(require.resolve("@xterm/xterm/lib/xterm.js"), "utf8");
const xtermCss = readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8");
const fitJs = readFileSync(require.resolve("@xterm/addon-fit/lib/addon-fit.js"), "utf8");
const webLinksJs = readFileSync(require.resolve("@xterm/addon-web-links/lib/addon-web-links.js"), "utf8");

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<style>
${xtermCss}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#020617;display:flex;flex-direction:column}
#terminal{flex:1;overflow:hidden}
.xterm{padding:2px}
.xterm-viewport::-webkit-scrollbar{width:4px}
.xterm-viewport::-webkit-scrollbar-thumb{background:#334155;border-radius:2px}
.xterm-viewport{-webkit-overflow-scrolling:touch !important;overscroll-behavior:contain !important;}
</style>
</head>
<body>
<div id="terminal"></div>
<script>${xtermJs}</script>
<script>${fitJs}</script>
<script>${webLinksJs}</script>
<script>
var DEFAULT_FONT_SIZE = 13;
var MIN_FONT_SIZE = 8;
var MAX_FONT_SIZE = 22;

var term = new Terminal({
  theme:{background:'#020617',foreground:'#e2e8f0',cursor:'#3b82f6',selectionBackground:'#334155'},
  fontFamily:"'Menlo','Courier New',monospace",
  fontSize:DEFAULT_FONT_SIZE,
  cursorBlink:true,
  cursorStyle:'block',
  cursorInactiveStyle:'block',
  allowProposedApi:true,
  scrollback:5000,
  convertEol:false,
});

var fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById('terminal'));

if (term.textarea) {
  term.textarea.readOnly = true;
  term.textarea.tabIndex = -1;
  term.textarea.setAttribute('inputmode', 'none');
  term.textarea.blur();
}

setTimeout(function(){fitAddon.fit();sendSize();},150);

function focusCursor(){
  try {
    term.focus();
  } catch (e) {}
}

function blurCursor(){
  try {
    term.blur();
  } catch (e) {}
}

// Instant snap to bottom — no animation, no visible scroll
function snapBottom(){
  try {
    var vp = document.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  } catch(e) {}
}

// Fit terminal without scroll jump — save/restore scroll position
function safeFit(){
  try {
    var vp = document.querySelector('.xterm-viewport');
    var wasAtBottom = vp ? (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 5) : true;
    var savedTop = vp ? vp.scrollTop : 0;
    fitAddon.fit();
    if (vp) {
      if (wasAtBottom) {
        vp.scrollTop = vp.scrollHeight;
      } else {
        vp.scrollTop = savedTop;
      }
    }
  } catch(e) {
    try { fitAddon.fit(); } catch(e2) {}
  }
}

function sendSize(){
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));
}

function setFontSize(nextSize){
  var fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, nextSize));
  term.options.fontSize = fontSize;
  safeFit();
  sendSize();
}

// IME composition guard + iOS voice dictation fix
var _composing = false;
var _lastComposed = '';
var _inputSeq = 0;
var _ackedSeq = -1;
// Voice dictation tracking: iOS dictation progressively replaces text in textarea,
// but xterm.js clears textarea after each input, breaking the replacement.
// We track what we've sent and emit backspaces + new text on replacement.
var _dictationText = '';  // cumulative text sent during current dictation session
var _dictationActive = false;
var _dictationTimer = null;

function endDictation() {
  _dictationText = '';
  _dictationActive = false;
  if (_dictationTimer) { clearTimeout(_dictationTimer); _dictationTimer = null; }
}

if (term.textarea) {
  term.textarea.addEventListener('compositionstart', function(){ _composing = true; });
  term.textarea.addEventListener('compositionend', function(e){
    _composing = false;
    if (e.data) {
      _lastComposed = e.data;
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'input',data:e.data}));
    }
  });

  // Intercept beforeinput to detect dictation replacements
  term.textarea.addEventListener('beforeinput', function(e){
    if (e.inputType === 'insertReplacementText' || e.inputType === 'insertFromDictation') {
      e.preventDefault();
      e.stopImmediatePropagation();
      var newText = '';
      if (e.dataTransfer) {
        newText = e.dataTransfer.getData('text/plain') || e.data || '';
      } else {
        newText = e.data || '';
      }
      if (!newText) return;

      _dictationActive = true;
      // Send backspaces to erase previously sent dictation text
      var bs = '';
      for (var i = 0; i < _dictationText.length; i++) bs += '\\b';
      if (bs) {
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'input',data:bs}));
      }
      // Send the full new text
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'input',data:newText}));
      _dictationText = newText;

      // Auto-end dictation session after 2s of inactivity
      if (_dictationTimer) clearTimeout(_dictationTimer);
      _dictationTimer = setTimeout(endDictation, 2000);
    }
  });

  // iOS Chinese punctuation workaround
  term.textarea.addEventListener('input', function(e){
    if (_composing || _dictationActive) return;
    if (e.inputType === 'insertText' && e.data && e.data.length === 1 && !e.isComposing) {
      var mySeq = ++_inputSeq;
      setTimeout(function(){
        if (_ackedSeq < mySeq) {
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'input',data:e.data}));
        }
      }, 30);
    }
  });
}
term.onData(function(data){
  if (_composing) return;
  if (_dictationActive) return;  // suppress xterm echo during dictation
  _ackedSeq = _inputSeq;
  if (_lastComposed && data === _lastComposed) {
    _lastComposed = '';
    return;
  }
  _lastComposed = '';
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'input',data:data}));
});
term.onResize(function(){sendSize();});
window.addEventListener('resize',function(){fitAddon.fit();});

// Copy selection to clipboard via RN bridge
term.onSelectionChange(function(){
  var sel = term.getSelection();
  if (sel && sel.length > 0) {
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'selection',data:sel}));
  }
});

window.handleRNMessage = function(msg){
  try{
    var p = JSON.parse(msg);
    if(p.type==='write'){term.write(p.data);}
    else if(p.type==='clear') term.clear();
    else if(p.type==='resize'){term.resize(p.cols,p.rows);safeFit();}
    else if(p.type==='zoom_in'){setFontSize((term.options.fontSize || DEFAULT_FONT_SIZE) + 1);}
    else if(p.type==='zoom_out'){setFontSize((term.options.fontSize || DEFAULT_FONT_SIZE) - 1);}
    else if(p.type==='zoom_reset'){setFontSize(DEFAULT_FONT_SIZE);}
    else if(p.type==='focus_cursor'){focusCursor();}
    else if(p.type==='blur_cursor'){blurCursor();}
    else if(p.type==='paste'){term.paste(p.data || '');}
    else if(p.type==='copy'){
      var sel = term.getSelection();
      if(sel) window.ReactNativeWebView.postMessage(JSON.stringify({type:'clipboard_copy',data:sel}));
    }
    else if(p.type==='select_all'){term.selectAll();}
  }catch(e){}
};
</script>
</body>
</html>`;

const outPath = resolve(__dirname, "../src/generated/terminal-html.ts");
const content = `// AUTO-GENERATED by scripts/build-terminal-html.mjs — do not edit\nexport const TERMINAL_HTML = ${JSON.stringify(html)};\n`;
writeFileSync(outPath, content, "utf8");
console.log(`Generated ${outPath} (${(content.length / 1024).toFixed(0)} KB)`);
