/** Main DOM setup, socket lifecycle, and i18n copy for the screen viewer. */
export const CLIENT_PREAMBLE_SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);
const stage = $("stage"), picture = $("picture"), canvas = $("screen"), ctx = canvas.getContext("2d"), video = $("video"), gpu = $("gpu"), pointer = $("pointer");
const note = $("note"), bar = $("bar"), controlShell = $("control-shell"), orb = $("orb"), menu = $("menu"), connection = $("connection"), toast = $("toast"), keys = $("keys"), typing = $("typing"), shortcut = $("shortcut");
const sheet = $("sheet"), actions = $("actions"), maker = $("maker"), naming = $("makername"), composer = $("composer"), words = $("words");
const query = new URLSearchParams(location.search);
const windowsHost = document.body.dataset.platform === "win32";
if (windowsHost) Object.assign(MOD_SIGNS, { ctrl: "Ctrl+", alt: "Alt+", shift: "Shift+", cmd: "Win+" });
const app = window.ReactNativeWebView;
const tellApp = (message) => { if (app) app.postMessage(JSON.stringify(message)); };
const tellSession = (session) => {
  const message = { type: "screenSession", session };
  tellApp(message);
  if (typeof window.__linkshellSession === "function") window.__linkshellSession(message);
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const coarse = matchMedia("(pointer: coarse)").matches;
const android = /Android/i.test(navigator.userAgent);

const MODES = ["view", "trackpad", "touch"];
const LOCALES = ["zh", "en", "ja"];
const LANGS = {
  zh: {
    title: "屏幕",
    viewTitle: "只看", viewDesc: "不操作电脑", viewAria: "只看，不操作电脑",
    trackpadTitle: "触控板", trackpadDesc: "滑动指针 · 轻点点击", trackpadAria: "触控板，滑动指针，轻点点击",
    touchTitle: "点按", touchDesc: "点按画面直接操作", touchAria: "点按，点按画面直接操作",
    hintView: "只看：双指缩放，单指移动画面",
    hintTrackpad: "触控板：滑动指针 · 轻点点击 · 双指轻点右键 · 双指滑动滚动 · 轻点两下并按住拖拽",
    hintTouch: "点按：点哪里就点哪里 · 长按右键 · 双指滑动滚动 · 轻点两下并按住拖拽",
    connTitle: "连接信息", closeInfo: "关闭连接信息",
    widthsTitle: "清晰度（直连视频）",
    w1280: "流畅", w1920: "标准", w2560: "高清", wNative: "原生", wNativeSub: "最高 4K",
    pacingTitle: "画面节奏",
    pImmediate: "延迟优先", pImmediateSub: "最跟手",
    pSmooth: "流畅优先", pSmoothSub: "适合观看",
    pacingSmoothHint: "流畅优先：画面更均匀，Wi-Fi 下延迟约多 50 毫秒",
    pacingImmediateHint: "延迟优先：最跟手，网络抖动时会短暂停顿",
    clipHead: "加密剪贴板",
    pasteComputer: "粘贴到电脑", pasteComputerSub: "发送剪贴板",
    copyComputer: "读取电脑剪贴板", copyComputerSub: "复制到本机",
    clipSynced: "剪贴板已同步", clipEmpty: "剪贴板为空", clipFailed: "剪贴板同步失败", clipBlocked: "浏览器没有允许读取剪贴板",
    privacyHead: "隐私保护",
    curtain: "防窥黑屏", curtainSub: "遮挡远端屏幕",
    curtainOn: "远端防窥黑屏已开启", curtainOff: "远端防窥黑屏已关闭",
    lockDisconnect: "断开时自动锁屏", lockDisconnectSub: "离开自动锁定",
    lockOn: "已开启断开时自动锁屏", lockOff: "已关闭断开时自动锁屏",
    langHead: "界面语言",
    barMode: "控制方式", barKeyboard: "键盘", barQuick: "快捷操作", barClip: "剪贴板与隐私", barAudioOn: "声音", barAudioMuted: "静音", barFit: "还原缩放", barInfo: "连接信息", barFull: "全屏", orbExpand: "展开屏幕控制",
    audioOnHint: "桌面声音已开启", audioMutedHint: "桌面声音已静音",
    composePrompt: "发送文字…", wordsHint: "在这里写好，再发到电脑上", pasteClip: "粘贴剪贴板", sendReturn: "发送并回车", sendWords: "发送",
    connecting: "正在连接…", directVideo: "直连 · 视频", relayCompat: "中继 · 兼容", directCompat: "直连 · 兼容", fpsUnit: " 帧/秒", rttPrefix: "往返 ", msUnit: " 毫秒",
    adjusting: "正在调整屏幕…", preparingControl: "正在准备控制电脑…", controlUnavailable: "这台电脑暂时不能被控制",
    disconnected: "屏幕连接已断开，请确认电脑在线后重新连接。", reconnectSuffix: "，重新连接即可继续。",
    slowerHint: "网络较慢：已降低画质，优先保证跟得上",
    sentWords: "已发送 ", sentWordsSuffix: " 个字", sentAndReturn: "，并回车", sentReturnOnly: "已回车",
  },
  en: {
    title: "Screen",
    viewTitle: "View Only", viewDesc: "Watch without input", viewAria: "View only, watch without input",
    trackpadTitle: "Trackpad", trackpadDesc: "Slide pointer · Tap to click", trackpadAria: "Trackpad, slide pointer and tap to click",
    touchTitle: "Direct Touch", touchDesc: "Tap directly on screen", touchAria: "Direct touch, tap directly on screen",
    hintView: "View only: pinch to zoom, drag with one finger to pan",
    hintTrackpad: "Trackpad: slide to move · tap to click · two-finger tap right-click · two-finger scroll",
    hintTouch: "Touch: tap anywhere to click · hold for right-click · two-finger scroll · double-tap drag",
    connTitle: "Connection & Privacy", closeInfo: "Close panel",
    widthsTitle: "Resolution (Direct Video)",
    w1280: "Smooth", w1920: "Standard", w2560: "HD", wNative: "Native", wNativeSub: "Up to 4K",
    pacingTitle: "Frame Pacing",
    pImmediate: "Low Latency", pImmediateSub: "Responsive",
    pSmooth: "Smooth", pSmoothSub: "Even cadence",
    pacingSmoothHint: "Smooth pacing: steadier frames (+50 ms buffer on Wi-Fi)",
    pacingImmediateHint: "Low latency: most responsive, brief pauses under jitter",
    clipHead: "Encrypted Clipboard",
    pasteComputer: "Paste to Computer", pasteComputerSub: "Send clipboard",
    copyComputer: "Copy from Computer", copyComputerSub: "Read host text",
    clipSynced: "Clipboard synced", clipEmpty: "Clipboard is empty", clipFailed: "Clipboard sync failed", clipBlocked: "Clipboard read permission was denied",
    privacyHead: "Privacy Controls",
    curtain: "Privacy Curtain", curtainSub: "Blank host screen",
    curtainOn: "Privacy curtain enabled on host", curtainOff: "Privacy curtain disabled",
    lockDisconnect: "Lock on Disconnect", lockDisconnectSub: "Auto-lock host",
    lockOn: "Auto-lock on disconnect enabled", lockOff: "Auto-lock on disconnect disabled",
    langHead: "Language",
    barMode: "Control mode", barKeyboard: "Keyboard", barQuick: "Shortcuts", barClip: "Clipboard & privacy", barAudioOn: "Audio", barAudioMuted: "Mute", barFit: "Reset zoom", barInfo: "Connection info", barFull: "Fullscreen", orbExpand: "Expand screen controls",
    audioOnHint: "Desktop audio on", audioMutedHint: "Desktop audio muted",
    composePrompt: "Type text…", wordsHint: "Compose here, then send to computer", pasteClip: "Paste Clipboard", sendReturn: "Send + Return", sendWords: "Send",
    connecting: "Connecting…", directVideo: "Direct · Video", relayCompat: "Relay · Stream", directCompat: "Direct · Stream", fpsUnit: " fps", rttPrefix: "RTT ", msUnit: " ms",
    adjusting: "Adjusting display…", preparingControl: "Preparing remote input…", controlUnavailable: "Remote input is unavailable on this computer",
    disconnected: "Screen disconnected. Check that the computer is online and reconnect.", reconnectSuffix: " — reconnect to continue.",
    slowerHint: "Slow network: lowered video quality to stay live",
    sentWords: "Sent ", sentWordsSuffix: " chars", sentAndReturn: " + Return", sentReturnOnly: "Sent Return",
  },
  ja: {
    title: "リモート画面",
    viewTitle: "表示のみ", viewDesc: "PCを操作しない", viewAria: "表示のみ、PCを操作しない",
    trackpadTitle: "トラックパッド", trackpadDesc: "スライドで移動 · タップでクリック", trackpadAria: "トラックパッド、スライドで移動、タップでクリック",
    touchTitle: "ダイレクトタッチ", touchDesc: "タップした位置を操作", touchAria: "ダイレクトタッチ、画面を直接タップして操作",
    hintView: "表示のみ：ピンチで拡大縮小、1本指で画面移動",
    hintTrackpad: "トラックパッド：スライドで移動 · タップでクリック · 2本指タップで右クリック · 2本指スクロール",
    hintTouch: "タッチ：タップ位置をクリック · 長押しで右クリック · 2本指スクロール · ダブルタップ移動でドラッグ",
    connTitle: "接続とプライバシー", closeInfo: "閉じる",
    widthsTitle: "画質（直接ビデオ）",
    w1280: "軽量", w1920: "標準", w2560: "高画質", wNative: "ネイティブ", wNativeSub: "最大 4K",
    pacingTitle: "フレーム制御",
    pImmediate: "低遅延優先", pImmediateSub: "操作向き",
    pSmooth: "なめらか優先", pSmoothSub: "視聴向き",
    pacingSmoothHint: "なめらか優先：表示が均一になります（Wi-Fi で約 +50 ms）",
    pacingImmediateHint: "低遅延優先：最も追従性が高く、揺らぎ時は一瞬待機します",
    clipHead: "暗号化クリップボード",
    pasteComputer: "PC へ貼り付け", pasteComputerSub: "テキスト送信",
    copyComputer: "PC のクリップボード取得", copyComputerSub: "手元へコピー",
    clipSynced: "クリップボードを同期しました", clipEmpty: "クリップボードは空です", clipFailed: "クリップボード同期に失敗しました", clipBlocked: "クリップボードの読み取りが許可されていません",
    privacyHead: "プライバシー保護",
    curtain: "プライバシーブラインド", curtainSub: "PC画面を暗転",
    curtainOn: "PC 側の画面ブラインドを有効化しました", curtainOff: "PC 側の画面ブラインドを解除しました",
    lockDisconnect: "切断時に自動ロック", lockDisconnectSub: "終了時にロック",
    lockOn: "切断時の自動ロックを有効化しました", lockOff: "切断時の自動ロックを解除しました",
    langHead: "表示言語",
    barMode: "操作モード", barKeyboard: "キーボード", barQuick: "ショートカット", barClip: "クリップボードと保護", barAudioOn: "音声", barAudioMuted: "ミュート", barFit: "ズーム解除", barInfo: "接続情報", barFull: "全画面", orbExpand: "コントロールを展開",
    audioOnHint: "デスクトップ音声オン", audioMutedHint: "デスクトップ音声ミュート",
    composePrompt: "テキスト送信…", wordsHint: "ここに入力して PC へまとめて送信", pasteClip: "貼り付け", sendReturn: "送信して改行", sendWords: "送信",
    connecting: "接続中…", directVideo: "直接接続 · ビデオ", relayCompat: "リレー · 互換", directCompat: "直接接続 · 互換", fpsUnit: " fps", rttPrefix: "往復 ", msUnit: " ms",
    adjusting: "画面を調整中…", preparingControl: "リモート操作を準備中…", controlUnavailable: "この PC は現在リモート操作できません",
    disconnected: "画面接続が切断されました。PC がオンラインか確認して再接続してください。", reconnectSuffix: "。再接続すると再開できます。",
    slowerHint: "回線が混雑しているため、遅延を防ぐよう画質を調整しました",
    sentWords: "", sentWordsSuffix: " 文字を送信", sentAndReturn: "（Enter 送信）", sentReturnOnly: "Enter を送信しました",
  },
};
let storedLang = null;
try { storedLang = localStorage.getItem("linkshell.screen.lang"); } catch {}
const initialBodyLang = document.body.dataset.lang;
let lang = LOCALES.includes(query.get("lang")) ? query.get("lang") : LOCALES.includes(window.__linkshellChrome?.locale) ? window.__linkshellChrome.locale : LOCALES.includes(storedLang) ? storedLang : LOCALES.includes(initialBodyLang) ? initialBodyLang : "zh";
const L = () => LANGS[lang] || LANGS.zh;
const HINTS = {
  get view() { return L().hintView; },
  get trackpad() { return L().hintTrackpad; },
  get touch() { return L().hintTouch; },
};
let stored = null;
try { stored = localStorage.getItem("linkshell.screen.mode"); } catch {}
let mode = MODES.includes(query.get("mode")) ? query.get("mode") : MODES.includes(window.__linkshellChrome?.mode) ? window.__linkshellChrome.mode : MODES.includes(stored) ? stored : "view";

// What the app around the page has done to the phone's screen. A page in a plain browser has none of it.
// "clear" is the side of a phone lying down that has no camera in it.
const chrome = Object.assign({ fullscreen: false, landscape: false, canRotate: false, clear: null, insets: { top: 0, right: 0, bottom: 0, left: 0 } }, window.__linkshellChrome || {});
// The same controls and gestures sit over the iOS Metal surface. Only small input and
// layout messages cross WebKit's native bridge; video frames never enter this page.
const nativePicture = chrome.nativePicture === true;
const appManagedLoading = !!app && chrome.nativeLoading === true;
document.documentElement.classList.toggle("native-picture", nativePicture);
document.documentElement.classList.toggle("app-managed-loading", appManagedLoading);
const nativePost = (message) => window.webkit?.messageHandlers?.linkshellScreen?.postMessage(message);
let nativeStats = null;
// Whether this viewer may move the computer's pointer: asked for with the first controlling mode.
const control = { asked: false, known: false, available: false, trusted: false, reason: "", app: "", prompted: false };
const content = { w: 0, h: 0 };
let zoom = 1, pan = { x: 0, y: 0 }, fit = 1;
let area = { x: 0, y: 0, w: 1, h: 1 }, shown = { x: 0, y: 0, w: 1, h: 1 };
const cursor = { x: 0.5, y: 0.5 };
let keysOpen = false, sheetOpen = false, composerOpen = false;
const mods = new Set();

// ---- The picture ----------------------------------------------------------

let sessionError = "", sessionPhase = "", hasPicture = false, pictureReported = false;
const loading = createScreenLoading(note, () => {
  if (app && chrome.canRetryScreen) tellApp({ type: "screenRetry" });
  else if (typeof window.__linkshellReload === "function") window.__linkshellReload({});
  else location.reload();
}, (phase) => {
  window.__linkshellScreenState?.(phase);
  if (appManagedLoading && (phase === "receiving" || phase === "ready" || phase === "blocked" || phase === "error")) {
    tellApp({ type: "screenLoading", phase });
  }
});
addEventListener("pagehide", () => loading.dispose(), { once: true });
const say = (text) => {
  if (!text) {
    hasPicture = true;
    document.documentElement.classList.remove("app-managed-loading");
    if (!pictureReported) {
      pictureReported = true;
      tellApp({ type: "pictureReady" });
    }
  }
  if (sessionError) loading.set("error", sessionError);
  else if (text) loading.set("error", text);
  else if (sessionPhase) loading.set(sessionPhase);
  else loading.set("ready");
};
// Transport updates must not hide a configuration failure or a paused retained session.
const showProgress = (phase) => { if (!sessionError && !sessionPhase) loading.set(phase); };
const round = (value, digits) => (value == null || !isFinite(value) ? null : +value.toFixed(digits === undefined ? 1 : digits));
const hex = (n) => n.toString(16).padStart(2, "0");
function sps(unit) {
  for (let i = 0; i + 3 < unit.length; i++)
    if (unit[i] === 0 && unit[i + 1] === 0 && unit[i + 2] === 1 && (unit[i + 3] & 0x1f) === 7) return unit.subarray(i + 3);
}
// "low": the page is reached through a gateway. The picture is asked for as a video track where this end can
// show one: an app around the page that doesn't say it plays video in place would open the system's
// full-screen player for it. The app says so in the address as well (?video=1): on Android what it tells the
// page as it loads can arrive after this script has run. ?video=0 keeps to the socket, to try that way out.
const relayed = query.get("q") === "low";
const wantVideo = !nativePicture && "RTCPeerConnection" in window && (!app || chrome.video === true || query.get("video") === "1") && query.get("video") !== "0";
// The iOS app owns the final transport fallback, so it can bypass a failed direct data channel.
const relayFallback = !nativePicture && !!app && (chrome.relayFallback === true || query.get("fallback") === "relay") && query.get("video") !== "0";
const unseeable = () => say("这个系统版本的浏览器内核不支持视频解码，请升级系统后再试。");
if (!windowsHost && !nativePicture && !wantVideo && !("VideoDecoder" in window)) unseeable();
let decoder, skipping = false, skipped = 0, arrived = 0, keyAsked = -Infinity;
const jpegStats = { frames: 0, bytes: 0, decode: 0, at: performance.now(), beforeFrames: 0, beforeBytes: 0, beforeDecode: 0, fps: 0, bitrateMbps: 0, decodeMs: 0 };
function jpegVitals() {
  const now = performance.now(), elapsed = now - jpegStats.at;
  if (elapsed >= 1000) {
    const frames = jpegStats.frames - jpegStats.beforeFrames;
    jpegStats.fps = round(frames * 1000 / elapsed);
    jpegStats.bitrateMbps = round((jpegStats.bytes - jpegStats.beforeBytes) * 8 / (elapsed * 1000), 2);
    jpegStats.decodeMs = frames ? round((jpegStats.decode - jpegStats.beforeDecode) / frames, 2) : 0;
    jpegStats.at = now; jpegStats.beforeFrames = jpegStats.frames; jpegStats.beforeBytes = jpegStats.bytes; jpegStats.beforeDecode = jpegStats.decode;
  }
  return { width: content.w, height: content.h, codec: "JPEG", fps: jpegStats.fps, bitrateMbps: jpegStats.bitrateMbps, decodeMs: jpegStats.decodeMs, live: false };
}
let jpegPending = null, jpegDecoding = false, jpegGeneration = 0;
async function drawJpeg() {
  if (jpegDecoding) return;
  jpegDecoding = true;
  try {
    while (jpegPending && ws.readyState === 1 && session.active()) {
      const next = jpegPending;
      jpegPending = null;
      const generation = jpegGeneration;
      const started = performance.now();
      const bitmap = await createImageBitmap(new Blob([next.unit], { type: "image/jpeg" }));
      try {
        if (generation !== jpegGeneration || ws.readyState !== 1 || !session.active()) continue;
        if (live) show(false);
        if (content.w !== bitmap.width || content.h !== bitmap.height) {
          canvas.width = content.w = bitmap.width;
          canvas.height = content.h = bitmap.height;
          layout();
        }
        ctx.drawImage(bitmap, 0, 0);
        jpegStats.frames++; jpegStats.decode += performance.now() - started;
        shownUpTo(next.seq);
        say("");
      } finally { bitmap.close(); }
    }
  } catch (error) { say("屏幕画面解码失败：" + error.message); }
  finally { jpegDecoding = false; }
}
// Only a keyframe gets a decoder that lost its place going again, and the host makes them when asked rather than by the clock.
const askKey = () => { const now = performance.now(); if (now - keyAsked > 500) { keyAsked = now; send({ t: "keyframe" }); } };
// The host is told which frame is on screen: that is how it knows when this end has fallen behind,
// and stops sending rather than let the picture drift into the past.
let lastShown = 0, telling = 0;
// For trying a slow path out without one: ?lag=2500&lagFor=12 answers 2.5 s late for the first 12 s.
const lag = Number(query.get("lag")) || 0, lagUntil = performance.now() + (Number(query.get("lagFor")) || 0) * 1000;
function shownUpTo(seq) {
  if (seq > lastShown) lastShown = seq;
  if (lag && performance.now() < lagUntil) { const late = lastShown; setTimeout(() => send({ t: "ack", n: late }), lag); return; }
  if (windowsHost) return send({ t: "ack", n: lastShown });
  if (!telling) telling = setTimeout(() => { telling = 0; send({ t: "ack", n: lastShown }); }, 40);
}
let lighterAt = -Infinity, failures = 0;
const asked = new URLSearchParams(location.search);
asked.delete("video");
if (wantVideo) asked.set("video", "1");
if (query.get("audio") === "1") asked.set("audio", "1");
// This page passes a TURN server's login on to WebRTC and shows an idle end as final. Inside an app, the app
// must know of the idle end too: an older one says so by not asking for it, and gets the screen as it always did.
if (!app || query.get("turn") === "1") asked.set("turn", "1");
// How wide the video track may be (the socket's picture has its own ladder). The app says it in the address;
// a plain browser remembers its own. A capable host applies a new choice to this same track.
const WIDTHS = ["1280", "1920", "2560", "native"];
let keptWidth = null;
try { keptWidth = localStorage.getItem("linkshell.screen.width"); } catch {}
let width = WIDTHS.includes(query.get("width")) ? query.get("width") : WIDTHS.includes(keptWidth) ? keptWidth : "1920";
const initialSession = typeof window.__linkshellSession === "object" && window.__linkshellSession ? window.__linkshellSession : {};
const session = createScreenSession({ active: true, display: Number(query.get("display")) || 0, width, maxFps: Number(query.get("maxFps")) || undefined, ...initialSession }, {
  send: (message) => send(message),
  defer: (action) => Promise.resolve().then(action),
  release: () => {
    // A decoded bitmap from before a pause or display change belongs to the old surface.
    jpegGeneration += 1;
    jpegPending = null;
    releaseInput();
  },
  report: tellSession,
  reload: (state) => reloadSession(state),
  changed: (state) => {
    width = state.width;
    const previousError = sessionError;
    const previousPhase = sessionPhase;
    sessionError = state.error;
    sessionPhase = state.paused ? "paused" : !state.inputReady ? "adjusting" : "";
    if (sessionError) say(sessionError);
    else if (sessionPhase) loading.set(sessionPhase);
    // Configuration acknowledgement enables input; only received media proves the first picture exists.
    else if (previousError || previousPhase) loading.set(hasPicture ? "ready" : "receiving");
    if (state.inputReady && mode !== "view") askControl();
    refreshWidths();
    refresh();
  },
});
width = session.desired().width;
asked.set("width", width);
asked.set("display", String(session.desired().display));
if (session.desired().maxFps) asked.set("maxFps", String(session.desired().maxFps));
// A page that is a srcdoc (the gateway's web client puts it in one) has no address of its own to load again:
// it asks the page around it to, where that page says it can, and offers no choice where it can't.
const framed = document.URL === "about:srcdoc";
const reloadVia = framed && typeof window.__linkshellReload === "function" ? window.__linkshellReload : null;
const canChooseWidth = !framed || !!reloadVia;
// How the receiver paces the picture: "immediate" shows each frame as it is decoded (the default, most
// responsive); "smooth" leaves the receiver its jitter buffer, about +50 ms on Wi-Fi (ScreenPacing.swift).
// A new choice needs a new negotiation: an app says it in the address and reconnects; a plain browser reloads.
let keptPacing = null;
try { keptPacing = localStorage.getItem("linkshell.screen.pacing"); } catch {}
const pacing = query.get("pacing") === "smooth" || (!app && query.get("pacing") === null && keptPacing === "smooth") ? "smooth" : "immediate";
// An app that reconnects for it says so; a srcdoc page has no address to load again.
const canChoosePacing = () => (app ? chrome.canPace === true : !framed);
const ws = nativePicture
  ? { readyState: 1, send: (data) => nativePost({ kind: "signal", message: JSON.parse(data) }) }
  : new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/stream?" + asked);
ws.binaryType = "arraybuffer";
const send = (message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
let capabilityTimer = 0, socketClosed = false, taken = false, idle = false;
function waitForCapabilities() {
  clearTimeout(capabilityTimer);
  capabilityTimer = setTimeout(() => {
    if (!session.known()) session.receive({ t: "capabilities", version: 1, configure: false, pause: false, retainMs: 0 });
  }, 10000);
}
ws.onopen = () => { if (loading.phase === "connecting") showProgress("receiving"); session.open(); waitForCapabilities(); if (mode !== "view") askControl(); };
// Out of sight, a page answers late (its timers slow to one a second) and shows nothing: the host sends no
// picture down the socket meanwhile, and starts again at a keyframe.
document.addEventListener("visibilitychange", () => session.visibility(document.hidden));
// The host ends a relayed picture no one has used for minutes. Touching or zooming the picture, scrolling, typing:
// any of these says someone is there, at most every 15 s.
let usedAt = -Infinity;
function used() {
  const now = performance.now();
  if (now - usedAt < 15000) return;
  usedAt = now;
  send({ t: "activity" });
}
for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) document.addEventListener(type, used, { capture: true, passive: true });
window.linkshellSession = (state) => session.update(state);

function reloadSession(state) {
  if (nativePicture) return;
  if (reloadVia) return reloadVia({ ...state, mode });
  const next = new URLSearchParams(location.search);
  for (const name of ["display", "width", "maxFps"]) if (state[name] !== undefined) next.set(name, String(state[name]));
  next.set("mode", mode);
  location.replace(location.pathname + "?" + next);
}

function refreshWidths() {
  for (const tile of $("widths").querySelectorAll(".tile")) {
    tile.classList.toggle("on", tile.dataset.width === width);
    tile.setAttribute("aria-pressed", String(tile.dataset.width === width));
  }
}
ws.onmessage = (event) => {
  if (typeof event.data === "string") return heard(JSON.parse(event.data));
  if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 6) return;
  // A frame: whether it is a keyframe, its number, the picture.
  const head = new DataView(event.data);
  const key = head.getUint8(0) === 1;
  const seq = head.getUint32(1);
  const unit = new Uint8Array(event.data, 5);
  arrived = seq;
  if (head.getUint8(0) === 2) {
    if (!session.active()) return shownUpTo(seq);
    jpegStats.bytes += event.data.byteLength;
    // A latest-frame mailbox keeps decoding work bounded when the viewer is slow.
    jpegPending = { seq, unit };
    void drawJpeg();
    return;
  }
  if (!("VideoDecoder" in window)) return unseeable();
  // A decoder that can't keep up skips to the next keyframe; what it skips has still arrived.
  if (decoder && !key && (skipping || decoder.decodeQueueSize > 8)) { skipping = true; skipped += 1; askKey(); return shownUpTo(seq); }
  skipping = false;
  if (!decoder) {
    const params = key && sps(unit);
    if (!params) { askKey(); return shownUpTo(seq); }
    decoder = new VideoDecoder({
      output: (frame) => {
        // The first frame down the socket takes the picture over from a video track that didn't last.
        const taken = live;
        if (taken) show(false);
        if (content.w !== frame.displayWidth || content.h !== frame.displayHeight) {
          canvas.width = content.w = frame.displayWidth;
          canvas.height = content.h = frame.displayHeight;
          layout();
        }
        if (taken && !menu.classList.contains("gone")) status();
        ctx.drawImage(frame, 0, 0);
        shownUpTo(frame.timestamp);
        if (meter) meter.drawn(frame);
        frame.close();
        say("");
      },
      // A new decoder at the next keyframe, which is asked for: one bad frame is not the end of the picture.
      error: (error) => { if (failures++ > 4) return say("解码失败：" + error.message); decoder = undefined; askKey(); },
    });
    decoder.configure({ codec: "avc1." + hex(params[1]) + hex(params[2]) + hex(params[3]), optimizeForLatency: true });
  }
  decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: seq, data: unit }));
};
ws.onclose = () => {
  if (socketClosed) return;
  socketClosed = true;
  clearTimeout(capabilityTimer);
  session.close();
  // A video track is this socket's: without the one there is no finding the other again, and no hands.
  drop();
  // Ended for being unused: another path would only start the picture again by itself.
  if (!taken && !idle && requestRelay()) return;
  tellApp({ type: "screenClosed", ...(taken ? { reason: "taken" } : idle ? { reason: "idle" } : {}) });
  if (loading.phase !== "error") say(idle ? SCREEN_IDLE + L().reconnectSuffix : L().disconnected);
  blocked = false;
};

