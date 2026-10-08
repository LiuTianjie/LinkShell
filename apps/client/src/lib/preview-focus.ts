/** Let WebKit reveal the same editor after its native viewport has finished resizing. */
export const revealPreviewFocus = String.raw`
(() => {
  const editor = document.activeElement;
  if (!editor || editor.disabled || editor.readOnly) return;
  const editable = editor.isContentEditable || editor.tagName === "TEXTAREA" ||
    editor.tagName === "INPUT" && !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "hidden"].includes(editor.type);
  if (!editable) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (document.activeElement !== editor || !editor.isConnected) return;
    editor.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  }));
})(); true;
`;
