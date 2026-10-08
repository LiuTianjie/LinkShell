/** The sticky view shifts by keyboardHeight - keyboardOffset; reserve that space only once. */
export function composerViewport(height: number, keyboardHeight: number, bottomInset: number, accessoryHeight: number, keyboardOffset = bottomInset) {
  const available = Math.max(0, height - Math.max(0, keyboardHeight - keyboardOffset) - accessoryHeight);
  const compact = available - bottomInset < 220;
  const textMaxHeight = compact ? 44 : Math.max(44, Math.min(150, Math.floor((available - bottomInset) * 0.3)));
  return { available, compact, textMaxHeight };
}

/** Keep conversation context above closed-keyboard cards; a short keyboard viewport needs its full budget. */
export function composerCardsHeight(available: number, inputHeight: number, bottomInset: number, keyboardHeight = 0) {
  const remaining = Math.max(0, available - inputHeight - bottomInset - 22);
  return keyboardHeight > 0 ? remaining : Math.min(remaining, Math.max(0, available * 0.6));
}

/** Sticky positioning already cancels safe-bottom padding; only the pinned input and its gaps occlude cards. */
export function composerCardsKeyboardOffset(inputHeight: number) {
  return inputHeight + 8 + 8 + 12;
}
