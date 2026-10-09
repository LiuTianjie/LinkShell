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
// Beside the gestures: a sheet of the computer's shortcuts, one tap each (and the user's own), and a
// box to write text in as on any phone, sent to the computer when it is ready.
// With a mouse (a desktop browser) the pointer, buttons, wheel and keys go straight through.
//
// The picture comes one of two ways (docs/v2/screen-realtime.md). Where the computer's app and this
// device can reach each other, it is a video track from the app, with the hands and the pointer on
// data channels beside it; the page draws the pointer, which that picture does not have in it.
// Otherwise it is H.264 down the page's socket, decoded here onto a canvas, as it always was.

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
  quick: icon('<path d="M13 2.8 5.2 13.6H11l-1 7.6 7.8-10.8H12Z"/>'),
  compose: icon('<path d="M4 5h16v10.5H9.5L5.5 19v-3.5H4Z"/><path d="M8 9h8M8 12h5"/>'),
  info: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v6M12 7.2v.6"/>'),
  close: icon('<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'),
};

const STYLE = String.raw`
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  html, body { margin: 0; height: 100%; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; background: #000; overflow: hidden; overscroll-behavior: none; }
  body { position: fixed; inset: 0; color: #fff; font: 15px/1.45 -apple-system, system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif; }
  #stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; }
  #picture { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
  #stage.presenting #pointer { opacity: 0 !important; }
  canvas, video { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  video { object-fit: fill; pointer-events: none; }
  #pointer { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%; pointer-events: none;
    border: 2px solid rgba(255,255,255,0.95); box-shadow: 0 0 0 1px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.35);
    opacity: 0; transition: opacity 0.3s; will-change: transform; }
  #pointer.on { opacity: 1; transition: none; }
  #pointer.pressed { background: rgba(255,255,255,0.4); }
  #pointer.own { border: 0; border-radius: 0; box-shadow: none; background: transparent center / 100% 100% no-repeat; }
  #stage.own { cursor: none; }
  #note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 32px;
    color: rgba(255,255,255,0.72); text-align: center; pointer-events: none; }
  .glass { background: rgba(38,38,42,0.74); -webkit-backdrop-filter: blur(22px) saturate(1.6); backdrop-filter: blur(22px) saturate(1.6);
    border: 0.5px solid rgba(255,255,255,0.16); box-shadow: 0 8px 28px rgba(0,0,0,0.38); }
  #control-shell { position: absolute; pointer-events: none; z-index: 1; will-change: width, height, transform, border-radius, opacity; }
  #bar { position: absolute; z-index: 2; width: max-content; height: max-content; display: flex; gap: 2px; padding: 4px; border-radius: 26px; overflow: auto; scrollbar-width: none; touch-action: pan-x pan-y; }
  #bar.side { flex-direction: column; }
  #orb { position: absolute; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; touch-action: none; z-index: 3; }
  .orb-core { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; }
  .orb-core svg { width: 18px; height: 18px; }
  .gone { display: none !important; }
  .tool { flex: none; width: 44px; height: 44px; border-radius: 22px; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.92); }
  .tool.on { background: #fff; color: #111; }
  .tool:active { background: rgba(255,255,255,0.18); }
  .tool.on:active { background: rgba(255,255,255,0.82); }
  #menu, #connection { position: absolute; z-index: 6; width: 248px; padding: 6px; border-radius: 20px; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; }
  #menu.horizontal { display: flex; gap: 4px; width: 468px; }
  #menu.horizontal .choice { flex: 1; min-width: 0; gap: 8px; padding: 9px 8px; }
  #menu.horizontal .choice span { font-size: calc(11px * var(--text-scale, 1)); white-space: nowrap; }
  .choice { display: flex; align-items: center; min-height: 52px; gap: 10px; padding: 8px 10px; border-radius: 12px; transition: background-color 160ms ease-out; }
  .choice i { display: flex; flex: none; }
  .choice i svg { width: 20px; height: 20px; }
  #connectionhead { display: flex; align-items: center; padding-left: 10px; font-size: calc(13px * var(--text-scale, 1)); color: rgba(255,255,255,0.7); }
  #connectionhead span { flex: 1; }
  .choice:active { background: rgba(255,255,255,0.12); }
  .choice.on { background: rgba(255,255,255,0.16); }
  .choice b { display: block; font-weight: 600; font-size: calc(15px * var(--text-scale, 1)); }
  .choice span { display: block; font-size: calc(12.5px * var(--text-scale, 1)); color: rgba(255,255,255,0.62); }
  #widths { padding: 0 6px 6px; }
  #widths .group { padding-top: 4px; }
  #status { padding: 2px 10px 10px; font-size: calc(12px * var(--text-scale, 1)); line-height: 1.5;
    color: rgba(255,255,255,0.5); white-space: pre-line; font-variant-numeric: tabular-nums; }
  #toast { position: absolute; left: 50%; max-width: min(86vw, 420px); width: max-content; transform: translateX(-50%); padding: 10px 16px; border-radius: 18px;
    font-size: calc(13.5px * var(--text-scale, 1)); text-align: center; color: rgba(255,255,255,0.94); pointer-events: none; opacity: 0; transition: opacity 0.3s; }
  #toast.on { opacity: 1; }
  #keys { position: absolute; z-index: 4; left: 0; right: 0; height: 56px; display: flex; align-items: center; gap: 4px; padding: 0 5px; overflow-x: auto; overscroll-behavior: contain; touch-action: pan-x;
    background: rgba(28,28,30,0.96); border-top: 0.5px solid rgba(255,255,255,0.14); }
  .key { flex: 1 0 44px; min-width: 44px; height: calc(44px * var(--text-scale, 1)); border-radius: 8px; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.13); color: #fff; font-size: calc(15px * var(--text-scale, 1)); font-variant-numeric: tabular-nums; }
  .key.word { font-size: calc(12.5px * var(--text-scale, 1)); }
  .key svg { width: 20px; height: 20px; }
  .key:active { background: rgba(255,255,255,0.3); }
  .key.on { background: #fff; color: #111; }
  #sheet { position: absolute; z-index: 4; display: flex; flex-direction: column; border-radius: 24px; overflow: hidden; }
  #sheethead { display: flex; align-items: center; gap: 2px; padding: 8px 6px 4px 10px; }
  #compose { flex: 1; min-width: 0; min-height: 44px; margin-right: 4px; border-radius: 20px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
    background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.62); font-size: calc(14.5px * var(--text-scale, 1)); white-space: nowrap; }
  #compose:active { background: rgba(255,255,255,0.2); }
  #compose svg { width: 19px; height: 19px; flex: none; }
  #actions, #maker { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; padding: 0 10px 12px; }
  .group { display: flex; align-items: center; justify-content: space-between; padding: 12px 4px 7px; font-size: calc(12.5px * var(--text-scale, 1)); color: rgba(255,255,255,0.55); }
  .group i { display: inline-flex; align-items: center; min-width: 44px; min-height: 44px; font-style: normal; padding: 4px 8px; margin: -4px -4px -4px 0; border-radius: 10px; color: rgba(255,255,255,0.86); }
  .group i:active { background: rgba(255,255,255,0.16); }
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .tiles.six { grid-template-columns: repeat(auto-fit, minmax(calc(44px * var(--text-scale, 1)), 1fr)); margin-bottom: 6px; }
  #sheet.narrow .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  #sheet.folded .tiles:not(.six) { grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); }
  #sheet.narrow .tiles.six { grid-template-columns: repeat(auto-fit, minmax(calc(44px * var(--text-scale, 1)), 1fr)); }
  .tile { position: relative; min-height: 52px; padding: 6px 3px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.1); text-align: center; }
  .tile b { max-width: 100%; overflow: hidden; white-space: normal; overflow-wrap: anywhere; font-weight: 500; font-size: calc(13.5px * var(--text-scale, 1)); line-height: 1.3; }
  .tile span { font-size: calc(11.5px * var(--text-scale, 1)); line-height: 1.3; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; }
  .tiles.six .tile { min-height: 44px; }
  .tile:active, .tile.hit { background: rgba(255,255,255,0.3); }
  .tile.on { background: #fff; color: #111; }
  .tile.on span { color: rgba(0,0,0,0.55); }
  .tile.sure, .tile.sure:active { background: #d9392f; }
  .tile.sure span { color: rgba(255,255,255,0.86); }
  .tile.add { background: transparent; border: 1px dashed rgba(255,255,255,0.3); color: rgba(255,255,255,0.78); }
  .tile.loose::after { content: "×"; position: absolute; top: -5px; right: -4px; width: 19px; height: 19px; border-radius: 10px; background: #d9392f;
    font-size: calc(14px * var(--text-scale, 1)); line-height: 18px; text-align: center; }
  .field { display: flex; align-items: center; gap: 12px; height: 46px; margin-top: 6px; padding: 0 12px; border-radius: 12px; background: rgba(255,255,255,0.1); }
  .field span { flex: none; font-size: calc(14px * var(--text-scale, 1)); color: rgba(255,255,255,0.62); }
  .field select, .field input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; border-radius: 0; background: transparent; color: #fff;
    font: inherit; font-size: calc(16px * var(--text-scale, 1)); text-align: right; text-align-last: right; -webkit-appearance: none; appearance: none; -webkit-user-select: text; user-select: text; }
  .field input::placeholder { color: rgba(255,255,255,0.36); }
  .ends { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .soft { flex: none; min-height: 44px; padding: 0 13px; border-radius: 19px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.13);
    font-size: calc(14px * var(--text-scale, 1)); white-space: nowrap; }
  .soft:active { background: rgba(255,255,255,0.3); }
  .soft.strong { padding: 0 17px; background: #fff; color: #111; font-weight: 600; }
  .soft.strong:active { background: rgba(255,255,255,0.82); }
  .soft svg { width: 20px; height: 20px; }
  .spring { flex: 1; }
  #composer { position: absolute; z-index: 4; left: 0; right: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 8px; background: rgba(28,28,30,0.96); border-top: 0.5px solid rgba(255,255,255,0.14); }
  #composer.wide { flex-direction: row; align-items: flex-end; }
  #wordsbox { position: relative; flex: none; }
  #composer.wide #wordsbox { flex: 1; min-width: 0; }
  #words { display: block; width: 100%; height: 66px; margin: 0; padding: 9px 12px; border: 0; outline: 0; resize: none; border-radius: 12px; background: rgba(255,255,255,0.12);
    color: #fff; font: inherit; font-size: calc(16px * var(--text-scale, 1)); line-height: 1.4; -webkit-user-select: text; user-select: text; }
  #composer.wide #words { height: 44px; }
  #wordshint { position: absolute; left: 12px; right: 12px; top: 9px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: calc(16px * var(--text-scale, 1)); line-height: 1.4;
    color: rgba(255,255,255,0.36); pointer-events: none; }
  #sendrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  #typing, #shortcut { position: absolute; left: 0; top: 0; width: 2px; height: 2px; padding: 0; border: 0; outline: 0; resize: none; opacity: 0;
    background: transparent; color: transparent; caret-color: transparent; font-size: calc(16px * var(--text-scale, 1)); -webkit-user-select: text; user-select: text; }
`;

/**
 * The parts of the page's script that only work things out, with nothing of the page in them:
 * exported so that they can be tried without a browser.
 */
export const VIEWER_LOGIC = String.raw`
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
`;

