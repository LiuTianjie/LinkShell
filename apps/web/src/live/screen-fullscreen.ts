/**
 * The remote screen's full screen in the desktop window: the window goes full screen and only the
 * picture fills it. One owner at a time; the window's answer decides what is shown, not the wish,
 * so the picture never sits behind a page that is still full screen (or the other way round).
 *
 *   wanted   what the screen last asked for (its button, Esc, leaving the page)
 *   owns     this screen asked for the window's full screen and has not let it go
 *   window   whether the window says it is full screen
 *   shown    whether the screen fills the window with only the picture now
 */
export interface FullscreenState { wanted: boolean; owns: boolean; window: boolean }

export const idleFullscreen: FullscreenState = { wanted: false, owns: false, window: false };

/** The screen fills the window only while it owns a window that is really full screen. */
export const fullscreenShown = (state: FullscreenState) => state.owns && state.window;

/** The screen asks to go into full screen or out of it. `request` is what to ask the window for. */
export function askFullscreen(state: FullscreenState, enabled: boolean): { next: FullscreenState; request?: boolean } {
  if (enabled) return { next: { ...state, wanted: true, owns: true }, request: state.window ? undefined : true };
  if (!state.owns && !state.wanted) return { next: state };
  // Leaving takes the picture out at once; the window follows when it can.
  return { next: { ...state, wanted: false, owns: false }, request: state.window ? false : undefined };
}

/**
 * The window says where it is. Entering keeps the screen's ownership if it asked. Entering by the
 * window's own control (the green button, ⌃⌘F in the menu) is the screen's too while it is the
 * page on show (`adopt`): there, full screen means the remote picture. Leaving, however it
 * happened, ends the screen's full screen.
 */
export function windowFullscreen(state: FullscreenState, fullscreen: boolean, adopt = false): FullscreenState {
  if (!fullscreen) return { wanted: false, owns: false, window: false };
  const owns = (state.wanted && state.owns) || (adopt && !state.window);
  return { wanted: owns, owns, window: true };
}
