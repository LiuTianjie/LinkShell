/** Toolbar popovers, WebRTC/JPEG stats vitals, shortcut sheet, composer, clipboard, privacy, and i18n UI. */
export const PANELS_SCRIPT = String.raw`
const ICON = JSON.parse($("icons").textContent);
const choices = menu.querySelectorAll(".choice");
function toggleConnectionPanel() {
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
}
pressable($("mode"), () => {
  closeSheet();
  const wasOpen = popoverOpen(menu);
  closeMenu();
  if (!wasOpen) presentPopover(menu, true);
});
pressable($("clipbar"), toggleConnectionPanel);
const audiobarButton = $("audiobar");
if (audiobarButton) pressable(audiobarButton, () => toggleAudio());
pressable($("info"), toggleConnectionPanel);
tappable($("closeinfo"), closeMenu);
// On a phone the button is there only while the key bar is not, which is while the page knows of no keyboard:
// there it only ever raises one, whatever state the field was left in. With a mouse it gives the keys and takes them.
pressable($("keyboard"), () => (coarse ? raiseKeys() : toggleKeys()));
pressable($("quick"), openSheet);
pressable($("fit"), () => zoomTo(1, { x: area.x + area.w / 2, y: area.y + area.h / 2 }));
for (const tile of $("widths").querySelectorAll(".tile")) {
  tile.classList.toggle("on", tile.dataset.width === width);
  tile.setAttribute("aria-pressed", String(tile.dataset.width === width));
  pressable(tile, () => {
    const chosen = tile.dataset.width;
    if (chosen === width) return;
    try { localStorage.setItem("linkshell.screen.width", chosen); } catch {}
    tellApp({ type: "width", width: chosen });
    window.linkshellSession({ width: chosen });
  });
}
for (const tile of $("pacing").querySelectorAll(".tile")) {
  tile.classList.toggle("on", tile.dataset.pacing === pacing);
  tile.setAttribute("aria-pressed", String(tile.dataset.pacing === pacing));
  pressable(tile, () => {
    const chosen = tile.dataset.pacing;
    if (chosen === pacing || !canChoosePacing()) return;
    try { localStorage.setItem("linkshell.screen.pacing", chosen); } catch {}
    hint(chosen === "smooth" ? L().pacingSmoothHint : L().pacingImmediateHint, 2500);
    if (app) return tellApp({ type: "pacing", pacing: chosen });
    const next = new URLSearchParams(location.search);
    next.set("pacing", chosen);
    next.set("width", width);
    next.set("display", String(session.desired().display));
    next.set("mode", mode);
    next.set("lang", lang);
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
const QUICK = windowsHost ? [
  ["常用", [["复制", "c", "ctrl"], ["粘贴", "v", "ctrl"], ["剪切", "x", "ctrl"], ["全选", "a", "ctrl"], ["撤销", "z", "ctrl", "again"], ["重做", "y", "ctrl", "again"], ["保存", "s", "ctrl"], ["查找", "f", "ctrl"]]],
  ["窗口与应用", [["切换应用", "tab", "alt", "again"], ["新标签", "t", "ctrl"], ["关闭标签", "w", "ctrl"], ["关闭窗口", "f4", "alt", "sure"], ["显示桌面", "d", "cmd"]]],
  ["系统", [["切换输入法", "space", "cmd", "again"], ["截图工具", "s", "shift cmd"], ["任务管理器", "escape", "ctrl shift"], ["锁定屏幕", "l", "cmd", "sure"]]],
] : [
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
    making.add(windowsHost ? "ctrl" : "cmd");
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
  const copy = L();
  hint(text ? copy.sentWords + [...text].length + copy.sentWordsSuffix + (andReturn ? copy.sentAndReturn : "") : copy.sentReturnOnly, 1500);
}

let clipboardGoal = "composer";
const bridgeCall = (payload) => {
  if (typeof window.__linkshellBridge === "function") {
    window.__linkshellBridge(payload);
    return true;
  }
  return false;
};

function pushClipboardToComputer(text) {
  if (typeof text !== "string" || !text) return hint(L().clipEmpty, 2200);
  const trimmed = text.slice(0, 100000);
  const bridged = bridgeCall({ type: "clipboard-write", text: trimmed });
  if (app) tellApp({ type: "clipboardWrite", text: trimmed });
  // Over the stream's own socket wherever there is no bridge: the host answers with the result.
  // (An app that also acts on the message above writes the same text twice, which is once.)
  if (!bridged) send({ t: "clipboard.write", text: trimmed });
  tellApp({ type: "haptic", kind: "light" });
  if (bridged) hint(L().clipSynced, 1800);
}

function requestPasteToComputer() {
  if (bridgeCall({ type: "clipboard-paste-to-computer" })) return;
  if (app) {
    clipboardGoal = "computer";
    tellApp({ type: "clipboard", target: "computer" });
    tellApp({ type: "clipboardPasteToComputer" });
    return;
  }
  if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
    navigator.clipboard.readText().then(pushClipboardToComputer, () => hint(L().clipBlocked, 2500));
    return;
  }
  hint(L().clipBlocked, 2500);
}

function requestCopyFromComputer() {
  const bridged = bridgeCall({ type: "clipboard-read" });
  if (app) tellApp({ type: "clipboardRead" });
  if (!bridged) send({ t: "clipboard.read" });
}

function receiveComputerClipboard(payload) {
  const text = typeof payload === "string" ? payload : payload && typeof payload.text === "string" ? payload.text : "";
  if (!text) return hint(L().clipEmpty, 2200);
  if (app) {
    tellApp({ type: "setDeviceClipboard", text });
    tellApp({ type: "haptic", kind: "light" });
    // An app from before it knew that message: the page may be allowed to write it itself.
    try { if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") navigator.clipboard.writeText(text).catch(() => {}); } catch (error) {}
    return hint(L().clipSynced, 1800);
  }
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(() => hint(L().clipSynced, 1800), () => hint(L().clipSynced, 1800));
    return;
  }
  hint(L().clipSynced, 1800);
}
window.linkshellRemoteClipboard = receiveComputerClipboard;
window.linkshellClipboardResult = (result) => {
  if (result && result.ok === false) return hint(result.message || L().clipFailed, 2500);
  hint(L().clipSynced, 1800);
};

const privacyState = { curtain: false, lockOnDisconnect: false, supported: !windowsHost };
function drawPrivacy() {
  $("privacy").classList.toggle("gone", privacyState.supported === false);
  for (const [id, on] of [["privacycurtain", privacyState.curtain], ["lockdisconnect", privacyState.lockOnDisconnect]]) {
    const el = $(id);
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-pressed", String(!!on));
  }
  $("clipbar").classList.toggle("on", !!(privacyState.curtain || privacyState.lockOnDisconnect));
}
function receivePrivacyState(next) {
  if (!next || typeof next !== "object") return;
  if (typeof next.curtain === "boolean") privacyState.curtain = next.curtain;
  if (typeof next.lockOnDisconnect === "boolean") privacyState.lockOnDisconnect = next.lockOnDisconnect;
  if (typeof next.supported === "boolean") privacyState.supported = next.supported;
  drawPrivacy();
  layout();
}
window.linkshellPrivacy = receivePrivacyState;

function togglePrivacy(field) {
  const value = !privacyState[field];
  privacyState[field] = value;
  drawPrivacy();
  const patch = field === "curtain" ? { curtain: value } : { lockOnDisconnect: value };
  const bridged = bridgeCall(Object.assign({ type: "screen-privacy" }, patch));
  if (app) tellApp(Object.assign({ type: "screenPrivacy" }, patch));
  if (!bridged && !app) send(Object.assign({ t: "screen.privacy" }, patch));
  tellApp({ type: "haptic", kind: "light" });
  hint(field === "curtain" ? (value ? L().curtainOn : L().curtainOff) : (value ? L().lockOn : L().lockOff), 2200);
}

function applyLang(force) {
  const copy = L();
  refreshAudioButton();
  for (const tile of $("langs").querySelectorAll(".tile")) {
    const on = tile.dataset.lang === lang;
    tile.classList.toggle("on", on);
    tile.setAttribute("aria-pressed", String(on));
  }
  if (!force && lang === "zh") return;
  document.title = copy.title;
  const modeCopy = {
    view: [copy.viewTitle, copy.viewDesc, copy.viewAria],
    trackpad: [copy.trackpadTitle, copy.trackpadDesc, copy.trackpadAria],
    touch: [copy.touchTitle, copy.touchDesc, copy.touchAria],
  };
  for (const choice of choices) {
    const entry = modeCopy[choice.dataset.mode];
    if (!entry) continue;
    const b = choice.querySelector("b"), span = choice.querySelector("span");
    if (b) b.textContent = entry[0];
    if (span) span.textContent = entry[1];
    choice.setAttribute("aria-label", entry[2]);
  }
  $("connheadtext").textContent = copy.connTitle;
  $("closeinfo").setAttribute("aria-label", copy.closeInfo);
  $("widthshead").textContent = copy.widthsTitle;
  const widthCopy = { "1280": [copy.w1280, "1280"], "1920": [copy.w1920, "1920"], "2560": [copy.w2560, "2560"], native: [copy.wNative, copy.wNativeSub] };
  for (const tile of $("widths").querySelectorAll(".tile")) {
    const entry = widthCopy[tile.dataset.width];
    if (!entry) continue;
    const b = tile.querySelector("b"), span = tile.querySelector("span");
    if (b) b.textContent = entry[0];
    if (span) span.textContent = entry[1];
  }
  $("pacinghead").textContent = copy.pacingTitle;
  const pacingCopy = { immediate: [copy.pImmediate, copy.pImmediateSub], smooth: [copy.pSmooth, copy.pSmoothSub] };
  for (const tile of $("pacing").querySelectorAll(".tile")) {
    const entry = pacingCopy[tile.dataset.pacing];
    if (!entry) continue;
    const b = tile.querySelector("b"), span = tile.querySelector("span");
    if (b) b.textContent = entry[0];
    if (span) span.textContent = entry[1];
  }
  $("cliphead").textContent = copy.clipHead;
  for (const [id, title, sub] of [["pastecomputer", copy.pasteComputer, copy.pasteComputerSub], ["copycomputer", copy.copyComputer, copy.copyComputerSub], ["privacycurtain", copy.curtain, copy.curtainSub], ["lockdisconnect", copy.lockDisconnect, copy.lockDisconnectSub]]) {
    const el = $(id), b = el.querySelector("b"), span = el.querySelector("span");
    if (b) b.textContent = title;
    if (span) span.textContent = sub;
    el.setAttribute("aria-label", title);
  }
  $("privacyhead").textContent = copy.privacyHead;
  $("langhead").textContent = copy.langHead;
  for (const [id, label] of [["mode", copy.barMode], ["keyboard", copy.barKeyboard], ["quick", copy.barQuick], ["clipbar", copy.barClip], ["fit", copy.barFit], ["info", copy.barInfo], ["full", copy.barFull], ["orb", copy.orbExpand]]) {
    $(id).setAttribute("aria-label", label);
  }
  refreshAudioButton();
  const composeEl = $("compose");
  composeEl.innerHTML = ICON.compose;
  const composeText = document.createElement("span");
  composeText.textContent = copy.composePrompt;
  composeEl.appendChild(composeText);
  $("wordshint").textContent = copy.wordsHint;
  $("pasteclip").textContent = copy.pasteClip;
  $("sendreturn").textContent = copy.sendReturn;
  $("sendwords").textContent = copy.sendWords;
}

function setLang(next) {
  if (!LOCALES.includes(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem("linkshell.screen.lang", lang); } catch {}
  tellApp({ type: "locale", locale: lang });
  bridgeCall({ type: "screen-locale", locale: lang });
  applyLang(true);
  if (popoverOpen(connection)) status();
  layout();
}

/** The phone's clipboard, put where the caret is: to be looked over, and sent by the user. */
function pasted(text) {
  if (clipboardGoal === "computer") {
    clipboardGoal = "composer";
    return pushClipboardToComputer(text);
  }
  if (!composerOpen) return;
  if (typeof text !== "string" || !text) return hint(L().clipEmpty, 2500);
  if (writing) return hint("先在键盘上选好字，再粘贴", 2500);
  words.setRangeText(text.slice(0, 20000), words.selectionStart, words.selectionEnd, "end");
  grow();
  words.scrollTop = words.scrollHeight;
}
window.linkshellClipboard = pasted;

words.addEventListener("input", grow);
tappable($("composeclose"), closeComposer);
tappable($("pasteclip"), () => {
  clipboardGoal = "composer";
  if (app) return tellApp({ type: "clipboard" });
  navigator.clipboard.readText().then(pasted, () => hint(L().clipBlocked, 2500));
});
tappable($("sendwords"), () => sendWords(false));
tappable($("sendreturn"), () => sendWords(true));
$("composeclose").innerHTML = ICON.down;
$("clipbar").innerHTML = ICON.clipboard;
pressable($("pastecomputer"), requestPasteToComputer);
pressable($("copycomputer"), requestCopyFromComputer);
pressable($("privacycurtain"), () => togglePrivacy("curtain"));
pressable($("lockdisconnect"), () => togglePrivacy("lockOnDisconnect"));
for (const tile of $("langs").querySelectorAll(".tile")) {
  pressable(tile, () => setLang(tile.dataset.lang));
}

/** The app tells the page what it did with the phone's screen, whether the keyboard is on it, and what shortcuts it keeps for the user. */
window.linkshellChrome = (next) => {
  if (typeof next.fullscreen === "boolean" && next.fullscreen !== chrome.fullscreen) beginPresentation(next.fullscreen);
  const was = chrome.keyboard;
  Object.assign(chrome, next);
  if (next.locale && LOCALES.includes(next.locale) && next.locale !== lang) setLang(next.locale);
  if (next.privacy && typeof next.privacy === "object") receivePrivacyState(next.privacy);
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
if (!nativePicture && query.get("measure")) meter = (() => {
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
      codec: said && said.codec,
      bitrateMbps: said && said.bitrateMbps,
      decoder: said && said.decoder,
      powerEfficientDecoder: said && said.powerEfficientDecoder,
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

drawPrivacy();
applyLang(false);
resetTyping();
refresh();
wake();
session.visibility(document.hidden);
if (nativePicture) {
  window.linkshellNative = {
    picture: (size) => {
      content.w = size.width; content.h = size.height;
      if (!live) show(true);
      say("");
      layout();
    },
    message: (message) => {
      if (message.t === "cursor" || message.t === "shape") told(message);
      else heard(message);
    },
    stats: (stats) => { nativeStats = stats; },
    connecting: () => {
      nativeStats = null;
      session.reconnect();
      waitForCapabilities();
      Object.assign(control, { asked: false, known: false, trusted: false });
      if (!hasPicture && loading.phase !== "receiving") showProgress("connecting");
      if (mode !== "view") askControl();
    },
  };
  // React Native mounts the WebView as a child of the native renderer. Its WebKit
  // handler can arrive just after this page, so wait for that attachment once.
  const waitingSince = performance.now();
  const attachNative = () => {
    if (window.webkit?.messageHandlers?.linkshellScreen) {
      nativePost({ kind: "ready", version: 1 });
      ws.onopen();
    } else if (performance.now() - waitingSince < 5000) setTimeout(attachNative, 50);
    else tellApp({ type: "nativeUnavailable" });
  };
  attachNative();
}
tellApp({ type: "ready", mode, nativeLoading: appManagedLoading });
`;