const BODY = String.raw`
const $ = (id) => document.getElementById(id);
const stage = $("stage"), picture = $("picture"), canvas = $("screen"), ctx = canvas.getContext("2d"), video = $("video"), pointer = $("pointer");
const note = $("note"), bar = $("bar"), controlShell = $("control-shell"), orb = $("orb"), menu = $("menu"), connection = $("connection"), toast = $("toast"), keys = $("keys"), typing = $("typing"), shortcut = $("shortcut");
const sheet = $("sheet"), actions = $("actions"), maker = $("maker"), naming = $("makername"), composer = $("composer"), words = $("words");
const query = new URLSearchParams(location.search);
const app = window.ReactNativeWebView;
const tellApp = (message) => { if (app) app.postMessage(JSON.stringify(message)); };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const coarse = matchMedia("(pointer: coarse)").matches;
const android = /Android/i.test(navigator.userAgent);

const MODES = ["view", "trackpad", "touch"];
const HINTS = {
  view: "只看：双指缩放，单指移动画面",
  trackpad: "触控板：滑动指针 · 轻点点击 · 双指轻点右键 · 双指滑动滚动 · 轻点两下并按住拖拽",
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
let keysOpen = false, sheetOpen = false, composerOpen = false;
const mods = new Set();

// ---- The picture ----------------------------------------------------------

const say = (text) => { note.textContent = text; note.classList.toggle("gone", !text); };
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
const wantVideo = "RTCPeerConnection" in window && (!app || chrome.video === true || query.get("video") === "1") && query.get("video") !== "0";
// The iOS app owns the final transport fallback, so it can bypass a failed direct data channel.
const relayFallback = !!app && (chrome.relayFallback === true || query.get("fallback") === "relay") && query.get("video") !== "0";
const unseeable = () => say("这个系统版本的浏览器内核不支持视频解码，请升级系统后再试。");
if (!wantVideo && !("VideoDecoder" in window)) unseeable();
let decoder, skipping = false, skipped = 0, arrived = 0, keyAsked = -Infinity;
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
  if (!telling) telling = setTimeout(() => { telling = 0; send({ t: "ack", n: lastShown }); }, 40);
}
let lighterAt = -Infinity, failures = 0;
const asked = new URLSearchParams(location.search);
asked.delete("video");
if (wantVideo) asked.set("video", "1");
// How wide the video track may be (the socket's picture has its own ladder). The app says it in the address;
// a plain browser remembers its own. A new choice loads the page again with it: the track is offered anew.
const WIDTHS = ["1280", "1920", "2560", "native"];
let keptWidth = null;
try { keptWidth = localStorage.getItem("linkshell.screen.width"); } catch {}
const width = WIDTHS.includes(query.get("width")) ? query.get("width") : WIDTHS.includes(keptWidth) ? keptWidth : "1920";
asked.set("width", width);
// A page that is a srcdoc (the gateway's web client puts it in one) has no address of its own to load again:
// it asks the page around it to, where that page says it can, and offers no choice where it can't.
const framed = document.URL === "about:srcdoc";
const reloadVia = framed && typeof window.__linkshellReload === "function" ? window.__linkshellReload : null;
const canChooseWidth = !framed || !!reloadVia;
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/stream?" + asked);
ws.binaryType = "arraybuffer";
const send = (message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
ws.onopen = () => { if (mode !== "view") askControl(); if (document.hidden) send({ t: "hidden" }); };
// Out of sight, a page answers late (its timers slow to one a second) and shows nothing: the host sends no
// picture down the socket meanwhile, and starts again at a keyframe.
document.addEventListener("visibilitychange", () => send({ t: document.hidden ? "hidden" : "shown" }));
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
  // A video track is this socket's: without the one there is no finding the other again, and no hands.
  drop();
  if (requestRelay()) return;
  if (blocked || note.classList.contains("gone") || note.textContent.startsWith("正在")) say("屏幕连接已断开");
  blocked = false;
};

function heard(message) {
  if (message.error) return say(message.error);
  if (message.rtc) return signal(message.rtc);
  if (message.pong) return meter && meter.pong(message.pong);
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
  if (message.cursor) echo(message.cursor.x, message.cursor.y);
}

// ---- The picture as a video track -----------------------------------------

// The computer's app offers the track, and channels beside it for the hands and the pointer; this end only
// answers. The socket carries what the two need to find each other — and the picture itself once the host
// says so (rtc "off"): there is no app to send a track, or this end said the track didn't get across.
// rtc is the connection while there is one; live, that the picture on show is the track's. A socket that
// has given the track up does not try again.
let rtc = null, live = false, tried = false, gaveUp = false, blocked = false, patience = 0, relayRequested = false;
// For trying the way back out: ?failAfter=5 gives the track up 5 s after it was offered.
const failAfter = Number(query.get("failAfter")) || 0;

function signal(message) {
  if (message.t === "off") return fallBack();
  if (gaveUp) return;
  if (message.t === "config") return connect(message.iceServers || []);
  const mine = rtc;
  if (!mine) return;
  if (message.t === "offer") {
    tried = true;
    patience = setTimeout(() => giveUp("not connected within 8 s of the offer"), 8000);
    if (failAfter) setTimeout(() => { if (rtc === mine) giveUp("asked to (failAfter)"); }, failAfter * 1000);
    // The answer is the browser's own, as it made it: the sender's playout-delay header has to survive in it.
    mine.described = mine.pc.setRemoteDescription({ type: "offer", sdp: message.sdp })
      .then(() => mine.pc.createAnswer())
      .then((answer) => mine.pc.setLocalDescription(answer))
      .then(() => { if (rtc === mine) send({ t: "rtc.answer", sdp: mine.pc.localDescription.sdp }); });
    mine.described.catch((error) => { if (rtc === mine) giveUp("the offer could not be answered: " + error.message); });
  } else if (message.t === "ice") {
    // A candidate that comes before the offer is in place waits for it.
    mine.described.then(() => mine.pc.addIceCandidate({ candidate: message.candidate, sdpMid: message.sdpMid, sdpMLineIndex: message.sdpMLineIndex })).catch(() => {});
  }
}

function connect(iceServers) {
  drop();
  let pc;
  try { pc = new RTCPeerConnection({ iceServers }); }
  catch (error) { return giveUp("the receiver could not start: " + error.message); }
  const mine = (rtc = { pc, channels: {}, described: Promise.resolve(), up: false, away: 0 });
  pc.onicecandidate = ({ candidate }) => {
    // The empty one only says there are no more.
    if (candidate && candidate.candidate) send({ t: "rtc.ice", candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null });
  };
  pc.ontrack = ({ receiver, track, streams }) => {
    // No waiting beyond what decoding takes. Safari has neither knob: there the sender's playout-delay header does it.
    if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
    if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0;
    video.srcObject = streams[0] || new MediaStream([track]);
    play();
  };
  pc.ondatachannel = ({ channel }) => {
    mine.channels[channel.label] = channel;
    if (channel.label === "cursor" || channel.label === "shape") channel.onmessage = (event) => { if (rtc === mine) told(JSON.parse(event.data)); };
  };
  pc.oniceconnectionstatechange = pc.onconnectionstatechange = () => { if (rtc === mine) watch(mine); };
}

function watch(mine) {
  // The whole connection's state where the browser has one: a path found is not yet a connection made.
  const state = mine.pc.connectionState || mine.pc.iceConnectionState;
  if (state === "failed" || mine.pc.iceConnectionState === "failed") return giveUp(mine.up ? "the connection failed" : "no path between the two (ICE failed)");
  if (state === "disconnected") {
    // A path that drops for a moment comes back by itself; one gone for longer is given up.
    if (mine.up && !mine.away) mine.away = setTimeout(() => away(mine, performance.now()), 4000);
  } else if (state === "connected" || state === "completed") {
    clearTimeout(mine.away);
    mine.away = 0;
    if (mine.up) return;
    mine.up = true;
    clearTimeout(patience);
    if (!live) patience = setTimeout(frameless, 4000);
  }
}

function away(mine, since) {
  // A page that was put aside (another app, another tab) could not hear the path come back: once it is
  // looked at again it is given the time again.
  const now = performance.now();
  if (document.hidden || now - since > 6000) mine.away = setTimeout(() => away(mine, now), 4000);
  else giveUp("disconnected for more than 4 s");
}

function frameless() {
  // A page nobody is looking at is shown nothing, and one waiting for a tap has not begun: neither is the path's doing.
  if (document.hidden || blocked) patience = setTimeout(frameless, 4000);
  else giveUp("connected, but no frame within 4 s");
}

/** The track is not getting across: the host is asked for the picture down the socket instead. */
function giveUp(reason) {
  if (gaveUp) return;
  gaveUp = true;
  drop();
  if (!requestRelay()) send({ t: "rtc.failed", reason });
}

function requestRelay() {
  if (!relayFallback) return false;
  if (!relayRequested) {
    relayRequested = true;
    tellApp({ type: "screenFallback" });
    say("正在连接电脑屏幕…");
  }
  return true;
}

function drop() {
  clearTimeout(patience);
  if (!rtc) return;
  clearTimeout(rtc.away);
  const pc = rtc.pc;
  rtc = null;
  pc.ontrack = pc.ondatachannel = pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
  pc.close();
}

/** The picture comes down the socket from here on. What the track last showed stays up until its first frame. */
function fallBack() {
  gaveUp = true;
  drop();
  if (requestRelay()) return;
  if (blocked) say("正在连接电脑屏幕…");
  blocked = false;
  if (!("VideoDecoder" in window)) return unseeable();
  if (tried) hint(live ? "直连断开了：已改用兼容方式传画面，延迟会高一些" : "没能和电脑直连：已改用兼容方式传画面，延迟会高一些", 5000);
}

if (!wantVideo) requestRelay();

function play() {
  const started = video.play();
  if (!started) return;
  started.then(() => {
    if (!blocked) return;
    blocked = false;
    say(live ? "" : "正在连接电脑屏幕…");
  }, (error) => {
    // A new stream replacing the one being started rejects the first call too; that is not a refusal.
    if (error.name === "AbortError" || !rtc) return;
    blocked = true;
    say("轻点屏幕，开始显示画面");
  });
}
// What a browser takes as someone's say-so to start a video.
if (wantVideo) for (const name of ["pointerup", "touchend", "click", "keydown"]) addEventListener(name, () => { if (blocked && rtc) play(); }, true);

/** The track's picture has a size: at its first frame, and whenever the sender changes its resolution. */
function sized() {
  if (!rtc || !video.videoWidth) return;
  content.w = video.videoWidth;
  content.h = video.videoHeight;
  if (!blocked) say("");
  if (live) return layout();
  clearTimeout(patience);
  show(true);
}
video.addEventListener("resize", sized);
video.addEventListener("loadedmetadata", sized);

/** Which of the two the picture is on: the video while its track runs, the canvas otherwise. */
function show(track) {
  live = track;
  video.classList.toggle("gone", !track);
  canvas.classList.toggle("gone", track);
  if (!track) {
    video.srcObject = null;
    content.w = content.h = 0;
    pointer.classList.remove("on");
  }
  refresh();
}

// ---- The pointer in a video ----------------------------------------------

// A video track has no pointer in its picture. The app says where the pointer is (every position, on
// "cursor") and what it looks like ("shape": the picture the first time, its id after that), and the page
// draws it — an arrow of its own until it has been told.
const ARROW = { w: 14.5, h: 20, hotX: 1.5, hotY: 1.5, url: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14.5 20'><path d='M1.5 1.5v15l4-3.4 2.6 5.4 2.5-1.2-2.6-5.3 5-.6Z' fill='#000' stroke='#fff' stroke-width='1.3' stroke-linejoin='round'/></svg>") };
const shapes = new Map();
// worn: the shape's id. span: the display's width in the points the shapes are measured in.
// pointed: the pointer has been somewhere to draw it at (it may be on another display, and never be).
let worn = "", span = 0, drawn = 0, pointed = false;

function told(message) {
  if (message.t === "cursor") {
    // The channel keeps no order: a position older than the one drawn is not drawn after it.
    if (message.i <= drawn) return;
    if (message.i) drawn = message.i;
    return echo(message.x, message.y);
  }
  if (message.t !== "shape") return;
  if (message.png) shapes.set(message.id, { url: "data:image/png;base64," + message.png, w: message.w, h: message.h, hotX: message.hotX, hotY: message.hotY });
  if (message.displayW) span = message.displayW;
  worn = message.id;
  dress();
}

/** The computer says where its pointer is. */
function echo(x, y) {
  if (live) {
    // Every position comes back, this page's own moves among them, a round trip late; and the hand here is
    // ahead of that. So what is drawn stays where the hand has it while the hand is moving it, and for any
    // position the hand put it at within the last second. Anything else is news — someone at the computer,
    // a program — and is drawn at once.
    const now = performance.now();
    if (now - movedAt < 250 || ownEcho(trail, x, y, now)) return;
  }
  // In the socket's picture the pointer is drawn already. It moved by itself: the next swipe starts from where it is now.
  else if (gesture) return;
  cursor.x = x;
  cursor.y = y;
  if (rtc && !pointed) point();
  else place();
}

/** The pointer is somewhere, for the first time. */
function point() {
  pointed = true;
  dress();
}

/** What the pointer looks like: the computer's own over a video; otherwise the ring that follows a finger on the trackpad. */
function dress() {
  const look = live ? shapes.get(worn) || ARROW : null, style = pointer.style;
  pointer.classList.toggle("own", !!look);
  if (look) pointer.classList.toggle("on", pointed);
  // A mouse here would be a second pointer on top of the one drawn: while it controls, the drawn one is it.
  stage.classList.toggle("own", !!look && controlling());
  style.width = look ? look.w + "px" : "";
  style.height = look ? look.h + "px" : "";
  style.left = look ? -look.hotX + "px" : "";
  style.top = look ? -look.hotY + "px" : "";
  style.transformOrigin = look ? look.hotX + "px " + look.hotY + "px" : "";
  style.backgroundImage = look ? 'url("' + look.url + '")' : "";
  place();
}

// ---- Layout ---------------------------------------------------------------

function viewport() {
  const v = window.visualViewport;
  return v ? { w: v.width, h: v.height, x: v.offsetLeft, y: v.offsetTop } : { w: innerWidth, h: innerHeight, x: 0, y: 0 };
}

// What a browser's window has been seen to do: a keyboard coming up makes it shorter, on a phone (see keyboardIsUp).
const seen = { w: 0, h: 0, follows: false };

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let sheetTransition = null, sheetDock = "bottom";
const presentation = { active: false, target: null, geometry: "", current: null, velocity: { x: 0, y: 0, w: 0, h: 0 }, destination: null, waiting: false, frame: 0, time: null, timer: 0 };
function visiblePicture() {
  if (!content.w) return null;
  const rect = (live ? video : canvas).getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}
function finishPresentation() {
  clearTimeout(presentation.timer);
  cancelAnimationFrame(presentation.frame);
  picture.style.transform = "";
  sheetTransition = null;
  sheet.style.transform = sheet.style.opacity = sheet.style.pointerEvents = "";
  sheet.classList.toggle("gone", !sheetOpen);
  presentation.frame = 0;
  presentation.current = null;
  presentation.time = null;
  presentation.active = false;
  stage.classList.remove("presenting");
  armControlsIdle();
}
function drawPresentation() {
  if (sheetTransition) {
    const panel = sheetPresentation(sheetTransition.progress, sheet.offsetWidth, sheet.offsetHeight, sheetDock);
    sheet.style.transform = "translate(" + panel.x + "px," + panel.y + "px)";
    sheet.style.opacity = String(panel.opacity);
    sheet.style.pointerEvents = sheetTransition.target ? "auto" : "none";
  }
  if (!content.w) return;
  const flip = presentationFlip(presentation.current, shown, reducedMotion.matches);
  if (!flip) return finishPresentation();
  picture.style.transform = "translate(" + flip.x + "px," + flip.y + "px) scale(" + flip.sx + "," + flip.sy + ")";
}
function stepPresentation(time) {
  presentation.frame = 0;
  if (!presentation.active) return;
  if (presentation.time === null) presentation.time = time;
  const seconds = (time - presentation.time) / 1000;
  const next = presentationSpring(presentation.current, presentation.velocity, presentation.destination, seconds);
  let sheetSettled = true;
  if (sheetTransition) {
    const panel = presentationSpring({ x: sheetTransition.progress, y: 0, w: 1, h: 1 }, { x: sheetTransition.velocity, y: 0, w: 0, h: 0 }, { x: sheetTransition.target, y: 0, w: 1, h: 1 }, seconds);
    sheetTransition.progress = panel.current.x;
    sheetTransition.velocity = panel.velocity.x;
    sheetSettled = Math.abs(panel.current.x - sheetTransition.target) < 0.001 && Math.abs(panel.velocity.x) < 0.01;
  }
  presentation.time = time;
  presentation.current = next.current;
  presentation.velocity = next.velocity;
  drawPresentation();
  if (!presentation.active) return;
  if (next.settled && sheetSettled && !presentation.waiting) return finishPresentation();
  presentation.frame = requestAnimationFrame(stepPresentation);
}
function beginPresentation(full) {
  if ((presentation.active && presentation.target === "fullscreen:" + full) || (!presentation.active && full === (app ? chrome.fullscreen : !!document.fullscreenElement))) return;
  beginLayoutTransition("fullscreen:" + full);
}
function beginLayoutTransition(target) {
  if (reducedMotion.matches) return finishPresentation();
  // A held mouse button must be released before the displayed coordinate system moves.
  wake();
  closeMenu();
  endOne();
  if (mouseHeld && mouseHeld !== "pan") act({ t: "up", b: mouseHeld });
  mouseHeld = null;
  gesture = null;
  touches.clear();
  lastTap = null;
  if (!presentation.active) {
    presentation.current = visiblePicture() || { ...shown };
    presentation.velocity = { x: 0, y: 0, w: 0, h: 0 };
    presentation.destination = { ...shown };
    presentation.time = null;
  }
  presentation.active = true;
  presentation.target = target;
  presentation.waiting = !sheetTransition;
  presentation.geometry = JSON.stringify(shown);
  stage.classList.add("presenting");
  if (!presentation.frame) presentation.frame = requestAnimationFrame(stepPresentation);
  clearTimeout(presentation.timer);
  presentation.timer = setTimeout(finishPresentation, 350);
}
function beginSheetTransition(open) {
  if (!reducedMotion.matches) {
    sheetTransition = sheetTransition ? { ...sheetTransition, target: open ? 1 : 0 } : { progress: open ? 0 : 1, velocity: 0, target: open ? 1 : 0 };
  }
  beginLayoutTransition("shortcuts:" + open);
}
function animatePresentation() {
  if (!presentation.active) return;
  const geometry = JSON.stringify(shown);
  if (geometry !== presentation.geometry) {
    presentation.geometry = geometry;
    presentation.destination = { ...shown };
    presentation.waiting = false;
    clearTimeout(presentation.timer);
    presentation.timer = setTimeout(finishPresentation, 800);
  }
  // Layout may change while the status bar moves. Rebase the same live spring without resetting it.
  drawPresentation();
  if (presentation.active && !presentation.frame) presentation.frame = requestAnimationFrame(stepPresentation);
}
reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) finishPresentation(); });
window.linkshellPresent = beginPresentation;
document.addEventListener("visibilitychange", () => { if (document.hidden) finishPresentation(); });

// Scalar springs drive controls without touching the live video or remote pointer coordinates.
const controlSprings = new Map(), popoverMotions = new Map(), pressedControls = new Set();
let controlFrame = 0;
const controlsVisibility = {};
const controls = { value: 1, target: 1, visibility: 1, visibilityTarget: 1, timer: 0, point: null, preferred: null, safe: null, anchor: null, orb: null, drag: null };
function advanceControls(time) {
  controlFrame = 0;
  for (const [key, motion] of [...controlSprings]) {
    if (motion.time === null) motion.time = time;
    // A changing glass silhouette needs more time to read than a button press.
    const frequency = key === controls ? 17 : key === menu || key === connection ? 22 : 32;
    const next = presentationSpring({ x: motion.value, y: 0, w: 1, h: 1 }, { x: motion.velocity, y: 0, w: 0, h: 0 }, { x: motion.target, y: 0, w: 1, h: 1 }, (time - motion.time) / 1000, frequency);
    motion.time = time;
    motion.value = next.current.x;
    motion.velocity = next.velocity.x;
    motion.render(motion.value);
    if (Math.abs(motion.value - motion.target) < 0.001 && Math.abs(motion.velocity) < 0.01) {
      controlSprings.delete(key);
      motion.render(motion.target);
      motion.done?.(motion.target);
    }
  }
  if (controlSprings.size) controlFrame = requestAnimationFrame(advanceControls);
}
function controlSpring(key, target, initial, render, done) {
  const motion = controlSprings.get(key) || { value: initial, velocity: 0, time: null };
  Object.assign(motion, { target, render, done });
  if (reducedMotion.matches) {
    controlSprings.delete(key);
    render(target);
    done?.(target);
    return;
  }
  controlSprings.set(key, motion);
  render(motion.value);
  if (!controlFrame) controlFrame = requestAnimationFrame(advanceControls);
}
function pressFeedback(element, down) {
  if (down) {
    pressedControls.add(element);
    const v = viewport(), rect = element.getBoundingClientRect();
    controls.preferred = { u: (rect.left + rect.width / 2 - v.x) / Math.max(1, v.w), v: (rect.top + rect.height / 2 - v.y) / Math.max(1, v.h) };
  } else pressedControls.delete(element);
  const pending = controlSprings.get(element);
  // Even a tap released before the first animation frame gets a visible press, without delaying its action.
  if (!down && !reducedMotion.matches && pending?.target === 0.92 && pending.value > 0.97) pending.velocity = Math.min(pending.velocity, -6);
  controlSpring(element, down ? 0.92 : 1, 1, (scale) => { element.style.scale = reducedMotion.matches || scale === 1 ? "" : String(scale); });
  if (down) clearTimeout(controls.timer); else armControlsIdle();
}
function popoverOpen(panel) {
  return popoverMotions.has(panel) ? popoverMotions.get(panel).target === 1 : !panel.classList.contains("gone");
}
function drawPopover(panel) {
  const motion = popoverMotions.get(panel);
  if (!motion) return;
  const trigger = $(panel === menu ? "mode" : "info").getBoundingClientRect();
  const x = parseFloat(panel.style.left) || 0, y = parseFloat(panel.style.top) || 0;
  const width = panel.offsetWidth, height = panel.offsetHeight;
  const ax = trigger.left + trigger.width / 2, ay = trigger.top + trigger.height / 2;
  const dx = ax - x - width / 2, dy = ay - y - height / 2, distance = Math.max(1, Math.hypot(dx, dy));
  const frame = popoverPresentation(motion.value, dx / distance * 10, dy / distance * 10);
  panel.style.transformOrigin = clamp(ax - x, 0, width) + "px " + clamp(ay - y, 0, height) + "px";
  panel.style.transform = "translate(" + frame.x + "px," + frame.y + "px) scale(" + frame.scale + ")";
  panel.style.opacity = String(frame.opacity);
}
function presentPopover(panel, open) {
  if (!open && panel.classList.contains("gone")) return;
  const existing = popoverMotions.get(panel);
  const motion = existing || { value: open ? 0 : 1, target: open ? 1 : 0 };
  motion.target = open ? 1 : 0;
  popoverMotions.set(panel, motion);
  panel.style.opacity = String(Math.max(0, Math.min(1, motion.value)));
  panel.style.pointerEvents = open ? "auto" : "none";
  panel.classList.remove("gone");
  // Measure at its final location before revealing it.
  layout();
  controlSpring(panel, motion.target, motion.value, (value) => { motion.value = value; drawPopover(panel); }, (target) => {
    if (target === 0) panel.classList.add("gone");
    panel.style.transform = panel.style.transformOrigin = panel.style.opacity = panel.style.pointerEvents = "";
    popoverMotions.delete(panel);
    armControlsIdle();
  });
}
function immersiveControls() { return app ? chrome.fullscreen : !!document.fullscreenElement; }
function controlsMayCollapse() {
  if (document.hidden) return false;
  return controlCanCollapse({ fullscreen: immersiveControls(), menu: !menu.classList.contains("gone") || !connection.classList.contains("gone"), sheet: sheetOpen || !!sheetTransition || composerOpen, keyboard: keysOpen || chrome.keyboard === true, pressed: pressedControls.size > 0 || !!controls.drag, presenting: presentation.active });
}
function renderControls(value) {
  controls.value = value;
  if (!controls.safe || !controls.anchor || !controls.orb) return;
  const visible = Math.max(0, Math.min(1, value)), anchor = controls.anchor, ball = controls.orb;
  const groupOpacity = Math.max(0, Math.min(1, controls.visibility));
  const hiddenByPanel = keysOpen || sheetOpen || composerOpen;
  const morph = controlsMorph(value, anchor, ball);
  controlShell.style.left = morph.x + "px";
  controlShell.style.top = morph.y + "px";
  controlShell.style.width = morph.w + "px";
  controlShell.style.height = morph.h + "px";
  controlShell.style.borderRadius = morph.radius + "px";
  controlShell.style.opacity = String(Math.max(morph.shellOpacity, controls.drag ? 0.7 : 0) * groupOpacity);
  bar.style.transformOrigin = "50% 50%";
  bar.style.transform = "translate(" + morph.dx + "px," + morph.dy + "px) scale(" + morph.contentScale + ")";
  bar.style.opacity = String(morph.barOpacity * groupOpacity);
  bar.style.pointerEvents = visible > 0.6 && !hiddenByPanel ? "auto" : "none";
  orb.style.left = ball.x + "px";
  orb.style.top = ball.y + "px";
  orb.style.opacity = String(morph.orbOpacity * (controls.drag ? 0.7 : 0.3) * groupOpacity);
  orb.style.transform = "scale(" + (1 - 0.2 * visible) + ")";
  orb.style.pointerEvents = immersiveControls() && visible < 0.5 && !hiddenByPanel ? "auto" : "none";
}

function expandControls(open) {
  const target = open ? 1 : 0;
  if (controls.target === target && (controlSprings.has(controls) || controls.value === target)) return;
  controls.target = target;
  controlSpring(controls, target, controls.value, renderControls);
}
function armControlsIdle() {
  clearTimeout(controls.timer);
  if (!controlsMayCollapse() || controls.target === 0) return;
  controls.timer = setTimeout(() => { if (controlsMayCollapse()) expandControls(false); }, 3000);
}
function layoutControls(safe, anchor) {
  if (controls.drag && controls.safe && ["x", "y", "w", "h"].some((key) => controls.safe[key] !== safe[key])) {
    const id = controls.drag.id;
    controls.drag = null;
    pressFeedback(orb, false);
    try { orb.releasePointerCapture(id); } catch {}
  }
  controls.safe = safe;
  const fullscreen = immersiveControls();
  const v = viewport();
  const ball = fullscreen && controls.point && controls.preferred
    ? containedBox(safe, 44, 44, v.x + controls.preferred.u * v.w - 22, v.y + controls.preferred.v * v.h - 22)
    : orbBounds(safe, anchor, fullscreen ? controls.point : null);
  if (fullscreen && controls.point) anchor = containedBox(safe, anchor.w, anchor.h, ball.x + 22 - anchor.w / 2, ball.y + 22 - anchor.h / 2);
  controls.anchor = anchor;
  controls.orb = ball;
  const visibility = keysOpen || sheetOpen || composerOpen ? 0 : 1;
  if (controls.visibilityTarget !== visibility) {
    controls.visibilityTarget = visibility;
    controlSpring(controlsVisibility, visibility, controls.visibility, (value) => { controls.visibility = value; renderControls(controls.value); });
  }
  if (!fullscreen || keysOpen || sheetOpen || composerOpen || !menu.classList.contains("gone") || !connection.classList.contains("gone")) expandControls(true);
  renderControls(controls.value);
  return anchor;
}
reducedMotion.addEventListener("change", () => {
  if (!reducedMotion.matches) return;
  for (const [key, motion] of [...controlSprings]) {
    controlSprings.delete(key);
    motion.render(motion.target);
    motion.done?.(motion.target);
  }
  cancelAnimationFrame(controlFrame);
  controlFrame = 0;
});
orb.addEventListener("pointerdown", (event) => {
  event.preventDefault(); event.stopPropagation();
  if (!controls.orb) return;
  try { orb.setPointerCapture(event.pointerId); } catch {}
  clearTimeout(controls.timer);
  controls.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...controls.orb }, moved: false };
  pressFeedback(orb, true);
  renderControls(controls.value);
});
orb.addEventListener("pointermove", (event) => {
  event.preventDefault(); event.stopPropagation();
  const drag = controls.drag;
  if (!drag || drag.id !== event.pointerId || !controls.safe) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 6) drag.moved = true;
  if (!drag.moved) return;
  const v = viewport();
  const preferred = { x: drag.origin.x + dx + 22, y: drag.origin.y + dy + 22 };
  const safe = interactionViewport(v, chrome.insets || { top: 0, right: 0, bottom: 0, left: 0 }, chrome.divisions, preferred);
  const point = containedBox(safe, 44, 44, preferred.x - 22, preferred.y - 22);
  controls.point = { u: (point.x - safe.x - 8) / Math.max(1, safe.w - 60), v: (point.y - safe.y - 8) / Math.max(1, safe.h - 60) };
  controls.preferred = { u: (point.x + 22 - v.x) / Math.max(1, v.w), v: (point.y + 22 - v.y) / Math.max(1, v.h) };
  controls.safe = safe;
  controls.orb = point;
  renderControls(controls.value);
});
function releaseOrb(event, cancelled) {
  event.preventDefault(); event.stopPropagation();
  const drag = controls.drag;
  if (!drag || drag.id !== event.pointerId) return;
  controls.drag = null;
  try { orb.releasePointerCapture(event.pointerId); } catch {}
  pressFeedback(orb, false);
  layout();
  if (!cancelled && !drag.moved) wake();
  else renderControls(controls.value);
}
orb.addEventListener("pointerup", (event) => releaseOrb(event, false));
orb.addEventListener("pointercancel", (event) => releaseOrb(event, true));
orb.addEventListener("lostpointercapture", (event) => releaseOrb(event, true));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    layout();
    armControlsIdle();
    return;
  }
  const captured = controls.drag?.id;
  controls.drag = null;
  if (captured !== undefined) { try { orb.releasePointerCapture(captured); } catch {} }
  for (const element of [...pressedControls]) pressFeedback(element, false);
  clearTimeout(controls.timer);
});
for (const name of ["touchstart", "touchend", "mousedown", "click"]) orb.addEventListener(name, (event) => { event.preventDefault(); event.stopPropagation(); }, { passive: false });

function layout() {
  const v = viewport(), inset = chrome.insets, screenSafe = usableViewport(v, inset);
  const preferred = controls.preferred ? { x: v.x + controls.preferred.u * v.w, y: v.y + controls.preferred.v * v.h } : null;
  const safe = interactionViewport(v, inset, chrome.divisions, preferred);
  const divided = safe.x !== screenSafe.x || safe.y !== screenSafe.y || safe.w !== screenSafe.w || safe.h !== screenSafe.h;
  const horizontalDivision = divided && safe.h < screenSafe.h;
  const controlInset = { top: safe.y - v.y, right: v.x + v.w - safe.x - safe.w, bottom: v.y + v.h - safe.y - safe.h, left: safe.x - v.x };
  // The app keeps its authored type sizes while window geometry remains adaptive.
  const fontScale = 1;
  document.documentElement.style.setProperty("--text-scale", String(fontScale));
  if (v.w !== seen.w) Object.assign(seen, { w: v.w, h: v.h });
  else if (v.h > seen.h) seen.h = v.h;
  if (seen.h - v.h > 120 && fieldFocused()) seen.follows = true;
  // A phone lying down has its room beside the picture, not under it.
  const wide = !horizontalDivision && (divided || safe.w > safe.h && safe.w >= 560);
  // Beside the picture, things take the side without the camera.
  const onLeft = chrome.clear ? chrome.clear === "left" : controlInset.left < controlInset.right;
  // Under the picture: the box text is written in, or the key bar (above the keyboard, or above the phone's
  // bottom edge when the keys are a real keyboard's), or the shortcuts. Each has the picture make room for it.
  let under = 0, aside = 0, over = 0;
  composer.classList.toggle("gone", !composerOpen);
  const composerWide = wide && safe.w >= 560;
  composer.classList.toggle("wide", composerWide);
  keys.classList.toggle("gone", !keysOpen || composerOpen);
  sheet.classList.toggle("gone", !sheetOpen && !sheetTransition);
  sheet.classList.toggle("narrow", wide);
  sheet.classList.toggle("folded", divided);
  if (composerOpen) {
    composer.style.maxHeight = safe.h + "px";
    composer.style.left = divided ? safe.x + "px" : "0px";
    composer.style.right = divided ? "auto" : "0px";
    composer.style.width = divided ? safe.w + "px" : "";
    composer.style.padding = divided ? "8px" : "8px " + (8 + inset.right) + "px " + (8 + inset.bottom) + "px " + (8 + inset.left) + "px";
    words.style.height = "";
    words.style.height = clamp(words.scrollHeight, (composerWide ? 44 : 66) * fontScale, (composerWide ? 66 : 132) * fontScale) + "px";
    const height = composer.offsetHeight, top = divided ? safe.y + safe.h - height : v.y + v.h - height;
    composer.style.top = top + "px";
    if (horizontalDivision && safe.y + safe.h / 2 < v.y + v.h / 2) over = top + height - v.y + 8;
    else under = v.y + v.h - top;
  } else if (keysOpen) {
    const height = divided ? Math.min(56, safe.h) : 44 * fontScale + 12 + inset.bottom;
    const top = divided ? safe.y + safe.h - height : v.y + v.h - height;
    keys.style.left = divided ? safe.x + "px" : "0px";
    keys.style.right = divided ? "auto" : "0px";
    keys.style.width = divided ? safe.w + "px" : "";
    keys.style.top = top + "px";
    keys.style.height = height + "px";
    keys.style.padding = divided ? "0 5px" : "0 " + (5 + inset.right) + "px " + inset.bottom + "px " + (5 + inset.left) + "px";
    if (horizontalDivision && safe.y + safe.h / 2 < v.y + v.h / 2) over = top + height - v.y + 8;
    else under = v.y + v.h - top;
  } else if ((sheetOpen || sheetTransition) && wide) {
    sheetDock = onLeft ? "left" : "right";
    const edge = chrome.clear ? 12 : Math.max(12, onLeft ? controlInset.left : controlInset.right), top = Math.max(controlInset.top, 12);
    const width = Math.min(320, Math.max(180, Math.round(safe.w * 0.42)), Math.max(1, safe.w - 24));
    sheet.style.width = width + "px";
    sheet.style.height = Math.max(1, v.h - top - Math.max(controlInset.bottom, 12)) + "px";
    sheet.style.left = (onLeft ? v.x + edge : v.x + v.w - edge - width) + "px";
    sheet.style.top = v.y + top + "px";
    aside = sheetOpen ? edge + width + 8 : 0;
  } else if (sheetOpen || sheetTransition) {
    const upper = horizontalDivision && safe.y + safe.h / 2 < v.y + v.h / 2;
    sheetDock = upper ? "top" : "bottom";
    const edge = divided ? 8 : Math.max(inset.bottom, 8), side = divided ? 8 : Math.max(inset.left, inset.right, 8);
    const most = Math.max(1, divided ? safe.h - 16 : v.h - inset.top - edge - 8);
    const height = document.activeElement === naming ? most : Math.min(most, clamp(Math.round(v.h * 0.5), 260, 400));
    const top = divided ? upper ? safe.y + 8 : safe.y + safe.h - edge - height : v.y + v.h - edge - height;
    sheet.style.width = Math.max(1, (divided ? safe.w : v.w) - side * 2) + "px";
    sheet.style.height = height + "px";
    sheet.style.left = (divided ? safe.x + side : v.x + side) + "px";
    sheet.style.top = top + "px";
    if (sheetOpen) {
      if (upper) over = top + height - v.y + 8;
      else under = v.y + v.h - top + 8;
    }
  }
  // Immersive video uses the entire surface; controls still stay inside the system's safe rectangle.
  const pictureInsets = chrome.fullscreen || document.fullscreenElement ? { top: 0, right: 0, bottom: 0, left: 0 } : inset;
  const left = Math.max(pictureInsets.left, onLeft ? aside : 0), right = Math.max(pictureInsets.right, onLeft ? 0 : aside);
  const top = Math.max(pictureInsets.top, over);
  area = { x: v.x + left, y: v.y + top, w: Math.max(1, v.w - left - right), h: Math.max(1, v.h - top - Math.max(under, pictureInsets.bottom)) };
  if (content.w) {
    fit = Math.min(area.w / content.w, area.h / content.h);
    const w = content.w * fit * zoom, h = content.h * fit * zoom;
    // Centred while it fits; once larger than the view it is moved about, never past its own edges.
    pan.x = w <= area.w ? area.x + (area.w - w) / 2 : clamp(pan.x, area.x + area.w - w, area.x);
    pan.y = h <= area.h ? area.y + (area.h - h) / 2 : clamp(pan.y, area.y + area.h - h, area.y);
    shown = { x: pan.x, y: pan.y, w, h };
    if (live) {
      // The video's box is the picture's place, not its pixels: the sender changes the resolution as the
      // network changes, and the picture stays where it is and as large, only sharper or softer.
      video.style.width = content.w * fit + "px";
      video.style.height = content.h * fit + "px";
      video.style.transform = "translate(" + pan.x + "px," + pan.y + "px) scale(" + zoom + ")";
    } else canvas.style.transform = "translate(" + pan.x + "px," + pan.y + "px) scale(" + fit * zoom + ")";
  }
  // The toolbar stands in the black beside the picture when there is some, under it otherwise; whatever opens takes its place.
  const beside = content.w ? area.w - content.w * fit > area.h - content.h * fit + inset.bottom : v.w > v.h;
  if (bar.classList.contains("side") !== beside) {
    bar.scrollLeft = 0;
    bar.scrollTop = 0;
  }
  bar.classList.toggle("side", beside);
  bar.style.maxWidth = Math.max(1, safe.w - 16) + "px";
  bar.style.maxHeight = Math.max(1, safe.h - 16) + "px";
  const size = { w: bar.offsetWidth, h: bar.offsetHeight };
  // Beside the picture it stands in the middle of the black there.
  if (beside) {
    const edge = onLeft ? inset.left : inset.right;
    const black = edge + (content.w ? (area.w - content.w * fit) / 2 : 0);
    const gap = chrome.clear || !edge ? Math.max(8, (black - size.w) / 2) : edge;
    bar.style.left = (onLeft ? v.x + gap : v.x + v.w - gap - size.w) + "px";
    bar.style.top = area.y + (area.h - size.h) / 2 + "px";
  } else {
    bar.style.left = (safe.w >= 600 ? safe.x + safe.w - size.w - 16 : safe.x + (safe.w - size.w) / 2) + "px";
    bar.style.top = v.y + v.h - Math.max(inset.bottom, 8) - 8 - size.h + "px";
  }
  const boundedBar = layoutControls(safe, containedBox(safe, size.w, size.h, parseFloat(bar.style.left), parseFloat(bar.style.top)));
  bar.style.left = boundedBar.x + "px";
  bar.style.top = boundedBar.y + "px";
  const horizontalMenu = fontScale <= 1.15 && !beside && safe.w >= 468 + size.w + 32;
  menu.classList.toggle("horizontal", horizontalMenu);
  for (const panel of [menu, connection]) {
    if (panel.classList.contains("gone")) continue;
    panel.style.width = Math.min(panel === menu && horizontalMenu ? 468 : 232 * fontScale, Math.max(1, safe.w - 16)) + "px";
    panel.style.maxHeight = Math.max(1, safe.h - 16) + "px";
    const placed = anchoredPanel(safe, content.w ? shown : { x: 0, y: 0, w: 0, h: 0 }, boundedBar, panel.offsetWidth, panel.offsetHeight);
    panel.style.left = placed.x + "px";
    panel.style.top = placed.y + "px";
    drawPopover(panel);
  }
  toast.style.left = safe.x + safe.w / 2 + "px";
  toast.style.maxWidth = Math.max(1, Math.min(420, safe.w - 24)) + "px";
  toast.style.top = area.y + 14 + "px";
  place();
  animatePresentation();
}

function place() {
  // Over a video the pointer is as large as it is in the picture, and never smaller than it is on the computer:
  // on a phone the whole screen is a few fingers wide, and a pointer to scale would be lost in it.
  const size = live ? " scale(" + (span ? Math.max(1, shown.w / span) : 1) + ")" : "";
  pointer.style.transform = "translate(" + (shown.x + cursor.x * shown.w) + "px," + (shown.y + cursor.y * shown.h) + "px)" + size;
}

let pendingLayout = 0;
function requestLayout() {
  if (pendingLayout) return;
  pendingLayout = requestAnimationFrame(() => { pendingLayout = 0; layout(); });
}
addEventListener("resize", requestLayout);
if (window.visualViewport) {
  visualViewport.addEventListener("resize", requestLayout);
  visualViewport.addEventListener("scroll", requestLayout);
}
// A resized native WebView can change its frame before the window reports a new viewport.
if (typeof ResizeObserver !== "undefined") new ResizeObserver(requestLayout).observe(stage);

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

// Where an event travels: down the socket, in order, until a video's two channels to the app are open; then
//   input    in order, nothing lost    buttons, keys, text
//   pointer  no order, sent once       the pointer on its way somewhere, the wheel
// The two keep no time with each other, so nothing goes on "pointer" that something on "input" has to come
// after, or before. The position a button, a key or the wheel acts at goes on "input" just ahead of it,
// however it was sent before. With a button down every position does: a drag is a path, and ends where it
// is let go. The wheel stays on "input" for the rest of a gesture whose position went there. And a pointer
// that comes to rest says where once more on "input", in case its last move was the one lost. Each event on
// the channels has a number (one count for both): by it the app drops a move from "pointer" that arrives
// after something sent later.
let wired = false, held = 0, sure = true, sent = 0, rest = 0, movedAt = -Infinity;
const trail = [];

function lanes() {
  const channels = rtc && rtc.channels;
  const open = !!channels && !!channels.input && channels.input.readyState === "open" && !!channels.pointer && channels.pointer.readyState === "open";
  // Not taken up with a button down: its release goes the way it went down.
  if (open !== wired && (!open || !held)) wired = open;
}

function post(message, lane) {
  if (!wired) return send(message);
  message.i = ++sent;
  rtc.channels[lane].send(JSON.stringify(message));
}

let moveWaiting = false;
/** Says where the pointer is: in order, when something is about to happen there. */
function tell(placed) {
  lanes();
  moveWaiting = false;
  const now = performance.now(), lane = laneOf("move", placed, held > 0, false);
  if (rtc) {
    // What was sent, to know it by when it comes back (see echo).
    trail.push({ x: cursor.x, y: cursor.y, t: now });
    while (now - trail[0].t > 1000) trail.shift();
  }
  post({ t: "move", x: +cursor.x.toFixed(5), y: +cursor.y.toFixed(5) }, lane);
  sure = !wired || lane === "input";
  clearTimeout(rest);
  if (!sure) rest = setTimeout(() => { if (!sure) tell(true); }, 80);
}
const flush = () => { if (moveWaiting) tell(false); };
// A pointer position a frame: as often as the picture could show it.
function moved() {
  if (!moveWaiting) requestAnimationFrame(flush);
  moveWaiting = true;
  movedAt = performance.now();
  glow();
  place();
}
// Everything else goes at once, after the position it happens at.
function act(message) {
  lanes();
  const placed = moveWaiting || !sure;
  if (placed) tell(true);
  if (message.t === "down") held += 1;
  if (message.t === "scroll" && placed && gesture) gesture.tied = true;
  post(message, laneOf(message.t, placed, held > 0, !!gesture && !!gesture.tied));
  if (message.t === "up") held = Math.max(0, held - 1);
}

let fade = 0;
function glow() {
  // Over a video the pointer is on show for good once it has been somewhere.
  if (live) return pointed || point();
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
  act({ t: "up", b: buttonName, n: count, m });
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
  if (presentation.active) { event.preventDefault(); return; }
  if (!immersiveControls() || controls.target > 0) wake();
  // A touch that closes the menu, or the shortcuts, does nothing else.
  const closing = [closeMenu(), closeSheet()].some(Boolean);
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
  if (presentation.active) return;
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
  // Keys go to the computer as they are pressed, unless text is being written here to be sent whole.
  if (!composerOpen) typing.focus({ preventScroll: true });
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
  if (presentation.active) return;
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
    for (const s of pieces(line, 4000)) act({ t: "text", s });
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
const fieldFocused = () => document.activeElement === typing || document.activeElement === shortcut;
function syncField() {
  if (!fieldFocused()) return;
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

// A field with the focus is not a keyboard on the screen. A phone takes its keyboard down without the field
// hearing of it — the app was put aside and came back, something else of the app's took the keys, the
// system's Back on Android — and the field still says it has the focus: asked for the keyboard then, it
// would only be let go of, and nothing would come up. So the app, which hears of the keyboard from the
// system, says whether it is up (chrome.keyboard), and a keyboard is asked for in a way that works from
// any state.
let askedAt = -Infinity, wanted = null, wentDown = false, settling = 0;

const keyboardShown = () => keyboardIsUp({
  focused: fieldFocused(),
  asked: performance.now() - askedAt,
  said: app && typeof chrome.keyboard === "boolean" ? chrome.keyboard : undefined,
  live: document.hasFocus(),
  shrunk: coarse && seen.follows ? seen.h - viewport().h > 120 : undefined,
});

/** Brings the phone's keyboard up for a field. Within a touch: a browser gives a keyboard to nothing else. */
function ask(field, again) {
  // A keyboard goes to the view the keys go to, and inside an app that is not always the page: the app
  // sees to it, and has the page ask once more (linkshellKeyboard) if no keyboard has come.
  if (!again) tellApp({ type: "keyboard" });
  askedAt = performance.now();
  wanted = field;
  // Focusing the field that has the focus does nothing: one the keyboard was taken from is let go of first,
  // without the page taking that for the keyboard going.
  if (document.activeElement === field) {
    switching = true;
    field.blur();
    switching = false;
  }
  field.focus({ preventScroll: true });
}
window.linkshellKeyboard = () => {
  if (chrome.keyboard === true || !wanted || performance.now() - askedAt > 3000) return;
  ask(wanted, true);
};

/** The keyboard goes, and the key bar with it: said here too, for a field that hears nothing because the page is not the one the keys go to. */
function dropKeys() {
  wanted = null;
  if (fieldFocused()) document.activeElement.blur();
  if (!keysOpen && !mods.size) return;
  keysOpen = false;
  mods.clear();
  drawKeys();
  refresh();
  armControlsIdle();
}

function raiseKeys() {
  closeSheet();
  closeComposer();
  ask(mods.size ? shortcut : typing);
}

function toggleKeys() {
  if (keyboardShown()) dropKeys();
  else raiseKeys();
}

/** The app said the keyboard that was up has gone: the page lets go of the field it was up for. */
function settle() {
  // Turning the phone takes the keyboard down and brings it straight back, and so does putting the app
  // aside and coming back to it: only a keyboard that stays down is gone. A page nobody sees waits to be seen.
  if (!wentDown || chrome.keyboard !== false || document.hidden) return;
  // One asked for a moment ago may be on its way up still.
  if (performance.now() - askedAt < 1000) return settleIn(1000);
  wentDown = false;
  const field = document.activeElement;
  wanted = null;
  if (field === words || field === naming) field.blur();
  else dropKeys();
}
function settleIn(ms) {
  clearTimeout(settling);
  settling = setTimeout(settle, ms);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) settleIn(1200); });

// ---- Toolbar, menu, key bar ----------------------------------------------

/** A control that works on touch-up and never takes the focus (the keyboard stays as it is). */
function tappable(element, action) {
  element.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); wake(); pressFeedback(element, true); });
  element.addEventListener("pointercancel", () => pressFeedback(element, false));
  element.addEventListener("pointerleave", () => pressFeedback(element, false));
  element.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("pointerup", (event) => {
    event.preventDefault();
    event.stopPropagation();
    pressFeedback(element, false);
    const box = element.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    if (Math.abs(event.clientX - cx) <= element.offsetWidth / 2 && Math.abs(event.clientY - cy) <= element.offsetHeight / 2) action();
  });
}

/** The same inside something that scrolls: the touch is left to the browser, and counts if it stayed where it landed. */
function pressable(element, action) {
  let from = null;
  element.addEventListener("pointerdown", (event) => { event.stopPropagation(); wake(); pressFeedback(element, true); from = { id: event.pointerId, x: event.clientX, y: event.clientY }; });
  element.addEventListener("pointercancel", () => { from = null; pressFeedback(element, false); });
  element.addEventListener("pointerleave", () => pressFeedback(element, false));
  // The mouse's events a browser makes up after a touch would land on whatever the action has left under the
  // finger, and take the focus from the field it gave it to. A touch that scrolled has none to stop.
  element.addEventListener("touchend", (event) => { if (event.cancelable) event.preventDefault(); });
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("pointerup", (event) => {
    const was = from;
    from = null;
    pressFeedback(element, false);
    event.stopPropagation();
    if (was && was.id === event.pointerId && Math.hypot(event.clientX - was.x, event.clientY - was.y) < SLOP) action();
  });
}

function wake() {
  expandControls(true);
  armControlsIdle();
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
  if (!live) pointer.classList.remove("on");
  if (mode === "view") {
    closeSheet();
    closeComposer();
    dropKeys();
    hint(HINTS.view);
  } else {
    askControl();
    explain(false);
  }
  refresh();
}

function closeMenu() {
  if (!popoverOpen(menu) && !popoverOpen(connection)) return false;
  presentPopover(menu, false);
  presentPopover(connection, false);
  clearInterval(statusTimer);
  wake();
  return true;
}

function refresh() {
  $("mode").innerHTML = ICON[mode];
  $("mode").classList.toggle("on", mode !== "view");
  $("keyboard").classList.toggle("gone", mode === "view");
  $("quick").classList.toggle("gone", mode === "view");
  $("fit").classList.toggle("gone", zoom < 1.05);
  $("rotate").classList.toggle("gone", !app || !chrome.canRotate);
  $("rotate").classList.toggle("on", chrome.landscape);
  const full = app ? chrome.fullscreen : !!document.fullscreenElement;
  $("full").classList.toggle("gone", !app && !document.fullscreenEnabled);
  $("full").innerHTML = full ? ICON.shrink : ICON.expand;
  for (const choice of choices) {
    choice.classList.toggle("on", choice.dataset.mode === mode);
    choice.setAttribute("aria-pressed", String(choice.dataset.mode === mode));
  }
  dress();
  layout();
  armControlsIdle();
}

function drawKeys() {
  for (const key of keys.children) if (key.dataset.mod) key.classList.toggle("on", mods.has(key.dataset.mod));
  syncField();
}

// ---- The way the picture comes ---------------------------------------------

const RANK = ["host", "prflx", "srflx", "relay"];
/** What the connection says of the track: the picture's size and pace, the round trip, the waits. */
async function vitals(pc, before) {
  const pairs = [], ends = new Map();
  let track = {}, transport = {};
  (await pc.getStats()).forEach((entry) => {
    if (entry.type === "inbound-rtp" && (entry.kind || entry.mediaType) === "video") track = entry;
    else if (entry.type === "transport") transport = entry;
    else if (entry.type === "candidate-pair") pairs.push(entry);
    else if (entry.type === "local-candidate" || entry.type === "remote-candidate") ends.set(entry.id, entry);
  });
  const pair = pairs.find((one) => one.id === transport.selectedCandidatePairId) || pairs.find((one) => one.selected) || pairs.find((one) => one.nominated && one.state === "succeeded") || {};
  const near = ends.get(pair.localCandidateId), far = ends.get(pair.remoteCandidateId);
  const was = before || {}, since = (field) => (track[field] || 0) - (was[field] || 0);
  const each = (total, count) => (since(count) > 0 ? (since(total) / since(count)) * 1000 : null);
  return {
    raw: track,
    width: track.frameWidth || video.videoWidth,
    height: track.frameHeight || video.videoHeight,
    fps: round(before ? (since("framesDecoded") * 1000) / (track.timestamp - was.timestamp) : track.framesPerSecond),
    rttMs: round(pair.currentRoundTripTime == null ? null : pair.currentRoundTripTime * 1000),
    jitterBufferMs: round(each("jitterBufferDelay", "jitterBufferEmittedCount")),
    decodeMs: round(each("totalDecodeTime", "framesDecoded"), 2),
    dropped: track.framesDropped ?? null,
    freezes: track.freezeCount ?? null,
    // The less direct of the two ends.
    path: near && far ? RANK[Math.max(RANK.indexOf(near.candidateType), RANK.indexOf(far.candidateType))] : null,
  };
}

/** Connection details are requested separately from the control mode. */
let statusTimer = 0, statusWas = null;
async function status() {
  const line = $("status");
  const put = (text) => {
    if (line.textContent === text) return;
    line.textContent = text;
    layout();
  };
  // The choice is the track's: the socket's picture follows its own ladder.
  const choosing = live && canChooseWidth;
  if ($("widths").classList.contains("gone") === choosing) {
    $("widths").classList.toggle("gone", !choosing);
    layout();
  }
  const way = !content.w ? "正在连接…" : live ? "直连 · 视频" : (relayed ? "中继" : "直连") + " · 兼容\n" + content.w + "×" + content.h;
  const pc = live && rtc && rtc.pc;
  if (!pc || !line.textContent.startsWith(way)) put(way);
  const now = pc && (await vitals(pc, statusWas).catch(() => null));
  if (!now || rtc === null || rtc.pc !== pc) return;
  statusWas = now.raw;
  put(way + "\n" + [now.width + "×" + now.height, now.fps === null ? "" : Math.round(now.fps) + " 帧/秒", now.rttMs === null ? "" : "往返 " + Math.round(now.rttMs) + " 毫秒"].filter(Boolean).join(" · "));
}

const ICON = JSON.parse($("icons").textContent);
const choices = menu.querySelectorAll(".choice");
pressable($("mode"), () => {
  closeSheet();
  const wasOpen = popoverOpen(menu);
  closeMenu();
  if (!wasOpen) presentPopover(menu, true);
});
pressable($("info"), () => {
  closeSheet();
  const wasOpen = popoverOpen(connection);
  closeMenu();
  if (!wasOpen) presentPopover(connection, true);
  if (!wasOpen) {
    statusWas = null;
    status();
    statusTimer = setInterval(status, 1500);
  }
  layout();
});
tappable($("closeinfo"), closeMenu);
// On a phone the button is there only while the key bar is not, which is while the page knows of no keyboard:
// there it only ever raises one, whatever state the field was left in. With a mouse it gives the keys and takes them.
pressable($("keyboard"), () => (coarse ? raiseKeys() : toggleKeys()));
pressable($("quick"), openSheet);
pressable($("fit"), () => zoomTo(1, { x: area.x + area.w / 2, y: area.y + area.h / 2 }));
pressable($("rotate"), () => tellApp({ type: "landscape", on: !chrome.landscape }));
for (const tile of $("widths").querySelectorAll(".tile")) {
  tile.classList.toggle("on", tile.dataset.width === width);
  tile.setAttribute("aria-pressed", String(tile.dataset.width === width));
  pressable(tile, () => {
    const chosen = tile.dataset.width;
    if (chosen === width) return;
    try { localStorage.setItem("linkshell.screen.width", chosen); } catch {}
    tellApp({ type: "width", width: chosen });
    if (reloadVia) return reloadVia({ width: chosen, mode });
    const next = new URLSearchParams(location.search);
    next.set("width", chosen);
    next.set("mode", mode);
    location.replace(location.pathname + "?" + next);
  });
}
pressable($("full"), () => {
  beginPresentation(app ? !chrome.fullscreen : !document.fullscreenElement);
  if (app) return tellApp({ type: "fullscreen", on: !chrome.fullscreen });
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener("fullscreenchange", refresh);
for (const choice of choices) {
  choice.querySelector("i").innerHTML = ICON[choice.dataset.mode];
  pressable(choice, () => { closeMenu(); setMode(choice.dataset.mode); });
}
for (const key of keys.children) {
  pressable(key, () => {
    const mod = key.dataset.mod;
    if (mod) {
      if (!mods.delete(mod)) mods.add(mod);
      return drawKeys();
    }
    if (key.dataset.key) return press(key.dataset.key);
    if (key.id === "quickkey") return openSheet();
    if (key.id === "composekey") return openComposer();
    dropKeys();
  });
}
$("hide").innerHTML = ICON.down;
$("quickkey").innerHTML = ICON.quick;
$("composekey").innerHTML = ICON.compose;

// ---- Shortcuts --------------------------------------------------------------

// Keys for the computer that a phone's keyboard has not got, one tap each, by what they are for: name, key,
// modifiers, and how the sheet takes the tap. "again": it stays, for another (the rest close it: what comes
// next is on the picture). "sure": asked twice, being a slip of the finger away from losing work.
const QUICK = [
  ["常用", [["复制", "c", "cmd"], ["粘贴", "v", "cmd"], ["剪切", "x", "cmd"], ["全选", "a", "cmd"], ["撤销", "z", "cmd", "again"], ["重做", "z", "shift cmd", "again"],
    ["保存", "s", "cmd"], ["查找", "f", "cmd"]]],
  ["窗口与应用", [["切换应用", "tab", "cmd", "again"], ["同应用窗口", "\x60", "cmd", "again"], ["新标签", "t", "cmd"], ["关闭窗口", "w", "cmd"], ["最小化", "m", "cmd"],
    ["全屏", "f", "ctrl cmd"], ["退出应用", "q", "cmd", "sure"]]],
  ["系统", [["聚焦搜索", "space", "cmd"], ["调度中心", "up", "ctrl"], ["应用窗口", "down", "ctrl"], ["左边桌面", "left", "ctrl", "again"], ["右边桌面", "right", "ctrl", "again"],
    ["切换输入法", "space", "ctrl", "again"], ["截图", "4", "shift cmd"], ["截图工具", "5", "shift cmd"], ["强制退出", "escape", "alt cmd", "sure"], ["锁定屏幕", "q", "ctrl cmd", "sure"]]],
];
const F_KEYS = Array.from({ length: 12 }, (_, n) => "f" + (n + 1));
const PLAIN_KEYS = { home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn", delete: "⌦", escape: "Esc", tab: "Tab", return: "回车" };
const SHORTCUTS_KEPT = "linkshell.screen.shortcuts";

// The user's own. The app keeps them (a page's own storage goes with its address, and this page's changes
// with every visit) and hands them back with the rest of what it tells the page; a browser has only its own.
// An app from before there were any does neither, and is known by saying nothing of them.
const helped = () => !!app && Array.isArray(chrome.shortcuts);
let mine = [];
if (helped()) mine = cleanShortcuts(chrome.shortcuts);
else try { mine = cleanShortcuts(JSON.parse(localStorage.getItem(SHORTCUTS_KEPT))); } catch {}
function keepMine() {
  if (helped()) return tellApp({ type: "shortcuts", list: mine });
  try { localStorage.setItem(SHORTCUTS_KEPT, JSON.stringify(mine)); } catch {}
}

// back: the sheet took the keyboard's place, and gives it back once a key has done what it was opened for.
let back = false, loosening = false, armed = null, disarming = 0;

function disarm() {
  if (!armed) return;
  clearTimeout(disarming);
  armed.classList.remove("sure");
  armed.firstChild.textContent = armed.dataset.name;
  armed = null;
}

function fire(item, element) {
  if (!controlling()) return explain(false);
  if (item.how === "sure" && armed !== element) {
    disarm();
    armed = element;
    element.dataset.name = item.name;
    element.classList.add("sure");
    element.firstChild.textContent = "再点一次";
    disarming = setTimeout(disarm, 3000);
    return;
  }
  disarm();
  act({ t: "key", k: item.k, m: item.m.length ? item.m : undefined });
  tellApp({ type: "haptic", kind: "light" });
  element.classList.add("hit");
  setTimeout(() => element.classList.remove("hit"), 160);
  const sign = comboSign(item.k, item.m);
  hint(sign === item.name ? sign : item.name + "  " + sign, 1300);
  if (item.how !== "again") closeSheet(back);
}

function tile(name, k, m, how, action) {
  const item = { name, k, m: modsOf(m), how }, element = document.createElement("div"), label = document.createElement("b"), sign = document.createElement("span");
  element.className = "tile";
  label.textContent = name;
  sign.textContent = comboSign(k, item.m);
  element.append(label);
  if (sign.textContent !== name) element.append(sign);
  pressable(element, () => (action ? action(element) : fire(item, element)));
  return element;
}

function group(into, title, tiles, six) {
  const head = document.createElement("div"), grid = document.createElement("div");
  head.className = "group";
  head.append(Object.assign(document.createElement("span"), { textContent: title }));
  grid.className = six ? "tiles six" : "tiles";
  grid.append(...tiles);
  if (title) into.append(head);
  into.append(grid);
  return head;
}

for (const [title, items] of QUICK) group(actions, title, items.map(([name, k, m, how]) => tile(name, k, m.split(" "), how)));
group(actions, "按键", F_KEYS.map((k) => tile(k.toUpperCase(), k, [], "again")), true);
group(actions, "", Object.keys(PLAIN_KEYS).map((k) => tile(PLAIN_KEYS[k], k, [], "again")));
const own = actions.appendChild(document.createElement("div"));

function drawMine() {
  own.textContent = "";
  if (!mine.length) loosening = false;
  const tiles = mine.map((one, index) => {
    const made = tile(one.name, one.k, one.m, "", loosening ? () => { mine.splice(index, 1); keepMine(); drawMine(); } : null);
    made.classList.toggle("loose", loosening);
    return made;
  });
  const add = document.createElement("div");
  add.className = "tile add";
  add.append(Object.assign(document.createElement("b"), { textContent: "＋ 添加" }));
  pressable(add, () => (mine.length < 24 ? showMaker(true) : hint("最多 24 个：先删掉用不到的", 2500)));
  const head = group(own, "我的", [...tiles, add]);
  if (!mine.length) return;
  const turn = head.appendChild(Object.assign(document.createElement("i"), { textContent: loosening ? "完成" : "删除" }));
  pressable(turn, () => { loosening = !loosening; drawMine(); });
}

// A shortcut of the user's own making: the modifiers, one key of those the computer knows by name, a name.
const making = new Set(), makerKey = $("makerkey");
const KEY_NAMES = { return: "回车 ↩\uFE0E", tab: "Tab", space: "空格", backspace: "删除 ⌫", delete: "向后删除 ⌦", escape: "Esc", left: "← 左", right: "→ 右", up: "↑ 上", down: "↓ 下",
  home: "Home", end: "End", pageup: "Page Up", pagedown: "Page Down" };
for (const [title, list] of [["字母", [..."abcdefghijklmnopqrstuvwxyz"]], ["数字", [..."1234567890"]], ["符号", [..."-=[]\\;',./\x60"]], ["功能键", F_KEYS], ["其他", Object.keys(KEY_NAMES)]]) {
  const set = makerKey.appendChild(Object.assign(document.createElement("optgroup"), { label: title }));
  for (const k of list) set.append(Object.assign(document.createElement("option"), { value: k, textContent: KEY_NAMES[k] || k.toUpperCase() }));
}
function drawMaker() {
  for (const one of $("makermods").children) one.classList.toggle("on", making.has(one.dataset.mod));
  $("makersign").textContent = comboSign(makerKey.value, [...making]);
}
function showMaker(on) {
  if (on) {
    making.clear();
    making.add("cmd");
    makerKey.value = "a";
    naming.value = "";
    drawMaker();
  } else if (document.activeElement === naming) naming.blur();
  actions.classList.toggle("gone", on);
  maker.classList.toggle("gone", !on);
  layout();
}
function saveMaker() {
  mine = cleanShortcuts([...mine, { name: naming.value, k: makerKey.value, m: [...making] }]);
  keepMine();
  loosening = false;
  drawMine();
  showMaker(false);
  // The new one is the last thing in the sheet.
  actions.scrollTop = actions.scrollHeight;
}
for (const one of $("makermods").children) tappable(one, () => { if (!making.delete(one.dataset.mod)) making.add(one.dataset.mod); drawMaker(); });
makerKey.addEventListener("change", drawMaker);
naming.addEventListener("focus", layout);
naming.addEventListener("blur", layout);
naming.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); saveMaker(); } });
tappable($("makercancel"), () => showMaker(false));
tappable($("makersave"), saveMaker);

function openSheet() {
  if (mode === "view" || sheetOpen) return;
  beginSheetTransition(true);
  closeMenu();
  closeComposer();
  back = keysOpen && fieldFocused();
  dropKeys();
  sheetOpen = true;
  loosening = false;
  drawMine();
  showMaker(false);
  refresh();
}

/** True when there was a sheet to close. toKeys: the keyboard it took the place of comes back. */
function closeSheet(toKeys) {
  if (!sheetOpen) return false;
  beginSheetTransition(false);
  sheetOpen = false;
  disarm();
  if (document.activeElement === naming) naming.blur();
  refresh();
  if (toKeys) raiseKeys();
  return true;
}
$("compose").insertAdjacentHTML("afterbegin", ICON.compose);
$("sheetkeys").innerHTML = ICON.keyboard;
$("sheetclose").innerHTML = ICON.close;
tappable($("compose"), openComposer);
tappable($("sheetkeys"), () => closeSheet(true));
tappable($("sheetclose"), () => closeSheet(false));

// ---- Text, written here and sent whole --------------------------------------

// Typing into the computer a key at a time suits a word or two. Anything longer is written in a box on the
// phone, where its keyboard, dictation and paste work as they do everywhere, and sent when it is ready.
// writing: an input method (pinyin, say) is in the middle of a word in the box. What it holds is not text yet,
// and the box is not emptied under it: on a phone it would go on composing with what is no longer there.
let writing = false;
words.addEventListener("compositionstart", () => { writing = true; });
words.addEventListener("compositionend", () => { writing = false; });
const unfinished = () => writing && (hint("先在键盘上选好字，再发送", 2500), true);

function grow() {
  // What to write there, said by the page: a phone's browser has been seen to draw a text box's own
  // placeholder cut to the width of what an input method last wrote in it.
  $("wordshint").classList.toggle("gone", words.value !== "");
  layout();
}

function openComposer() {
  if (mode === "view") return;
  closeMenu();
  closeSheet();
  if (!composerOpen) {
    composerOpen = true;
    // The app reads the clipboard for the page (one that knows how: see helped); a browser may let the page.
    $("pasteclip").classList.toggle("gone", app ? !helped() : !(navigator.clipboard && navigator.clipboard.readText));
    refresh();
    grow();
  }
  ask(words);
}

function closeComposer() {
  if (!composerOpen) return;
  composerOpen = false;
  wanted = null;
  writing = false;
  if (document.activeElement === words) words.blur();
  refresh();
}

function sendWords(andReturn) {
  if (!controlling()) return explain(false);
  if (unfinished()) return;
  const text = words.value;
  if (!text && !andReturn) return;
  for (const event of typingOf(text, 4000)) act(event);
  if (andReturn) act({ t: "key", k: "return" });
  words.value = "";
  grow();
  tellApp({ type: "haptic", kind: "light" });
  hint(text ? "已发送 " + [...text].length + " 个字" + (andReturn ? "，并回车" : "") : "已回车", 1500);
}

/** The phone's clipboard, put where the caret is: to be looked over, and sent by the user. */
function pasted(text) {
  if (!composerOpen) return;
  if (typeof text !== "string" || !text) return hint("手机剪贴板里没有文字", 2500);
  if (writing) return hint("先在键盘上选好字，再粘贴", 2500);
  words.setRangeText(text.slice(0, 20000), words.selectionStart, words.selectionEnd, "end");
  grow();
  words.scrollTop = words.scrollHeight;
}
window.linkshellClipboard = pasted;

words.addEventListener("input", grow);
tappable($("composeclose"), closeComposer);
tappable($("pasteclip"), () => {
  if (app) return tellApp({ type: "clipboard" });
  navigator.clipboard.readText().then(pasted, () => hint("浏览器没有允许读取剪贴板", 2500));
});
tappable($("sendwords"), () => sendWords(false));
tappable($("sendreturn"), () => sendWords(true));
$("composeclose").innerHTML = ICON.down;

/** The app tells the page what it did with the phone's screen, whether the keyboard is on it, and what shortcuts it keeps for the user. */
window.linkshellChrome = (next) => {
  if (typeof next.fullscreen === "boolean" && next.fullscreen !== chrome.fullscreen) beginPresentation(next.fullscreen);
  const was = chrome.keyboard;
  Object.assign(chrome, next);
  if (chrome.keyboard === true) wentDown = false;
  else if (was === true && chrome.keyboard === false) {
    wentDown = true;
    settleIn(300);
  }
  if (next.shortcuts && JSON.stringify(cleanShortcuts(next.shortcuts)) !== JSON.stringify(mine)) {
    mine = cleanShortcuts(next.shortcuts);
    drawMine();
  }
  refresh();
  armControlsIdle();
};

// ---- Measuring (?measure=1) ------------------------------------------------

// How late the picture is, by a clock the computer's app draws on its screen when the host is started with
// LINKSHELL_SCREEN_CLOCK=1: a strip of 20 cells across x 0.05–0.45 of the display at y 0.12, holding the time
// in milliseconds. Each frame's strip is read as the frame is shown, and once a second the host is told what
// was seen, whichever way the picture comes. The page's clock is taken to be the computer's (a browser on
// it, a simulator); with ?measure=sync the host is asked the time, for a device with a clock of its own.
let meter = null;
if (query.get("measure")) meter = (() => {
  const pageTime = () => performance.timeOrigin + performance.now();
  const sync = query.get("measure") === "sync", pings = new Map();
  let clock = { offset: 0, trip: Infinity }, pinged = 0;
  let late = [], unread = 0, frames = 0, presented = 0;
  let before = { at: performance.now(), presented: 0, raw: null };

  const small = () => Object.assign(document.createElement("canvas"), { width: 20, height: 1 });
  // One pixel a cell, at its middle. Through WebGL the frame stays on the GPU and only those 20 come back.
  function throughGL() {
    const gl = small().getContext("webgl", { antialias: false, depth: false, alpha: false });
    if (!gl) return null;
    const shader = (type, source) => {
      const made = gl.createShader(type);
      gl.shaderSource(made, source);
      gl.compileShader(made);
      return made;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec2 corner; varying vec2 at; void main() { at = vec2(0.05 + 0.4 * (corner.x * 0.5 + 0.5), 0.12); gl_Position = vec4(corner, 0.0, 1.0); }"));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "precision mediump float; uniform sampler2D frame; varying vec2 at; void main() { gl_FragColor = texture2D(frame, at); }"));
    gl.bindAttribLocation(program, 0, "corner");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    // Not averaged with its neighbours; and a frame is no power of two, which leaves only these settings.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const pixels = new Uint8Array(80);
    return (source) => {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, 20, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
  }
  // The same through a canvas in memory, where WebGL can't be had or won't take the frame.
  function throughCanvas() {
    const context = small().getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    return (source, w, h) => {
      context.drawImage(source, 0.05 * w, 0.12 * h - 0.5, 0.4 * w, 1, 0, 0, 20, 1);
      return context.getImageData(0, 0, 20, 1).data;
    };
  }
  let reader = throughGL();
  let plain = reader ? null : throughCanvas();

  /** One frame, w by h, shown at a time on the page's clock. Returns the time on its strip. */
  function seen(source, w, h, at) {
    let pixels;
    try {
      pixels = (reader || plain)(source, w, h);
    } catch {
      reader = null;
      pixels = (plain = plain || throughCanvas())(source, w, h);
    }
    const time = stripTime(pixels), ms = time === undefined ? undefined : lateness(at + clock.offset, time);
    frames += 1;
    if (ms === undefined) unread += 1;
    else late.push(ms);
    return time;
  }

  if ("requestVideoFrameCallback" in video) {
    const each = (now, metadata) => {
      video.requestVideoFrameCallback(each);
      presented = metadata.presentedFrames;
      seen(video, video.videoWidth, video.videoHeight, performance.timeOrigin + metadata.expectedDisplayTime);
    };
    video.requestVideoFrameCallback(each);
  } else {
    // Without frame callbacks a frame is seen on several refreshes of the screen: only its first sighting counts.
    let last;
    const each = () => {
      requestAnimationFrame(each);
      if (!live || video.readyState < 2) return;
      const count = late.length, time = seen(video, video.videoWidth, video.videoHeight, pageTime());
      if (time === last) {
        frames -= 1;
        if (late.length > count) late.pop();
        else unread -= 1;
      }
      last = time;
    };
    requestAnimationFrame(each);
  }

  if (sync) {
    const ping = () => {
      pings.set(++pinged, pageTime());
      send({ t: "ping", n: pinged, at: Date.now() });
    };
    ws.addEventListener("open", () => {
      for (let i = 0; i < 10; i++) setTimeout(ping, i * 100);
      setInterval(ping, 5000);
    });
  }

  setInterval(async () => {
    const counted = { late, unread, frames }, now = { at: performance.now(), presented, raw: null };
    late = [];
    unread = frames = 0;
    const track = live, pc = track && rtc && rtc.pc, seconds = (now.at - before.at) / 1000;
    const said = pc ? await vitals(pc, before.raw).catch(() => null) : null;
    if (said) now.raw = said.raw;
    send({
      t: "measure",
      mode: track ? "video" : "legacy",
      latency: summary(counted.late),
      // What was put on the screen: the browser's own count for a video, the frames drawn for the socket's picture.
      fps: round((track && now.presented > before.presented ? now.presented - before.presented : counted.frames) / seconds),
      width: content.w,
      height: content.h,
      jitterBufferMs: said && said.jitterBufferMs,
      decodeMs: said && said.decodeMs,
      rttMs: said && said.rttMs,
      path: said ? said.path : relayed ? "relay" : "socket",
      dropped: said ? said.dropped : skipped,
      freezes: said && said.freezes,
      unread: counted.unread,
      clock: sync ? { offsetMs: round(clock.offset), tripMs: round(clock.trip) } : undefined,
    });
    before = now;
  }, 1000);

  return {
    /** A frame of the socket's picture, just drawn. */
    drawn: (frame) => seen(frame, frame.displayWidth, frame.displayHeight, pageTime()),
    pong: (answer) => {
      const sent = pings.get(answer.n);
      pings.delete(answer.n);
      if (sent !== undefined) clock = synced(clock, sent, pageTime(), answer.now);
    },
  };
})();

resetTyping();
refresh();
wake();
tellApp({ type: "ready", mode });
`;

