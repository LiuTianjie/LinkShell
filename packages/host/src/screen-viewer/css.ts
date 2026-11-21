/** Inline stylesheet for the remote screen viewer page. */
export const VIEWER_STYLE = String.raw`
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  html, body { margin: 0; height: 100%; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; background: #000; overflow: hidden; overscroll-behavior: none; }
  body { position: fixed; inset: 0; color: #fff; font: 15px/1.45 -apple-system, system-ui, "PingFang SC", "Noto Sans CJK SC", sans-serif; }
  html.native-picture, html.native-picture body { background: transparent; }
  .native-picture canvas, .native-picture video { visibility: hidden; }
  #stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; }
  #picture { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
  #stage.presenting #pointer { opacity: 0 !important; }
  canvas, video { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  video { object-fit: fill; pointer-events: none; }
  #gpu { pointer-events: none; }
  .native-picture #gpu { visibility: hidden; }
  #pointer { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%; pointer-events: none;
    border: 2px solid rgba(255,255,255,0.95); box-shadow: 0 0 0 1px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.35);
    opacity: 0; transition: opacity 0.3s; will-change: transform; }
  #pointer.on { opacity: 1; transition: none; }
  #pointer.pressed { background: rgba(255,255,255,0.4); }
  #pointer.own { border: 0; border-radius: 0; box-shadow: none; background: transparent center / 100% 100% no-repeat; }
  #stage.own { cursor: none; }
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
  .choice span { display: block; font-size: calc(12px * var(--text-scale, 1)); color: rgba(255,255,255,0.62); }
  #widths, #pacing, #clipboard, #privacy, #langs { padding: 0 6px 6px; }
  #widths .group, #pacing .group, #clipboard .group, #privacy .group, #langs .group { padding-top: 4px; }
  #pacing .tiles, .tiles.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tiles.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  #status { padding: 2px 10px 10px; font-size: calc(12px * var(--text-scale, 1)); line-height: 1.5;
    color: rgba(255,255,255,0.5); white-space: pre-line; font-variant-numeric: tabular-nums; }
  #toast { position: absolute; left: 50%; max-width: min(86vw, 420px); width: max-content; transform: translateX(-50%); padding: 10px 16px; border-radius: 18px;
    font-size: calc(13px * var(--text-scale, 1)); text-align: center; color: rgba(255,255,255,0.94); pointer-events: none; opacity: 0; transition: opacity 0.3s; }
  #toast.on { opacity: 1; }
  #keys { position: absolute; z-index: 4; left: 0; right: 0; height: 56px; display: flex; align-items: center; gap: 4px; padding: 0 5px; overflow-x: auto; overscroll-behavior: contain; touch-action: pan-x;
    background: rgba(28,28,30,0.96); border-top: 0.5px solid rgba(255,255,255,0.14); }
  .key { flex: 1 0 44px; min-width: 44px; height: calc(44px * var(--text-scale, 1)); border-radius: 8px; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.13); color: #fff; font-size: calc(15px * var(--text-scale, 1)); font-variant-numeric: tabular-nums; }
  .key.word { font-size: calc(12px * var(--text-scale, 1)); }
  .key svg { width: 20px; height: 20px; }
  .key:active { background: rgba(255,255,255,0.3); }
  .key.on { background: #fff; color: #111; }
  #sheet { position: absolute; z-index: 4; display: flex; flex-direction: column; border-radius: 24px; overflow: hidden; }
  #sheethead { display: flex; align-items: center; gap: 2px; padding: 8px 6px 4px 10px; }
  #compose { flex: 1; min-width: 0; min-height: 44px; margin-right: 4px; border-radius: 20px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
    background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.62); font-size: calc(14px * var(--text-scale, 1)); white-space: nowrap; }
  #compose:active { background: rgba(255,255,255,0.2); }
  #compose svg { width: 19px; height: 19px; flex: none; }
  #actions, #maker { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; padding: 0 10px 12px; }
  .group { display: flex; align-items: center; justify-content: space-between; padding: 12px 4px 7px; font-size: calc(12px * var(--text-scale, 1)); color: rgba(255,255,255,0.55); }
  .group i { display: inline-flex; align-items: center; min-width: 44px; min-height: 44px; font-style: normal; padding: 4px 8px; margin: -4px -4px -4px 0; border-radius: 10px; color: rgba(255,255,255,0.86); }
  .group i:active { background: rgba(255,255,255,0.16); }
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .tiles.six { grid-template-columns: repeat(auto-fit, minmax(calc(44px * var(--text-scale, 1)), 1fr)); margin-bottom: 6px; }
  #sheet.narrow .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  #sheet.folded .tiles:not(.six) { grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); }
  #sheet.narrow .tiles.six { grid-template-columns: repeat(auto-fit, minmax(calc(44px * var(--text-scale, 1)), 1fr)); }
  .tile { position: relative; min-height: 52px; padding: 6px 3px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.1); text-align: center; }
  .tile b { max-width: 100%; overflow: hidden; white-space: normal; overflow-wrap: anywhere; font-weight: 500; font-size: calc(13px * var(--text-scale, 1)); line-height: 1.3; }
  .tile span { font-size: calc(11px * var(--text-scale, 1)); line-height: 1.3; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; }
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