function heard(message) {
  if (message.session) {
    if (message.session.t === "capabilities") clearTimeout(capabilityTimer);
    return session.receive(message.session);
  }
  if (message.error) {
    if (message.error === SCREEN_TAKEN) taken = true;
    if (message.error === SCREEN_IDLE) { idle = true; return say(SCREEN_IDLE + L().reconnectSuffix); }
    return say(message.error);
  }
  if (message.rtc) return signal(message.rtc);
  if (message.pong) return meter && meter.pong(message.pong);
  if (message.clipboard) return receiveComputerClipboard(message.clipboard);
  if (message.clipboardResult) return window.linkshellClipboardResult(message.clipboardResult);
  if (message.privacy) return receivePrivacyState(message.privacy);
  if (message.restart) {
    jpegGeneration += 1;
    jpegPending = null;
    // The host starts the stream again at another quality: a new decoder for it.
    try { if (decoder) decoder.close(); } catch {}
    decoder = undefined;
    skipping = false;
    // What the old decoder still held will never be shown: it has arrived, and that is said.
    shownUpTo(arrived);
    if (message.lighter && performance.now() - lighterAt > 30000) {
      lighterAt = performance.now();
      hint(L().slowerHint, 3000);
    }
  }
  if (message.control) {
    const was = controlling();
    Object.assign(control, { known: true, reason: "" }, message.control);
    if (mode !== "view") explain(was);
    refresh();
  }
  if (message.cursor) echo(message.cursor.x, message.cursor.y);
}
`;

/** Pointer, keyboard, layout, toolbar, shortcut, and clipboard UI logic for the screen viewer. */