const SCRIPT = `(() => {${VIEWER_LOGIC}${BODY}})();`;

export function viewerPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>屏幕</title>
<style>${STYLE}</style></head>
<body>
<div id="stage"><div id="picture"><canvas id="screen"></canvas><video id="video" class="gone" autoplay playsinline muted></video><div id="pointer"></div></div></div>
<div id="note">正在连接电脑屏幕…</div>
<div id="toast" class="glass"></div>
<div id="menu" class="glass gone">
  <div class="choice" role="button" aria-label="只看，不操作电脑" data-mode="view"><i></i><div><b>只看</b><span>不操作电脑</span></div></div>
  <div class="choice" role="button" aria-label="触控板，滑动指针，轻点点击" data-mode="trackpad"><i></i><div><b>触控板</b><span>滑动指针 · 轻点点击</span></div></div>
  <div class="choice" role="button" aria-label="点按，点按画面直接操作" data-mode="touch"><i></i><div><b>点按</b><span>点按画面直接操作</span></div></div>
</div>
<div id="connection" class="glass gone">
  <div id="connectionhead"><span>连接信息</span><div class="tool" id="closeinfo" role="button" aria-label="关闭连接信息">${ICONS.close}</div></div>
  <div id="status"></div>
  <div id="widths" class="gone">
    <div class="group"><span>清晰度（直连视频）</span></div>
    <div class="tiles">
      <div class="tile" role="button" aria-label="流畅，1280 宽" data-width="1280"><b>流畅</b><span>1280</span></div>
      <div class="tile" role="button" aria-label="标准，1920 宽" data-width="1920"><b>标准</b><span>1920</span></div>
      <div class="tile" role="button" aria-label="高清，2560 宽" data-width="2560"><b>高清</b><span>2560</span></div>
      <div class="tile" role="button" aria-label="原生，屏幕本身的分辨率" data-width="native"><b>原生</b><span>最高 4K</span></div>
    </div>
  </div>
