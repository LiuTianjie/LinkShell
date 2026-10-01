// The page a device opens to watch — and control — the computer's screen. It is
// served by the host, so the gestures and the toolbar come with the host's
// version; the app around it only supplies what a page cannot do itself (the
// full screen, turning the phone's screen, room for the keyboard).
//
// Gestures follow what remote desktop apps have settled on:
//   触控板  one finger moves the pointer, a tap clicks where the pointer is
//   点按    a tap clicks where the finger is
//   both    two-finger tap or a long press: right click; two fingers moving:
//           scroll; a second tap that stays down and moves: drag; pinch: zoom;
//           three-finger tap: the keyboard
// With a mouse (a desktop browser) the pointer, buttons, wheel and keys go straight through.

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  view: icon('<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
  trackpad: icon('<path d="M6.5 3.5v15l4-3.4 2.6 5.4 2.5-1.2-2.6-5.3 5-.6Z"/>'),
  touch: icon('<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.6"/>'),
  keyboard: icon('<rect x="2.5" y="6" width="19" height="12" rx="2.6"/><path d="M6.6 10h.01M10.2 10h.01M13.8 10h.01M17.4 10h.01M6.6 14h.01M17.4 14h.01M10 14h4"/>'),
  fit: icon('<circle cx="10.5" cy="10.5" r="6.2"/><path d="m15.2 15.2 5 5M8 10.5h5"/>'),
  rotate: icon('<rect x="3.5" y="10" width="17" height="9.5" rx="2.2"/><path d="M7 6.2a8.4 8.4 0 0 1 10 0M17 6.2V3.4M17 6.2h-2.8"/>'),
  expand: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  shrink: icon('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  down: icon('<path d="m6 9.5 6 6 6-6"/>'),
};

const STYLE = String.raw`
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; overscroll-behavior: none; }
  body { position: fixed; inset: 0; color: #fff; font: 15px/1.45 -apple-system, system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif; }
  #stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; }
  canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  #pointer { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%; pointer-events: none;
    border: 2px solid rgba(255,255,255,0.95); box-shadow: 0 0 0 1px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.35);
    opacity: 0; transition: opacity 0.3s; will-change: transform; }
  #pointer.on { opacity: 1; transition: none; }
  #pointer.pressed { background: rgba(255,255,255,0.4); }
  #note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 32px;
    color: rgba(255,255,255,0.72); text-align: center; pointer-events: none; }
  .glass { background: rgba(38,38,42,0.74); -webkit-backdrop-filter: blur(22px) saturate(1.6); backdrop-filter: blur(22px) saturate(1.6);
    border: 0.5px solid rgba(255,255,255,0.16); box-shadow: 0 8px 28px rgba(0,0,0,0.38); }
  #bar { position: absolute; display: flex; gap: 2px; padding: 4px; border-radius: 26px; transition: opacity 0.4s; }
  #bar.side { flex-direction: column; }
  #bar.idle { opacity: 0.38; }
  #bar.hidden, .gone { display: none !important; }
  .tool { width: 44px; height: 44px; border-radius: 22px; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.92); }
  .tool.on { background: #fff; color: #111; }
  .tool:active { background: rgba(255,255,255,0.18); }
  .tool.on:active { background: rgba(255,255,255,0.82); }
  #menu { position: absolute; width: 248px; padding: 6px; border-radius: 20px; }
  .choice { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; }
  .choice:active { background: rgba(255,255,255,0.12); }
  .choice.on { background: rgba(255,255,255,0.16); }
  .choice b { display: block; font-weight: 600; font-size: 15px; }
  .choice span { display: block; font-size: 12.5px; color: rgba(255,255,255,0.62); }
  #toast { position: absolute; left: 50%; max-width: min(86vw, 420px); width: max-content; transform: translateX(-50%); padding: 10px 16px; border-radius: 18px;
    font-size: 13.5px; text-align: center; color: rgba(255,255,255,0.94); pointer-events: none; opacity: 0; transition: opacity 0.3s; }
  #toast.on { opacity: 1; }
  #keys { position: absolute; left: 0; right: 0; height: 46px; display: flex; align-items: center; gap: 5px; padding: 0 6px;
    background: rgba(28,28,30,0.96); border-top: 0.5px solid rgba(255,255,255,0.14); }
  .key { flex: 1 1 0; min-width: 0; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.13); color: #fff; font-size: 15px; font-variant-numeric: tabular-nums; }
  .key.word { font-size: 12.5px; }
  .key:active { background: rgba(255,255,255,0.3); }
  .key.on { background: #fff; color: #111; }
  #typing, #shortcut { position: absolute; left: 0; top: 0; width: 2px; height: 2px; padding: 0; border: 0; outline: 0; resize: none; opacity: 0;
    background: transparent; color: transparent; caret-color: transparent; font-size: 16px; -webkit-user-select: text; user-select: text; }
`;

const SCRIPT = String.raw`
(() => {
const $ = (id) => document.getElementById(id);
const stage = $("stage"), canvas = $("screen"), ctx = canvas.getContext("2d"), pointer = $("pointer");
const note = $("note"), bar = $("bar"), menu = $("menu"), toast = $("toast"), keys = $("keys"), typing = $("typing"), shortcut = $("shortcut");
const query = new URLSearchParams(location.search);
const app = window.ReactNativeWebView;
const tellApp = (message) => { if (app) app.postMessage(JSON.stringify(message)); };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const coarse = matchMedia("(pointer: coarse)").matches;
const android = /Android/i.test(navigator.userAgent);

const MODES = ["view", "trackpad", "touch"];
const HINTS = {
  view: "只看：双指缩放，单指移动画面",
  trackpad: "触控板：滑动移动指针，轻点点击 · 双指轻点右键 · 双指滑动滚动 · 轻点两下并按住拖拽",
  touch: "点按：点哪里就点哪里 · 长按右键 · 双指滑动滚动 · 轻点两下并按住拖拽",
};
let stored = null;
try { stored = localStorage.getItem("linkshell.screen.mode"); } catch {}
let mode = MODES.includes(query.get("mode")) ? query.get("mode") : MODES.includes(stored) ? stored : "view";

// What the app around the page has done to the phone's screen. A page in a plain browser has none of it.
// "clear" is the side of a phone lying down that has no camera in it.
const chrome = Object.assign({ fullscreen: false, landscape: false, canRotate: false, clear: null, insets: { top: 0, right: 0, bottom: 0, left: 0 } }, window.__linkshellChrome || {});
// Whether this viewer may move the computer's pointer: asked for with the first controlling mode.
const control = { asked: false, known: false, available: false, trusted: false, reason: "", app: "", prompted: false };
const content = { w: 0, h: 0 };
let zoom = 1, pan = { x: 0, y: 0 }, fit = 1;
let area = { x: 0, y: 0, w: 1, h: 1 }, shown = { x: 0, y: 0, w: 1, h: 1 };
const cursor = { x: 0.5, y: 0.5 };
let keysOpen = false;
const mods = new Set();

// ---- The picture ----------------------------------------------------------

const say = (text) => { note.textContent = text; note.classList.toggle("gone", !text); };
const hex = (n) => n.toString(16).padStart(2, "0");
function sps(unit) {
  for (let i = 0; i + 3 < unit.length; i++)
    if (unit[i] === 0 && unit[i + 1] === 0 && unit[i + 2] === 1 && (unit[i + 3] & 0x1f) === 7) return unit.subarray(i + 3);
}
if (!("VideoDecoder" in window)) say("这个系统版本的浏览器内核不支持视频解码，请升级系统后再试。");
let decoder, skipping = false, arrived = 0;
// The host is told which frame is on screen: that is how it knows when this end has fallen behind,
// and stops sending rather than let the picture drift into the past.
let lastShown = 0, telling = 0;
// For trying a slow path out without one: ?lag=2500&lagFor=12 answers 2.5 s late for the first 12 s.
const lag = Number(query.get("lag")) || 0, lagUntil = performance.now() + (Number(query.get("lagFor")) || 0) * 1000;
function shownUpTo(seq) {
  if (seq > lastShown) lastShown = seq;
  if (lag && performance.now() < lagUntil) { const late = lastShown; setTimeout(() => send({ t: "ack", n: late }), lag); return; }
  if (!telling) telling = setTimeout(() => { telling = 0; send({ t: "ack", n: lastShown }); }, 40);
}
let lighterAt = -Infinity;
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/stream" + location.search);
ws.binaryType = "arraybuffer";
const send = (message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
ws.onopen = () => { if (mode !== "view") askControl(); };
ws.onmessage = (event) => {
  if (typeof event.data === "string") return heard(JSON.parse(event.data));
  if (!("VideoDecoder" in window)) return;
  // A frame: whether it is a keyframe, its number, the picture.
  const head = new DataView(event.data);
  const key = head.getUint8(0) === 1;
  const seq = head.getUint32(1);
  const unit = new Uint8Array(event.data, 5);
  arrived = seq;
  // A decoder that can't keep up skips to the next keyframe; what it skips has still arrived.
  if (decoder && !key && (skipping || decoder.decodeQueueSize > 8)) { skipping = true; return shownUpTo(seq); }
  skipping = false;
  if (!decoder) {
    const params = key && sps(unit);
    if (!params) return;
    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = content.w = frame.displayWidth;
          canvas.height = content.h = frame.displayHeight;
          layout();
        }
        ctx.drawImage(frame, 0, 0);
        shownUpTo(frame.timestamp);
        frame.close();
        say("");
      },
      error: (error) => say("解码失败：" + error.message),
    });
    decoder.configure({ codec: "avc1." + hex(params[1]) + hex(params[2]) + hex(params[3]), optimizeForLatency: true });
  }
  decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: seq, data: unit }));
};
ws.onclose = () => { if (note.classList.contains("gone") || note.textContent.startsWith("正在")) say("屏幕连接已断开"); };

function heard(message) {
  if (message.error) return say(message.error);
  if (message.restart) {
    // The host starts the stream again at another quality: a new decoder for it.
    try { if (decoder) decoder.close(); } catch {}
    decoder = undefined;
    skipping = false;
    // What the old decoder still held will never be shown: it has arrived, and that is said.
    shownUpTo(arrived);
    if (message.lighter && performance.now() - lighterAt > 30000) {
      lighterAt = performance.now();
      hint("网络较慢：已降低画质，优先保证跟得上", 3000);
    }
  }
  if (message.control) {
    const was = controlling();
    Object.assign(control, { known: true, reason: "" }, message.control);
    if (mode !== "view") explain(was);
    refresh();
  }
  // The computer's own pointer moved: the next swipe starts from where it is now.
  if (message.cursor && !gesture) { cursor.x = message.cursor.x; cursor.y = message.cursor.y; place(); }
}

// ---- Layout ---------------------------------------------------------------

function viewport() {
  const v = window.visualViewport;
  return v ? { w: v.width, h: v.height, x: v.offsetLeft, y: v.offsetTop } : { w: innerWidth, h: innerHeight, x: 0, y: 0 };
}

function layout() {
  const v = viewport(), inset = chrome.insets;
  // Above the keyboard, or above the phone's bottom edge when the keys are a real keyboard's.
  const keysHeight = keysOpen ? 46 + inset.bottom : 0;
  area = { x: v.x + inset.left, y: v.y + inset.top, w: Math.max(1, v.w - inset.left - inset.right), h: Math.max(1, v.h - inset.top - keysHeight) };
  if (content.w) {
    fit = Math.min(area.w / content.w, area.h / content.h);
    const w = content.w * fit * zoom, h = content.h * fit * zoom;
    // Centred while it fits; once larger than the view it is moved about, never past its own edges.
    pan.x = w <= area.w ? area.x + (area.w - w) / 2 : clamp(pan.x, area.x + area.w - w, area.x);
    pan.y = h <= area.h ? area.y + (area.h - h) / 2 : clamp(pan.y, area.y + area.h - h, area.y);
    shown = { x: pan.x, y: pan.y, w, h };
    canvas.style.transform = "translate(" + pan.x + "px," + pan.y + "px) scale(" + fit * zoom + ")";
  }
  keys.classList.toggle("gone", !keysOpen);
  keys.style.top = v.y + v.h - keysHeight + "px";
  keys.style.height = keysHeight + "px";
  keys.style.paddingBottom = inset.bottom + "px";
  // The toolbar stands in the black beside the picture when there is some, under it otherwise; the keyboard takes its place.
  const beside = content.w ? area.w - content.w * fit > area.h - content.h * fit + inset.bottom : v.w > v.h;
  bar.classList.toggle("side", beside);
  bar.classList.toggle("hidden", keysOpen);
  const size = { w: bar.offsetWidth, h: bar.offsetHeight };
  // Beside the picture it takes the side without the camera, and stands in the middle of the black there.
  const onLeft = beside && (chrome.clear ? chrome.clear === "left" : inset.left < inset.right);
  if (beside) {
    const edge = onLeft ? inset.left : inset.right;
    const black = edge + (content.w ? (area.w - content.w * fit) / 2 : 0);
    const gap = chrome.clear || !edge ? Math.max(8, (black - size.w) / 2) : edge;
    bar.style.left = (onLeft ? v.x + gap : v.x + v.w - gap - size.w) + "px";
    bar.style.top = area.y + (area.h - size.h) / 2 + "px";
  } else {
    bar.style.left = v.x + (v.w - size.w) / 2 + "px";
    bar.style.top = v.y + v.h - Math.max(inset.bottom, 8) - 8 - size.h + "px";
  }
  if (!menu.classList.contains("gone")) {
    const box = bar.getBoundingClientRect();
    menu.style.left = clamp(!beside ? box.left + box.width / 2 - 124 : onLeft ? box.right + 10 : box.left - 248 - 10, v.x + 8, v.x + v.w - 256) + "px";
    menu.style.top = clamp(beside ? box.top : box.top - menu.offsetHeight - 10, v.y + inset.top + 8, v.y + v.h - menu.offsetHeight - 8) + "px";
  }
  toast.style.top = area.y + 14 + "px";
  place();
}

function place() {
  pointer.style.transform = "translate(" + (shown.x + cursor.x * shown.w) + "px," + (shown.y + cursor.y * shown.h) + "px)";
}

addEventListener("resize", layout);
if (window.visualViewport) {
  visualViewport.addEventListener("resize", layout);
  visualViewport.addEventListener("scroll", layout);
}

function zoomTo(next, at) {
  // The point of the picture under the fingers stays under them.
  const u = (at.x - shown.x) / shown.w, v = (at.y - shown.y) / shown.h;
  zoom = clamp(next, 1, 8);
  pan.x = at.x - u * content.w * fit * zoom;
  pan.y = at.y - v * content.h * fit * zoom;
  layout();
  refresh();
}

function panBy(dx, dy) {
  pan.x += dx;
  pan.y += dy;
  layout();
}

// ---- Sending --------------------------------------------------------------

const controlling = () => mode !== "view" && control.available && control.trusted;

function askControl() {
  if (control.asked) return;
  control.asked = true;
  send({ t: "control" });
}

let moveWaiting = false;
function flush() {
  if (!moveWaiting) return;
  moveWaiting = false;
  send({ t: "move", x: +cursor.x.toFixed(5), y: +cursor.y.toFixed(5) });
}
// A pointer position a frame: as often as the picture could show it.
function moved() {
  if (!moveWaiting) requestAnimationFrame(flush);
  moveWaiting = true;
  glow();
  place();
}
// Everything else goes at once, after the position it happens at.
function act(message) {
  flush();
  send(message);
}

let fade = 0;
function glow() {
  if (mode !== "trackpad") return;
  pointer.classList.add("on");
  clearTimeout(fade);
  fade = setTimeout(() => pointer.classList.remove("on"), 900);
}

/** The modifiers armed on the key bar, used up by the click or key that takes them. */
function takeMods() {
  if (!mods.size) return undefined;
  const taken = [...mods];
  mods.clear();
  drawKeys();
  return taken;
}

function click(buttonName, count) {
  const m = takeMods();
  act({ t: "down", b: buttonName, n: count, m });
  send({ t: "up", b: buttonName, n: count, m });
}

/** Puts the pointer under a point of the page; false when that is outside the picture. */
function pointAt(x, y) {
  const u = (x - shown.x) / shown.w, v = (y - shown.y) / shown.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  cursor.x = u;
  cursor.y = v;
  moved();
  return true;
}

/** Moves the pointer as a trackpad does: slow fingers place it, quick ones cross the screen. */
function nudge(dx, dy, dt) {
  const gain = clamp(0.85 + (Math.hypot(dx, dy) / dt) * 1.15, 0.85, 3.4);
  cursor.x = clamp(cursor.x + (dx * gain) / shown.w, 0, 1);
  cursor.y = clamp(cursor.y + (dy * gain) / shown.h, 0, 1);
  // Zoomed in, the view follows the pointer to the edge it is pushing.
  if (zoom > 1) {
    const edge = Math.min(56, area.w / 4, area.h / 4);
    const x = shown.x + cursor.x * shown.w, y = shown.y + cursor.y * shown.h;
    const shiftX = x < area.x + edge ? area.x + edge - x : x > area.x + area.w - edge ? area.x + area.w - edge - x : 0;
    const shiftY = y < area.y + edge ? area.y + edge - y : y > area.y + area.h - edge ? area.y + area.h - edge - y : 0;
    if (shiftX || shiftY) panBy(shiftX, shiftY);
  }
  moved();
}

// ---- Touch ----------------------------------------------------------------

const SLOP = 8, HOLD_MS = 480, AGAIN_MS = 320, TAP_MS = 350;
const touches = new Map();
let gesture = null;
let lastTap = null;

function centre() {
  const [a, b] = [...touches.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
}

function endOne() {
  if (!gesture || gesture.kind !== "one") return;
  clearTimeout(gesture.hold);
  if (gesture.dragging) {
    act({ t: "up", b: "left" });
    pointer.classList.remove("pressed");
  }
}

stage.addEventListener("pointerdown", (event) => {
  wake();
  // A touch that closes the menu does nothing else.
  const closing = closeMenu();
  if (event.pointerType === "mouse") return closing ? undefined : mouseDown(event);
  event.preventDefault();
  try { stage.setPointerCapture(event.pointerId); } catch {}
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const now = performance.now();
  if (closing) {
    gesture = { kind: "more", t0: now };
  } else if (touches.size === 1) {
    const again = !!lastTap && now - lastTap.t < AGAIN_MS && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 48;
    const mine = (gesture = { kind: "one", id: event.pointerId, x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, t0: now, t: now, again, moving: false, dragging: false, held: false, hold: 0 });
    // Staying down without moving is the right button.
    if (controlling() && !again) mine.hold = setTimeout(() => {
      if (gesture !== mine || mine.moving) return;
      if (mode === "touch" && !pointAt(mine.x0, mine.y0)) return;
      mine.held = true;
      click("right", 1);
      tellApp({ type: "haptic", kind: "medium" });
    }, HOLD_MS);
  } else if (touches.size === 2) {
    endOne();
    const c = centre();
    gesture = { kind: "two", t0: now, c0: c, c, d0: c.d, zoom0: zoom, what: null, restX: 0, restY: 0 };
  } else {
    endOne();
    gesture = { kind: touches.size === 3 ? "three" : "more", t0: now };
  }
});

stage.addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse") return mouseMove(event);
  const touch = touches.get(event.pointerId);
  if (!touch || !gesture) return;
  touch.x = event.clientX;
  touch.y = event.clientY;
  if (gesture.kind === "one" && gesture.id === event.pointerId) {
    const g = gesture, now = performance.now();
    const dx = touch.x - g.x, dy = touch.y - g.y, dt = Math.max(1, now - g.t);
    if (!g.moving) {
      if (Math.hypot(touch.x - g.x0, touch.y - g.y0) < SLOP) return;
      g.moving = true;
      clearTimeout(g.hold);
      // A second tap that stays down and moves holds the button: a drag.
      if (controlling() && g.again && !g.held && (mode === "trackpad" || pointAt(g.x0, g.y0))) {
        act({ t: "down", b: "left", n: 1, m: takeMods() });
        g.dragging = true;
        pointer.classList.add("pressed");
        tellApp({ type: "haptic", kind: "light" });
      }
    }
    g.x = touch.x;
    g.y = touch.y;
    g.t = now;
    if (g.held) return;
    if (!controlling()) panBy(dx, dy);
    else if (mode === "trackpad") nudge(dx, dy, dt);
    else if (g.dragging) pointAt(clamp(g.x, shown.x, shown.x + shown.w), clamp(g.y, shown.y, shown.y + shown.h));
    else panBy(dx, dy);
  } else if (gesture.kind === "two" && touches.size === 2) {
    const g = gesture, c = centre();
    if (!g.what) {
      if (Math.abs(c.d - g.d0) > 26) {
        g.what = "zoom";
        g.d0 = c.d;
      } else if (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > 10) {
        g.what = controlling() ? "scroll" : "pan";
        // Scrolling lands on what is under the fingers.
        if (g.what === "scroll" && mode === "touch") pointAt(g.c0.x, g.c0.y);
      } else return;
    }
    if (g.what === "zoom") {
      const u = (g.c.x - shown.x) / shown.w, v = (g.c.y - shown.y) / shown.h;
      zoom = clamp((g.zoom0 * c.d) / g.d0, 1, 8);
      pan.x = c.x - u * content.w * fit * zoom;
      pan.y = c.y - v * content.h * fit * zoom;
      layout();
    } else if (g.what === "scroll") {
      // The page follows the fingers, as it does on the phone itself.
      g.restX += (c.x - g.c.x) * 2.4;
      g.restY += (c.y - g.c.y) * 2.4;
      const sx = Math.trunc(g.restX), sy = Math.trunc(g.restY);
      if (sx || sy) {
        g.restX -= sx;
        g.restY -= sy;
        act({ t: "scroll", dx: sx, dy: sy, m: mods.size ? [...mods] : undefined });
      }
    } else panBy(c.x - g.c.x, c.y - g.c.y);
    g.c = c;
  }
});

function lift(event, cancelled) {
  if (event.pointerType === "mouse") return mouseUp(event);
  if (!touches.delete(event.pointerId) || !gesture) return;
  const g = gesture, now = performance.now();
  if (g.kind === "one") {
    endOne();
    gesture = null;
    if (!cancelled && !g.moving && !g.held && now - g.t0 < HOLD_MS + 200) tap(g, now);
    return;
  }
  // The rest of a gesture with several fingers ends when the last one leaves.
  if (touches.size) return;
  gesture = null;
  refresh();
  if (cancelled || now - g.t0 > TAP_MS) return;
  if (g.kind === "two" && !g.what && controlling()) {
    if (mode === "touch" && !pointAt(g.c0.x, g.c0.y)) return;
    click("right", 1);
    tellApp({ type: "haptic", kind: "light" });
  } else if (g.kind === "three" && mode !== "view") toggleKeys();
}
stage.addEventListener("pointerup", (event) => lift(event, false));
stage.addEventListener("pointercancel", (event) => lift(event, true));
// Keeps the keyboard up while the fingers work on the picture, and the page from scrolling or selecting.
stage.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
addEventListener("contextmenu", (event) => event.preventDefault());

function tap(g, now) {
  if (!controlling()) {
    if (mode !== "view") return explain(false);
    // Only watching: a double tap goes in on that spot, and back out.
    if (g.again) {
      lastTap = null;
      return zoomTo(zoom > 1.05 ? 1 : 2.5, { x: g.x0, y: g.y0 });
    }
    lastTap = { t: now, x: g.x0, y: g.y0 };
    return;
  }
  if (mode === "touch" && !pointAt(g.x0, g.y0)) return;
  glow();
  click("left", g.again ? 2 : 1);
  lastTap = g.again ? null : { t: now, x: g.x0, y: g.y0 };
}

// ---- Mouse (a desktop browser) -------------------------------------------

let mouseHeld = null, mouseClicks = { t: 0, n: 0, x: 0, y: 0, b: 0 };
function mouseDown(event) {
  if (!controlling()) { mouseHeld = "pan"; return; }
  typing.focus({ preventScroll: true });
  event.preventDefault();
  if (!pointAt(event.clientX, event.clientY)) return;
  const now = performance.now();
  // Clicks count up only in the same place, with the same button, soon after one another.
  const repeat = now - mouseClicks.t < 400 && event.button === mouseClicks.b && Math.hypot(event.clientX - mouseClicks.x, event.clientY - mouseClicks.y) < 6;
  mouseClicks = { t: now, n: repeat ? Math.min(mouseClicks.n + 1, 3) : 1, x: event.clientX, y: event.clientY, b: event.button };
  mouseHeld = event.button === 2 ? "right" : "left";
  act({ t: "down", b: mouseHeld, n: mouseClicks.n, m: hardMods(event) });
}
function mouseMove(event) {
  if (mouseHeld === "pan") return panBy(event.movementX, event.movementY);
  if (controlling()) pointAt(clamp(event.clientX, shown.x, shown.x + shown.w), clamp(event.clientY, shown.y, shown.y + shown.h));
}
function mouseUp(event) {
  if (mouseHeld && mouseHeld !== "pan") act({ t: "up", b: mouseHeld, n: mouseClicks.n, m: hardMods(event) });
  mouseHeld = null;
}
stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (controlling() && !event.ctrlKey) return act({ t: "scroll", dx: -event.deltaX, dy: -event.deltaY });
  zoomTo(zoom * Math.exp(-event.deltaY / 300), { x: event.clientX, y: event.clientY });
}, { passive: false });

// ---- Keyboard -------------------------------------------------------------

// The field is never empty, so a backspace always has something to take and reports itself.
const HELD = "::";
const NAMED = { Enter: "return", Backspace: "backspace", Tab: "tab", Escape: "escape", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  Delete: "delete", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown" };
const KEY_OF = { " ": "space" };
let composing = false, composed = "", switching = false, leftover = null;

const hardMods = (event) => {
  const list = [event.metaKey && "cmd", event.ctrlKey && "ctrl", event.altKey && "alt", event.shiftKey && "shift"].filter(Boolean);
  return list.length ? list : undefined;
};

function resetTyping() {
  typing.value = HELD;
  typing.setSelectionRange(HELD.length, HELD.length);
}

function press(name, extra) {
  const armed = takeMods() || [];
  const all = [...new Set([...armed, ...(extra || [])])];
  act({ t: "key", k: name, m: all.length ? all : undefined });
}

function typed(text) {
  if (!text) return;
  // One character with a modifier armed is a shortcut, not text.
  if (mods.size && [...text].length === 1) return press(KEY_OF[text] || text.toLowerCase());
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line) act({ t: "text", s: line });
    if (index < lines.length - 1) press("return");
  });
}

function keyDown(event) {
  if (event.isComposing || event.keyCode === 229) return;
  const name = NAMED[event.key] || (/^F([1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : null);
  if (name) {
    event.preventDefault();
    return press(name, hardMods(event));
  }
  // A real keyboard's shortcuts.
  if ((event.metaKey || event.ctrlKey) && event.key.length === 1) {
    event.preventDefault();
    press(KEY_OF[event.key] || event.key.toLowerCase(), hardMods(event));
  }
}
typing.addEventListener("keydown", keyDown);
shortcut.addEventListener("keydown", keyDown);
typing.addEventListener("compositionstart", () => { composing = true; composed = ""; });
typing.addEventListener("compositionupdate", (event) => {
  // Android keyboards compose plain words too: what they have so far is typed as it grows, and
  // taken back when they change their mind, rather than arriving a word late.
  if (!android || mods.size) return;
  const next = event.data || "";
  let same = 0;
  while (same < composed.length && same < next.length && composed[same] === next[same]) same++;
  for (let i = same; i < composed.length; i++) act({ t: "key", k: "backspace" });
  if (next.length > same) act({ t: "text", s: next.slice(same) });
  composed = next;
});
typing.addEventListener("compositionend", (event) => {
  composing = false;
  const text = isLeftover(event.data || "") ? "" : event.data || "";
  if (android && !mods.size) {
    let same = 0;
    while (same < composed.length && same < text.length && composed[same] === text[same]) same++;
    for (let i = same; i < composed.length; i++) act({ t: "key", k: "backspace" });
    if (text.length > same) act({ t: "text", s: text.slice(same) });
  } else typed(text);
  composed = "";
  resetTyping();
});
typing.addEventListener("input", () => {
  if (composing) return;
  const value = typing.value;
  if (value.startsWith(HELD) && isLeftover(value.slice(HELD.length))) return resetTyping();
  if (value.startsWith(HELD)) typed(value.slice(HELD.length));
  else for (let i = value.length; i < HELD.length; i++) press("backspace");
  resetTyping();
});
// A letter typed with a modifier armed is a shortcut's key, and an input method (pinyin, say) would
// start composing with it; nothing a page does takes that back. So while a modifier is armed the
// keyboard belongs to a second field, of a kind the phone gives a plain keyboard to.
shortcut.addEventListener("input", () => {
  const value = shortcut.value;
  shortcut.value = "";
  if (!value) return;
  const letter = [...value][0];
  // An input method that composed with the letter anyway hands it to the other field as the keyboard goes back: not typed twice.
  leftover = { text: letter, until: performance.now() + 600 };
  typed(letter);
});
/** Whether this text is what an input method had left of a shortcut's letter. */
function isLeftover(text) {
  const mine = leftover && text === leftover.text && performance.now() < leftover.until;
  leftover = null;
  return mine;
}
const keyboardUp = () => document.activeElement === typing || document.activeElement === shortcut;
function syncField() {
  if (!keyboardUp()) return;
  const field = mods.size ? shortcut : typing;
  if (document.activeElement === field) return;
  switching = true;
  field.focus({ preventScroll: true });
  switching = false;
}
for (const field of [typing, shortcut]) {
  field.addEventListener("focus", () => { if (switching) return; resetTyping(); keysOpen = coarse; layout(); refresh(); });
  field.addEventListener("blur", () => { if (switching) return; keysOpen = false; mods.clear(); drawKeys(); layout(); refresh(); });
}

function toggleKeys() {
  if (keyboardUp()) document.activeElement.blur();
  else typing.focus({ preventScroll: true });
}

// ---- Toolbar, menu, key bar ----------------------------------------------

/** A control that works on touch-up and never takes the focus (the keyboard stays as it is). */
function tappable(element, action) {
  element.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); wake(); });
  element.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("pointerup", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const box = element.getBoundingClientRect();
    if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) action();
  });
}

let idle = 0;
function wake() {
  bar.classList.remove("idle");
  clearTimeout(idle);
  idle = setTimeout(() => { if (menu.classList.contains("gone")) bar.classList.add("idle"); }, 4500);
}

let toastTimer = 0;
function hint(text, ms) {
  toast.textContent = text;
  toast.classList.add("on");
  clearTimeout(toastTimer);
  if (ms !== 0) toastTimer = setTimeout(() => toast.classList.remove("on"), ms || 4200);
}

/** Says why a controlling mode is not controlling, or how it works once it is. */
function explain(was) {
  if (!control.known) return hint("正在准备控制电脑…", 0);
  if (!control.available) return hint(control.reason || "这台电脑暂时不能被控制");
  if (!control.trusted) {
    // The system's own dialog, on the computer, once.
    if (!control.prompted) { control.prompted = true; send({ t: "prompt" }); }
    const who = control.app ? "「" + control.app + "」" : "LinkShell";
    return hint("电脑还没有允许被控制。电脑上已经打开「系统设置 › 隐私与安全性 › 辅助功能」，把" + who + "的开关打开，这里会自动继续；人不在电脑旁，回去后运行 linkshell screen 即可。", 0);
  }
  if (!was) hint(HINTS[mode]);
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  try { localStorage.setItem("linkshell.screen.mode", mode); } catch {}
  tellApp({ type: "mode", mode });
  pointer.classList.remove("on");
  if (mode === "view") {
    if (keyboardUp()) document.activeElement.blur();
    hint(HINTS.view);
  } else {
    askControl();
    explain(false);
  }
  refresh();
}

function closeMenu() {
  if (menu.classList.contains("gone")) return false;
  menu.classList.add("gone");
  wake();
  return true;
}

function refresh() {
  $("mode").innerHTML = ICON[mode];
  $("mode").classList.toggle("on", mode !== "view");
  $("keyboard").classList.toggle("gone", mode === "view");
  $("fit").classList.toggle("gone", zoom < 1.05);
  $("rotate").classList.toggle("gone", !app || !chrome.canRotate);
  $("rotate").classList.toggle("on", chrome.landscape);
  const full = app ? chrome.fullscreen : !!document.fullscreenElement;
  $("full").classList.toggle("gone", !app && !document.fullscreenEnabled);
  $("full").innerHTML = full ? ICON.shrink : ICON.expand;
  for (const choice of menu.children) choice.classList.toggle("on", choice.dataset.mode === mode);
  layout();
}

function drawKeys() {
  for (const key of keys.children) if (key.dataset.mod) key.classList.toggle("on", mods.has(key.dataset.mod));
  syncField();
}

const ICON = JSON.parse($("icons").textContent);
tappable($("mode"), () => { menu.classList.toggle("gone"); layout(); });
tappable($("keyboard"), toggleKeys);
tappable($("fit"), () => zoomTo(1, { x: area.x + area.w / 2, y: area.y + area.h / 2 }));
tappable($("rotate"), () => tellApp({ type: "landscape", on: !chrome.landscape }));
tappable($("full"), () => {
  if (app) return tellApp({ type: "fullscreen", on: !chrome.fullscreen });
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener("fullscreenchange", refresh);
for (const choice of menu.children) {
  choice.querySelector("i").innerHTML = ICON[choice.dataset.mode];
  tappable(choice, () => { closeMenu(); setMode(choice.dataset.mode); });
}
for (const key of keys.children) {
  tappable(key, () => {
    const mod = key.dataset.mod;
    if (mod) {
      if (!mods.delete(mod)) mods.add(mod);
      return drawKeys();
    }
    if (key.dataset.key) return press(key.dataset.key);
    if (keyboardUp()) document.activeElement.blur();
  });
}
$("hide").innerHTML = ICON.down;

/** The app tells the page what it did with the phone's screen. */
window.linkshellChrome = (next) => {
  Object.assign(chrome, next);
  refresh();
};

resetTyping();
refresh();
wake();
tellApp({ type: "ready", mode });
})();
`;

export function viewerPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>屏幕</title>
<style>${STYLE}</style></head>
<body>
<div id="stage"><canvas id="screen"></canvas><div id="pointer"></div></div>
<div id="note">正在连接电脑屏幕…</div>
<div id="toast" class="glass"></div>
<div id="menu" class="glass gone">
  <div class="choice" data-mode="view"><i></i><div><b>只看</b><span>不会碰到电脑上的任何东西</span></div></div>
  <div class="choice" data-mode="trackpad"><i></i><div><b>触控板</b><span>滑动移动指针，轻点点击</span></div></div>
  <div class="choice" data-mode="touch"><i></i><div><b>点按</b><span>点哪里，就点击哪里</span></div></div>
</div>
<div id="bar" class="glass">
  <div class="tool" id="mode" role="button" aria-label="控制方式"></div>
  <div class="tool" id="keyboard" role="button" aria-label="键盘">${ICONS.keyboard}</div>
  <div class="tool" id="fit" role="button" aria-label="还原缩放">${ICONS.fit}</div>
  <div class="tool" id="rotate" role="button" aria-label="横屏">${ICONS.rotate}</div>
  <div class="tool" id="full" role="button" aria-label="全屏"></div>
</div>
<div id="keys" class="gone">
  <div class="key word" data-key="escape">esc</div>
  <div class="key word" data-key="tab">tab</div>
  <div class="key" data-mod="ctrl">⌃</div>
  <div class="key" data-mod="alt">⌥</div>
  <div class="key" data-mod="cmd">⌘</div>
  <div class="key" data-mod="shift">⇧</div>
  <div class="key" data-key="left">←</div>
  <div class="key" data-key="down">↓</div>
  <div class="key" data-key="up">↑</div>
  <div class="key" data-key="right">→</div>
  <div class="key" id="hide" role="button" aria-label="收起键盘"></div>
</div>
<textarea id="typing" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="enter" aria-label="键盘输入"></textarea>
<input id="shortcut" type="email" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="快捷键">
<script type="application/json" id="icons">${JSON.stringify(ICONS)}</script>
<script>${SCRIPT}</script>
</body></html>`;
}
