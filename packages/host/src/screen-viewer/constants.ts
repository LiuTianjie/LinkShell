/** Final for a viewer: falling back to another path would only take the screen back. The app matches it too. */
export const SCREEN_TAKEN = "屏幕画面被另一台设备接手了";

/** Final too: a relayed picture no one used for a while was ended to save the relay's traffic. Reconnecting starts it again. */
export const SCREEN_IDLE = "长时间没有操作，画面已断开";

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  view: icon('<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
  trackpad: icon('<path d="M6.5 3.5v15l4-3.4 2.6 5.4 2.5-1.2-2.6-5.3 5-.6Z"/>'),
  touch: icon('<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.6"/>'),
  keyboard: icon('<rect x="2.5" y="6" width="19" height="12" rx="2.6"/><path d="M6.6 10h.01M10.2 10h.01M13.8 10h.01M17.4 10h.01M6.6 14h.01M17.4 14h.01M10 14h4"/>'),
  fit: icon('<circle cx="10.5" cy="10.5" r="6.2"/><path d="m15.2 15.2 5 5M8 10.5h5"/>'),
  expand: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  shrink: icon('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  down: icon('<path d="m6 9.5 6 6 6-6"/>'),
  quick: icon('<path d="M13 2.8 5.2 13.6H11l-1 7.6 7.8-10.8H12Z"/>'),
  compose: icon('<path d="M4 5h16v10.5H9.5L5.5 19v-3.5H4Z"/><path d="M8 9h8M8 12h5"/>'),
  clipboard: icon('<rect x="8" y="3" width="8" height="3.6" rx="1.2"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><path d="M9 12h6M9 16h4"/>'),
  privacy: icon('<path d="M12 3 5 6v5.5c0 4.6 3 8.5 7 9.5 4-1 7-4.9 7-9.5V6l-7-3Z"/><path d="M9.5 12 11 13.5 14.8 9.8"/>'),
  soundOn: icon('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.4 6a8.5 8.5 0 0 1 0 12"/>'),
  soundOff: icon('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m21 9.5-5 5M16 9.5l5 5"/>'),
  info: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v6M12 7.2v.6"/>'),
  close: icon('<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'),
};