</div>
<div id="control-shell" class="glass" aria-hidden="true"></div>
<div id="bar">
  <div class="tool" id="mode" role="button" aria-label="控制方式"></div>
  <div class="tool" id="keyboard" role="button" aria-label="键盘">${ICONS.keyboard}</div>
  <div class="tool" id="quick" role="button" aria-label="快捷操作">${ICONS.quick}</div>
  <div class="tool" id="fit" role="button" aria-label="还原缩放">${ICONS.fit}</div>
  <div class="tool" id="rotate" role="button" aria-label="横屏">${ICONS.rotate}</div>
  <div class="tool" id="info" role="button" aria-label="连接信息">${ICONS.info}</div>
  <div class="tool" id="full" role="button" aria-label="全屏"></div>
</div>
<div id="orb" role="button" aria-label="展开屏幕控制"><div class="orb-core"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></div></div>
<div id="sheet" class="glass gone">
  <div id="sheethead">
    <div id="compose" role="button">发送文字…</div>
    <div class="tool" id="sheetkeys" role="button" aria-label="键盘"></div>
    <div class="tool" id="sheetclose" role="button" aria-label="关闭"></div>
  </div>
  <div id="actions"></div>
  <div id="maker" class="gone">
    <div class="group"><span>添加快捷键</span><span id="makersign"></span></div>
    <div class="tiles" id="makermods">
      <div class="tile" data-mod="ctrl"><b>⌃</b><span>control</span></div>
      <div class="tile" data-mod="alt"><b>⌥</b><span>option</span></div>
      <div class="tile" data-mod="shift"><b>⇧</b><span>shift</span></div>
      <div class="tile" data-mod="cmd"><b>⌘</b><span>command</span></div>
    </div>
    <label class="field"><span>按键</span><select id="makerkey" aria-label="按键"></select></label>
    <label class="field"><span>名称</span><input id="makername" type="text" maxlength="16" placeholder="可不填" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="名称"></label>
    <div class="ends"><div class="soft" id="makercancel" role="button">取消</div><div class="soft strong" id="makersave" role="button">添加</div></div>
  </div>
</div>
<div id="composer" class="gone">
  <div id="wordsbox"><textarea id="words" maxlength="20000" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="要发送的文字"></textarea><div id="wordshint">在这里写好，再发到电脑上</div></div>
  <div id="sendrow">
    <div class="soft" id="composeclose" role="button" aria-label="收起"></div>
    <div class="soft" id="pasteclip" role="button">粘贴手机剪贴板</div>
    <div class="spring"></div>
    <div class="soft" id="sendreturn" role="button">发送并回车</div>
    <div class="soft strong" id="sendwords" role="button">发送</div>
  </div>
</div>
<div id="keys" class="gone">
  <div class="key" id="quickkey" role="button" aria-label="快捷操作"></div>
  <div class="key" id="composekey" role="button" aria-label="发送文字"></div>
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
