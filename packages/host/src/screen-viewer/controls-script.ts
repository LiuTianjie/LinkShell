/** Pointer rendering, responsive layout, springs, touch/trackpad gestures, and keyboard capture. */
export const CONTROLS_SCRIPT = String.raw`
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
  if ((rtc || nativePicture) && !pointed) point();
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
  if (nativePicture && content.w) nativePost({ kind: "frame", rect: shown });
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
  if (nativePicture) nativePost({ kind: "frame", rect: visiblePicture() });
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
  if (!session.active() || !controlsMayCollapse() || controls.target === 0) return;
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
  if (!session.active() || !controls.orb) return;
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
      // The picture's box is its place, not its pixels: the sender changes the resolution as the
      // network changes, and the picture stays where it is and as large, only sharper or softer.
      // The box and its corner are put on whole device pixels: one that falls between two of them is
      // resampled by the compositor, which costs the text its edges for a fraction of a pixel's accuracy.
      const grid = devicePixelRatio || 1, snap = (value) => Math.round(value * grid) / grid;
      const shows = presenter ? gpu : video;
      shows.style.width = snap(content.w * fit) + "px";
      shows.style.height = snap(content.h * fit) + "px";
      shows.style.transform = "translate(" + snap(pan.x) + "px," + snap(pan.y) + "px) scale(" + zoom + ")";
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
  if (nativePicture && content.w && !presentation.active) nativePost({ kind: "frame", rect: shown });
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

const controlling = () => session.canInput() && mode !== "view" && control.available && control.trusted;

function askControl() {
  if (control.asked || !session.canInput()) return;
  control.asked = true;
  send({ t: "control", ...(session.generation() !== undefined ? { screenGeneration: session.generation() } : {}) });
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
const heldButtons = new Map();
let inputEpoch = 0;

function lanes() {
  if (nativePicture) { wired = true; return; }
  const channels = rtc && rtc.channels;
  const open = !!channels && !!channels.input && channels.input.readyState === "open" && !!channels.pointer && channels.pointer.readyState === "open";
  // Not taken up with a button down: its release goes the way it went down.
  if (open !== wired && (!open || !held)) wired = open;
}

function post(message, lane) {
  if (!session.canInput()) return;
  if (session.generation() !== undefined) message.screenGeneration = session.generation();
  transmitInput(message, lane);
}

function transmitInput(message, lane) {
  if (nativePicture) return nativePost({ kind: "input", message, replaceable: lane === "pointer" });
  if (!wired) return send(message);
  message.i = ++sent;
  const channel = rtc && rtc.channels[lane];
  if (channel && channel.readyState === "open") channel.send(JSON.stringify(message));
}

let moveWaiting = false, moveFramePending = false;
/** Says where the pointer is: in order, when something is about to happen there. */
function tell(placed) {
  if (!session.canInput()) { moveWaiting = false; return; }
  lanes();
  moveWaiting = false;
  const now = performance.now(), lane = laneOf("move", placed, held > 0, false);
  if (rtc || nativePicture) {
    // What was sent, to know it by when it comes back (see echo).
    trail.push({ x: cursor.x, y: cursor.y, t: now });
    while (now - trail[0].t > 1000) trail.shift();
  }
  post({ t: "move", x: +cursor.x.toFixed(5), y: +cursor.y.toFixed(5) }, lane);
  sure = !wired || lane === "input";
  clearTimeout(rest);
  if (!sure) rest = setTimeout(() => { if (!sure) tell(true); }, 80);
}
const flush = () => {
  moveFramePending = false;
  if (moveWaiting) tell(false);
};
// Leading-edge immediate send on live pointer/trackpad motion + per-frame trailing coalesce:
// cuts first-move latency by up to 16 ms while keeping pre-click placement (immediate = false)
// single-packet on the reliable input channel.
function moved(immediate = false) {
  if (!session.canInput()) return;
  movedAt = performance.now();
  glow();
  place();
  if (immediate && !moveFramePending) {
    moveFramePending = true;
    tell(false);
    requestAnimationFrame(flush);
  } else {
    if (!moveWaiting && !moveFramePending) {
      moveFramePending = true;
      requestAnimationFrame(flush);
    }
    moveWaiting = true;
  }
}
// Everything else goes at once, after the position it happens at.
function act(message) {
  if (!session.canInput()) return;
  lanes();
  const placed = moveWaiting || !sure;
  if (placed) tell(true);
  if (message.t === "down") { heldButtons.set(message.b, { ...message }); held = heldButtons.size; }
  if (message.t === "scroll" && placed && gesture) gesture.tied = true;
  post(message, laneOf(message.t, placed, held > 0, !!gesture && !!gesture.tied));
  if (message.t === "up") { heldButtons.delete(message.b); held = heldButtons.size; }
}

/** Input queued for the old display must never be replayed when the retained page is shown again. */
function releaseInput() {
  inputEpoch += 1;
  control.asked = false;
  lanes();
  for (const button of heldButtons.values()) {
    const released = { ...button, t: "up" };
    if (session.generation() !== undefined) released.screenGeneration = session.generation();
    transmitInput(released, "input");
  }
  heldButtons.clear();
  held = 0;
  sure = true;
  moveWaiting = false;
  moveFramePending = false;
  clearTimeout(rest);
  clearTimeout(fade);
  clearTimeout(settling);
  clearTimeout(toastTimer);
  clearTimeout(disarming);
  clearInterval(statusTimer);
  clearTimeout(controls.timer);
  if (gesture) clearTimeout(gesture.hold);
  for (const id of touches.keys()) { try { stage.releasePointerCapture(id); } catch {} }
  touches.clear();
  gesture = lastTap = mouseHeld = null;
  mouseClicks = { t: 0, n: 0, x: 0, y: 0, b: 0 };
  movedAt = -Infinity;
  trail.length = 0;
  mods.clear();
  composing = writing = false;
  composed = "";
  leftover = wanted = null;
  askedAt = -Infinity;
  keysOpen = false;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  resetTyping();
  shortcut.value = "";
  disarm();
  pointer.classList.remove("pressed", "on");
  toast.classList.remove("on");
  if (controls.drag) { try { orb.releasePointerCapture(controls.drag.id); } catch {} }
  controls.drag = null;
  for (const element of pressedControls) element.style.scale = "";
  pressedControls.clear();
  finishPresentation();
  drawKeys();
  clearTimeout(controls.timer);
  clearTimeout(settling);
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
function pointAt(x, y, immediate = false) {
  const u = (x - shown.x) / shown.w, v = (y - shown.y) / shown.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  cursor.x = u;
  cursor.y = v;
  moved(immediate);
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
  moved(true);
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
  if (!session.active() || presentation.active) { event.preventDefault(); return; }
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
  if (!session.active() || presentation.active) return;
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
    else if (g.dragging) pointAt(clamp(g.x, shown.x, shown.x + shown.w), clamp(g.y, shown.y, shown.y + shown.h), true);
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
  if (controlling()) pointAt(clamp(event.clientX, shown.x, shown.x + shown.w), clamp(event.clientY, shown.y, shown.y + shown.h), true);
}
function mouseUp(event) {
  if (mouseHeld && mouseHeld !== "pan") act({ t: "up", b: mouseHeld, n: mouseClicks.n, m: hardMods(event) });
  mouseHeld = null;
}
stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (!session.active() || presentation.active) return;
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
  if (!session.canInput()) return;
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
  let epoch = -1;
  element.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); if (!session.active()) return; epoch = inputEpoch; wake(); pressFeedback(element, true); });
  element.addEventListener("pointercancel", () => pressFeedback(element, false));
  element.addEventListener("pointerleave", () => pressFeedback(element, false));
  element.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("pointerup", (event) => {
    event.preventDefault();
    event.stopPropagation();
    pressFeedback(element, false);
    if (!session.active() || epoch !== inputEpoch) return;
    epoch = -1;
    const box = element.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    if (Math.abs(event.clientX - cx) <= element.offsetWidth / 2 && Math.abs(event.clientY - cy) <= element.offsetHeight / 2) action();
  });
}

/** The same inside something that scrolls: the touch is left to the browser, and counts if it stayed where it landed. */
function pressable(element, action) {
  let from = null;
  element.addEventListener("pointerdown", (event) => { event.stopPropagation(); if (!session.active()) return; wake(); pressFeedback(element, true); from = { id: event.pointerId, x: event.clientX, y: event.clientY, epoch: inputEpoch }; });
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
    if (session.active() && was && was.epoch === inputEpoch && was.id === event.pointerId && Math.hypot(event.clientX - was.x, event.clientY - was.y) < SLOP) action();
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
  if (!session.active()) return;
  if (!session.canInput()) return hint(L().adjusting, 0);
  if (!control.known) return hint(L().preparingControl, 0);
  if (!control.available) return hint(control.reason || L().controlUnavailable);
  if (!control.trusted) {
    // The system's own dialog, on the computer, once.
    if (!control.prompted) { control.prompted = true; send({ t: "prompt" }); }
    const who = control.app ? "「" + control.app + "」" : "LinkShell";
    if (lang === "en") return hint("Remote control is not yet allowed on the computer. Open System Settings › Privacy & Security › Accessibility and enable " + (control.app || "LinkShell") + ", or run linkshell screen on the Mac.", 0);
    if (lang === "ja") return hint("PC でリモート操作がまだ許可されていません。「システム設定 › プライバシーとセキュリティ › アクセシビリティ」で " + (control.app || "LinkShell") + " をオンにするか、PC で linkshell screen を実行してください。", 0);
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
  refreshAudioButton();
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
  const pairs = [], ends = new Map(), codecs = new Map();
  let track = {}, transport = {};
  (await pc.getStats()).forEach((entry) => {
    if (entry.type === "inbound-rtp" && (entry.kind || entry.mediaType) === "video") track = entry;
    else if (entry.type === "transport") transport = entry;
    else if (entry.type === "candidate-pair") pairs.push(entry);
    else if (entry.type === "local-candidate" || entry.type === "remote-candidate") ends.set(entry.id, entry);
    else if (entry.type === "codec") codecs.set(entry.id, entry);
  });
  const pair = pairs.find((one) => one.id === transport.selectedCandidatePairId) || pairs.find((one) => one.selected) || pairs.find((one) => one.nominated && one.state === "succeeded") || {};
  const near = ends.get(pair.localCandidateId), far = ends.get(pair.remoteCandidateId);
  const was = before && before.id === track.id && track.timestamp > before.timestamp ? before : null;
  const since = (field) => (track[field] || 0) - (was && was[field] || 0);
  const each = (total, count) => (since(count) > 0 ? (since(total) / since(count)) * 1000 : null);
  return {
    raw: track,
    width: track.frameWidth || (presenter ? presenter.w : video.videoWidth),
    height: track.frameHeight || (presenter ? presenter.h : video.videoHeight),
    // Whether this page took the frames from the decoder and drew them itself.
    presented: presenter ? "gpu" : null,
    // Frames the mailbox replaced before the display asked for them: the picture's way of
    // staying live when the decoder runs ahead of the screen.
    presentDropped: presenter ? presenter.dropped : null,
    fps: round(was ? (since("framesDecoded") * 1000) / (track.timestamp - was.timestamp) : track.framesPerSecond),
    codec: videoCodec(codecs.get(track.codecId)),
    bitrateMbps: was ? round(Math.max(0, since("bytesReceived")) * 8 / ((track.timestamp - was.timestamp) * 1000), 2) : null,
    decoder: track.decoderImplementation || null,
    powerEfficientDecoder: track.powerEfficientDecoder ?? null,
    rttMs: round(pair.currentRoundTripTime == null ? null : pair.currentRoundTripTime * 1000),
    jitterBufferMs: round(each("jitterBufferDelay", "jitterBufferEmittedCount")),
    decodeMs: round(each("totalDecodeTime", "framesDecoded"), 2),
    dropped: track.framesDropped ?? null,
    freezes: track.freezeCount ?? null,
    // The less direct of the two ends.
    path: near && far ? RANK[Math.max(RANK.indexOf(near.candidateType), RANK.indexOf(far.candidateType))] : null,
  };
}

// The desktop workspace shows real receive metrics without copying video frames into React.
if (typeof window.__linkshellReport === "function") {
  let previous = null, pending = false;
  const reportTimer = setInterval(async () => {
    if (document.hidden || pending) return;
    pending = true;
    try {
      const pc = live && rtc && rtc.pc;
      const stats = pc ? await vitals(pc, previous) : null;
      if (pc && (!rtc || rtc.pc !== pc)) return;
      previous = stats?.raw ?? null;
      window.__linkshellReport(stats
        ? { width: stats.width, height: stats.height, fps: stats.fps, codec: stats.codec, bitrateMbps: stats.bitrateMbps, presented: stats.presented, live: true }
        : windowsHost ? jpegVitals() : { width: content.w, height: content.h, live: false });
    } catch { /* A reconnect can close getStats while it is in flight. */ }
    finally { pending = false; }
  }, 2000);
  addEventListener("pagehide", () => clearInterval(reportTimer), { once: true });
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
  const choosing = (live || windowsHost) && (canChooseWidth || session.supported());
  if ($("widths").classList.contains("gone") === choosing) {
    $("widths").classList.toggle("gone", !choosing);
    layout();
  }
  // Only a video track has a jitter buffer to keep; the socket's picture is paced by this page.
  const pacingShown = live && !windowsHost && canChoosePacing();
  if ($("pacing").classList.contains("gone") === pacingShown) {
    $("pacing").classList.toggle("gone", !pacingShown);
    layout();
  }
  const copy = L();
  const way = !content.w ? copy.connecting : live ? copy.directVideo : (relayed ? copy.relayCompat : copy.directCompat) + "\n" + content.w + "×" + content.h;
  if (windowsHost && !live && content.w) {
    const stats = jpegVitals();
    put(way + "\n" + stats.fps + copy.fpsUnit + " · " + stats.bitrateMbps + " Mbps");
    return;
  }
  if (nativePicture) {
    nativePost({ kind: "stats" });
    const detail = [content.w ? content.w + "×" + content.h : null,
      nativeStats?.decodedFps == null ? null : Math.round(nativeStats.decodedFps) + copy.fpsUnit,
      nativeStats?.rttMs == null ? null : copy.rttPrefix + Math.round(nativeStats.rttMs) + copy.msUnit].filter(Boolean).join(" · ");
    put(way + (detail ? "\n" + detail : ""));
    return;
  }
  const pc = live && rtc && rtc.pc;
  if (!pc || !line.textContent.startsWith(way)) put(way);
  const now = pc && (await vitals(pc, statusWas).catch(() => null));
  if (!now || rtc === null || rtc.pc !== pc) return;
  statusWas = now.raw;
  const format = [now.codec, now.bitrateMbps === null ? null : now.bitrateMbps + " Mbps"].filter(Boolean).join(" · ");
  put(way + "\n" + [now.width + "×" + now.height, now.fps === null ? "" : Math.round(now.fps) + copy.fpsUnit, now.rttMs === null ? "" : copy.rttPrefix + Math.round(now.rttMs) + copy.msUnit].filter(Boolean).join(" · ") + (format ? "\n" + format : ""));
}
`;
