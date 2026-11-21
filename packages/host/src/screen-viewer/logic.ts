/**
 * Pure screen-viewer helper logic exported without DOM bindings for unit testing.
 */
export const VIEWER_LOGIC = String.raw`
/** The negotiated format, not the codecs the browser might be able to receive. */
function videoCodec(codec) {
  if (!codec || !codec.mimeType) return null;
  const name = codec.mimeType.replace(/^video\//i, "");
  if (name.toUpperCase() !== "H264") return name;
  const profile = /(?:^|;)\s*profile-level-id=([0-9a-f]{6})(?:;|$)/i.exec(codec.sdpFmtpLine || "");
  const prefix = profile && profile[1].slice(0, 4).toLowerCase();
  const label = prefix === "640c" ? "Constrained High" : prefix === "6400" ? "High" : prefix && prefix.startsWith("42") ? "Baseline" : "";
  return "H.264" + (label ? " " + label : "");
}
/** All controls share the same usable rectangle, including asymmetric system chrome. */
function usableViewport(v, inset) {
  const left = Math.max(0, inset.left || 0), right = Math.max(0, inset.right || 0);
  const top = Math.max(0, inset.top || 0), bottom = Math.max(0, inset.bottom || 0);
  return { x: v.x + left, y: v.y + top, w: Math.max(1, v.w - left - right), h: Math.max(1, v.h - top - bottom) };
}
function containedBox(safe, width, height, x, y, gap = 8) {
  const w = Math.min(width, Math.max(1, safe.w - gap * 2)), h = Math.min(height, Math.max(1, safe.h - gap * 2));
  return { x: Math.max(safe.x + gap, Math.min(x, safe.x + safe.w - gap - w)), y: Math.max(safe.y + gap, Math.min(y, safe.y + safe.h - gap - h)), w, h };
}

/** Try each edge of the toolbar, preferring the black outside the fitted picture. */
function anchoredPanel(safe, picture, anchor, width, height) {
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const candidates = [
    [anchor.x - width - 10, anchor.y + (anchor.h - height) / 2],
    [anchor.x + anchor.w + 10, anchor.y + (anchor.h - height) / 2],
    [anchor.x + (anchor.w - width) / 2, anchor.y - height - 10],
    [anchor.x + (anchor.w - width) / 2, anchor.y + anchor.h + 10],
  ].map(([x, y]) => containedBox(safe, width, height, x, y));
  const score = (box) => overlap(box, picture) + overlap(box, anchor) * 100;
  return candidates.reduce((best, box) => score(box) < score(best) ? box : best);
}

/** FLIP keeps the live media at its visible position while its destination changes. */
function presentationFlip(from, to, reduceMotion) {
  if (reduceMotion || !from || !to || ![from.x, from.y, from.w, from.h, to.x, to.y, to.w, to.h].every(Number.isFinite) || Math.min(from.w, from.h, to.w, to.h) <= 0) return null;
  const sx = from.w / to.w, sy = from.h / to.h;
  return { x: from.x - to.x * sx, y: from.y - to.y * sy, sx, sy };
}

/** Exact damped-spring integration keeps momentum when the destination changes mid-flight. */
function presentationSpring(current, velocity, target, seconds, frequency = 32) {
  const damping = 0.8;
  const decay = frequency * damping, oscillation = frequency * Math.sqrt(1 - damping * damping);
  const dt = Math.max(0, Math.min(seconds, 0.064)), envelope = Math.exp(-decay * dt);
  const cosine = Math.cos(oscillation * dt), sine = Math.sin(oscillation * dt);
  const next = {}, speed = {};
  let settled = true;
  for (const key of ["x", "y", "w", "h"]) {
    const displacement = current[key] - target[key], v = velocity[key];
    next[key] = target[key] + envelope * (displacement * cosine + (v + decay * displacement) / oscillation * sine);
    speed[key] = envelope * (v * cosine - (decay * v + frequency * frequency * displacement) / oscillation * sine);
    if (Math.abs(next[key] - target[key]) > 0.05 || Math.abs(speed[key]) > 0.4) settled = false;
  }
  return { current: next, velocity: speed, settled };
}

/** The same panel enters from its available edge in both narrow and wide layouts. */
function sheetPresentation(progress, width, height, dock) {
  const remaining = 1 - progress;
  const x = dock === "left" ? -(width + 24) * remaining : dock === "right" ? (width + 24) * remaining : 0;
  const y = dock === "bottom" ? (height + 24) * remaining : dock === "top" ? -(height + 24) * remaining : 0;
  return { x, y, opacity: Math.max(0, Math.min(1, progress)) };
}

function popoverPresentation(progress, dx, dy) {
  return { x: dx * (1 - progress), y: dy * (1 - progress), scale: 0.94 + 0.06 * progress, opacity: Math.max(0, Math.min(1, progress)) };
}
function controlCanCollapse(state) {
  return !!state.fullscreen && !state.menu && !state.sheet && !state.keyboard && !state.pressed && !state.presenting;
}
function orbBounds(safe, anchor, point) {
  const x = point ? safe.x + 8 + Math.max(0, Math.min(1, point.u)) * Math.max(0, safe.w - 60) : anchor.x + anchor.w / 2 - 22;
  const y = point ? safe.y + 8 + Math.max(0, Math.min(1, point.v)) * Math.max(0, safe.h - 60) : anchor.y + anchor.h / 2 - 22;
  return containedBox(safe, 44, 44, x, y);
}

/** One glass surface changes shape; its contents can fade without swapping backgrounds. */
function controlsMorph(progress, anchor, ball) {
  const p = Math.max(0, Math.min(1, progress)), phase = Math.min(1, p / 0.3);
  const x = ball.x + 6 + (anchor.x - ball.x - 6) * progress;
  const y = ball.y + 6 + (anchor.y - ball.y - 6) * progress;
  const w = Math.max(1, 32 + (anchor.w - 32) * progress), h = Math.max(1, 32 + (anchor.h - 32) * progress);
  return { x, y, w, h, radius: Math.min(w, h) / 2, shellOpacity: 0.3 + 0.7 * phase * phase * (3 - 2 * phase),
    dx: x + w / 2 - anchor.x - anchor.w / 2, dy: y + h / 2 - anchor.y - anchor.h / 2,
    contentScale: Math.max(0.01, Math.min(w / Math.max(1, anchor.w), h / Math.max(1, anchor.h))),
    barOpacity: p * p, orbOpacity: 1 - p };
}

/** Keep controls in one usable pane while the live desktop remains continuous across a fold. */
function interactionViewport(viewport, insets, divisions, preferred) {
  const safe = usableViewport(viewport, insets);
  let regions = [safe];
  for (const reported of Array.isArray(divisions) ? divisions : []) {
    if (!reported.active || ![reported.x, reported.y, reported.width, reported.height].every(Number.isFinite)) continue;
    if (reported.width < 0 || reported.height < 0) continue;
    const division = { ...reported, x: viewport.x + reported.x, y: viewport.y + reported.y };
    const vertical = division.height > division.width;
    const next = [];
    for (const region of regions) {
      const right = region.x + region.w, bottom = region.y + region.h;
      if (division.x >= right || division.y >= bottom || division.x + division.width <= region.x || division.y + division.height <= region.y) { next.push(region); continue; }
      if (vertical) {
        if (division.x > region.x) next.push({ x: region.x, y: region.y, w: division.x - region.x, h: region.h });
        if (division.x + division.width < right) next.push({ x: division.x + division.width, y: region.y, w: right - division.x - division.width, h: region.h });
      } else {
        if (division.y > region.y) next.push({ x: region.x, y: region.y, w: region.w, h: division.y - region.y });
        if (division.y + division.height < bottom) next.push({ x: region.x, y: division.y + division.height, w: region.w, h: bottom - division.y - division.height });
      }
    }
    if (next.length) regions = next;
  }
  const usable = regions.filter(region => region.w >= Math.min(180, safe.w) && region.h >= Math.min(80, safe.h));
  const candidates = usable.length ? usable : regions;
  if (preferred && Number.isFinite(preferred.x) && Number.isFinite(preferred.y)) {
    const distance = region => Math.hypot(Math.max(region.x - preferred.x, 0, preferred.x - region.x - region.w), Math.max(region.y - preferred.y, 0, preferred.y - region.y - region.h));
    return candidates.reduce((best, region) => distance(region) <= distance(best) ? region : best);
  }
  // The outer right edge and the lower tabletop pane are the natural default reach areas.
  return candidates[candidates.length - 1] || safe;
}

/** Undoes the Gray code the time on a clock strip is written in. */
function fromGray(gray) {
  let n = gray;
  for (let shift = 1; shift < 16; shift <<= 1) n ^= n >> shift;
  return n;
}

/**
 * The time on a clock strip, from one pixel (RGBA) at the middle of each of its 20 cells: white, black,
 * the 16 bits, black, white. Undefined when what is there is not a strip.
 */
function stripTime(pixels) {
  const light = (cell) => (pixels[cell * 4] + pixels[cell * 4 + 1] + pixels[cell * 4 + 2]) / 3;
  const white = (light(0) + light(19)) / 2, black = (light(1) + light(18)) / 2;
  if (white - black < 80) return undefined;
  let gray = 0;
  for (let cell = 2; cell < 18; cell++) gray = (gray << 1) | (light(cell) > (white + black) / 2 ? 1 : 0);
  return fromGray(gray);
}

/**
 * How old a frame is when it is shown: shownAt is on the computer's clock, in milliseconds, and the time
 * on the frame's strip is that clock's low 16 bits. More than half a minute is a misreading.
 */
function lateness(shownAt, time) {
  const late = (((shownAt - time) % 65536) + 65536) % 65536;
  return late > 30000 ? undefined : Math.round(late * 10) / 10;
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p) => (sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null);
  return { n: sorted.length, min: rank(0), p50: rank(0.5), p95: rank(0.95), max: rank(1) };
}

/**
 * How far the computer's clock is ahead of the page's, from a question sent at one time (the page's) and
 * answered with the computer's. The answer that came back quickest is the one kept: it is off by half its trip at most.
 */
function synced(clock, sent, back, now) {
  const trip = back - sent;
  return trip < clock.trip ? { trip, offset: now - (sent + trip / 2) } : clock;
}

/**
 * Whether a position the computer reports for its pointer is one this page put it at within the last
 * second (trail: what it sent, and when): its own move coming back, a round trip late.
 */
function ownEcho(trail, x, y, now) {
  return trail.some((point) => now - point.t < 1000 && Math.abs(point.x - x) < 0.003 && Math.abs(point.y - y) < 0.003);
}

/**
 * Which of the app's two channels an event goes on. "pointer" (no order, sent once) has only what nothing
 * waits for: a move or a turn of the wheel that is not placed (sent with what happens at it), not made
 * with a button held, and not tied to a position that went on "input".
 */
function laneOf(kind, placed, held, tied) {
  return (kind === "move" || kind === "scroll") && !placed && !held && !tied ? "pointer" : "input";
}

/**
 * Whether the phone's keyboard is up, from what is known. A field with the focus is not enough: a phone
 * takes its keyboard down without a word to the page (the app was put aside and came back, something
 * else of the app's took the keys), and the field goes on saying it has the focus.
 *   focused  one of the page's fields has the focus
 *   asked    milliseconds since the page asked for the keyboard: it takes a few hundred to come up, and
 *            nobody has seen it yet
 *   said     what the app around the page says of the keyboard; undefined in a browser, which has
 *            nobody to ask, and in an app from before it said anything
 *   shrunk   failing that, whether the window is shorter than it has been: undefined where it has never
 *            been seen to make room for a keyboard
 *   live     the page is the one the keys go to. A field with the focus in a page that is not, is one
 *            the keyboard was taken from. In one that is, with no keyboard on show, the keys are a real
 *            keyboard's and typing works: the app says when a keyboard that was up has gone, and the
 *            field is let go of at that (see settle), so it is not that
 */
function keyboardIsUp(known) {
  if (!known.focused) return false;
  if (known.asked < 1000) return true;
  if (known.said !== undefined) return known.said || known.live;
  return known.shrunk === undefined ? known.live : known.shrunk;
}

/** Text in pieces no longer than one event may carry, counted as the computer counts (UTF-16), and never cut through a character. */
function pieces(text, most) {
  const out = [];
  let piece = "";
  for (const character of text) {
    if (piece.length + character.length > most) {
      out.push(piece);
      piece = "";
    }
    piece += character;
  }
  if (piece) out.push(piece);
  return out;
}

/** What typing a text on the computer is: its lines as text, the return key between them. */
function typingOf(text, most) {
  const events = [];
  text.replace(/\r\n?/g, "\n").split("\n").forEach((line, index) => {
    if (index) events.push({ t: "key", k: "return" });
    for (const s of pieces(line, most)) events.push({ t: "text", s });
  });
  return events;
}

// The keys the computer knows by name (apps/mac, Keys.swift), and how a shortcut is written.
const MOD_ORDER = ["ctrl", "alt", "shift", "cmd"];
const MOD_SIGNS = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const KEY_SIGNS = { return: "↩\uFE0E", tab: "Tab", space: "Space", backspace: "⌫", escape: "Esc", left: "←", right: "→", down: "↓", up: "↑",
  delete: "⌦", home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn" };
const KEY_CHARACTERS = "abcdefghijklmnopqrstuvwxyz1234567890-=[]\\;',./\x60";

function keyKnown(k) {
  return typeof k === "string" && (Object.hasOwn(KEY_SIGNS, k) || /^f([1-9]|1[0-2])$/.test(k) || (k.length === 1 && KEY_CHARACTERS.includes(k)));
}

/** The modifiers among these names that are modifiers, each once, in the order they are written in. */
function modsOf(names) {
  return MOD_ORDER.filter((mod) => Array.isArray(names) && names.includes(mod));
}

/** A shortcut as a Mac writes it: ⌃⌥⇧⌘ and the key. */
function comboSign(k, m) {
  return modsOf(m).map((mod) => MOD_SIGNS[mod]).join("") + (KEY_SIGNS[k] || k.toUpperCase());
}

/**
 * The user's own shortcuts, from wherever they were kept (the app, the browser): only those the computer
 * would take, 24 at most, each with a name (the shortcut itself when it was given none).
 */
/**
 * The offer without the playout-delay extension, for a receiver that chose even pacing. The sender writes
 * 0/0 into that header (show each frame the moment it is decoded); an answer that never agreed to it leaves
 * the receiver its adaptive jitter buffer. Taken out of the remote offer, so the answer stays the browser's own.
 */
function withoutPlayoutDelay(sdp) {
  return String(sdp).split(/\r\n/).filter((line) => !/^a=extmap:\d+(?:\/\w+)?\s+http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/playout-delay(?:\s|$)/.test(line)).join("\r\n");
}

function cleanShortcuts(list) {
  const out = [];
  for (const one of Array.isArray(list) ? list : []) {
    if (!one || typeof one !== "object" || !keyKnown(one.k)) continue;
    const m = modsOf(one.m), name = [...(typeof one.name === "string" ? one.name.trim() : "")].slice(0, 16).join("");
    out.push({ name: name || comboSign(one.k, m), k: one.k, m });
    if (out.length === 24) break;
  }
  return out;
}

/** A configuration belongs to this socket; only its latest acknowledgement may restore input. */
function createScreenSession(initial, effects) {
  let desired = { active: true, display: 0, width: "1920" }, hidden = false;
  let capabilities = null, opened = false, closed = false, scheduled = false;
  let requestId = 0, pending = null, sentKey = "", error = "", inputReady = true, generation;
  const clean = (next) => {
    const out = {};
    if (!next || typeof next !== "object") return out;
    if (typeof next.active === "boolean") out.active = next.active;
    if (Number.isSafeInteger(next.display) && next.display >= 0) out.display = next.display;
    if (next.width === "native") out.width = "native";
    else if ((typeof next.width === "string" || typeof next.width === "number") && Number.isInteger(Number(next.width)) && Number(next.width) >= 640 && Number(next.width) <= 3840) out.width = String(Number(next.width));
    if ([30, 60, 120].includes(next.maxFps)) out.maxFps = next.maxFps;
    return out;
  };
  desired = Object.assign(desired, clean(initial));
  const original = { ...desired };
  const state = () => ({ display: desired.display, width: desired.width, ...(desired.maxFps ? { maxFps: desired.maxFps } : {}), paused: !desired.active || hidden });
  const key = () => JSON.stringify(state());
  // A lower frame-rate ceiling (a 60 Hz phone, Low Power) needs no new connection from an app that can't
  // reconfigure: the receiver just shows fewer frames. Reloading for it left the native picture "adjusting".
  const targetChanged = () => ["display", "width"].some((name) => desired[name] !== original[name]);
  const changed = () => effects.changed?.({ ...desired, paused: state().paused, inputReady, error });
  const suspend = () => { effects.release(); inputReady = false; };
  const pump = () => {
    scheduled = false;
    if (closed || !opened || !capabilities) return;
    const next = state(), nextKey = key();
    if (capabilities.configure) {
      if (nextKey === sentKey) return;
      suspend();
      sentKey = nextKey;
      pending = { requestId: ++requestId, key: nextKey, ...next };
      effects.send({ t: "screen.configure", requestId, ...next });
    } else {
      if (targetChanged() && !next.paused) {
        if (nextKey !== sentKey) effects.reload({ display: desired.display, width: desired.width, maxFps: desired.maxFps });
        inputReady = false;
      } else inputReady = !next.paused;
      sentKey = nextKey;
    }
    changed();
  };
  const schedule = () => {
    if (!scheduled && !closed) { scheduled = true; effects.defer(pump); }
  };
  return {
    desired: () => ({ ...desired }),
    active: () => !closed && !state().paused,
    canInput: () => !closed && !state().paused && inputReady,
    generation: () => generation,
    supported: () => capabilities?.configure === true,
    known: () => capabilities !== null,
    open() {
      if (closed) return;
      opened = true;
      if (state().paused) { suspend(); effects.send({ t: "hidden" }); }
      schedule();
    },
    update(next) {
      if (closed) return;
      const before = key();
      desired = Object.assign({}, desired, clean(next));
      if (key() === before && !error) return;
      suspend();
      // A pause can reach the native receiver before this microtask runs. Even a
      // quick return to the same target needs a fresh apply and input generation.
      pending = null;
      sentKey = "";
      error = "";
      if (!capabilities?.configure && opened && state().paused !== JSON.parse(before).paused) effects.send({ t: state().paused ? "hidden" : "shown" });
      changed();
      schedule();
    },
    visibility(nextHidden) {
      if (closed || hidden === nextHidden) return;
      hidden = nextHidden;
      suspend();
      pending = null;
      sentKey = "";
      error = "";
      if (!capabilities?.configure && opened) effects.send({ t: state().paused ? "hidden" : "shown" });
      changed();
      schedule();
    },
    receive(message) {
      if (closed || !message || typeof message !== "object") return;
      if (message.t === "capabilities") {
        capabilities = { ...message, configure: message.version === 1 && message.configure === true, pause: message.version === 1 && message.pause === true };
        sentKey = "";
        pending = null;
        if (capabilities.configure || state().paused || targetChanged()) suspend();
        else inputReady = true;
        effects.report(capabilities);
        changed();
        schedule();
        return;
      }
      if (!pending || message.requestId !== pending.requestId || pending.key !== key()) return;
      if (message.t !== "configured" && message.t !== "error") return;
      if (message.t === "configured" && (message.display !== pending.display || message.paused !== pending.paused || !Number.isSafeInteger(message.generation) || message.generation < 0)) return;
      inputReady = message.t === "configured" && !message.paused;
      if (message.t === "configured") generation = message.generation;
      error = message.t === "error" ? message.message || "屏幕配置失败，请重试" : "";
      pending = null;
      if (error) sentKey = "";
      effects.report(message);
      changed();
    },
    close() {
      if (closed) return;
      suspend();
      closed = true;
      pending = null;
      changed();
    },
    reconnect() {
      if (closed) return;
      suspend();
      capabilities = pending = null;
      generation = undefined;
      sentKey = "";
      error = "";
      changed();
    },
  };
}
`;
