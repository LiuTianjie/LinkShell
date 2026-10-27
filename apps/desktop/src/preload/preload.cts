import { contextBridge, ipcRenderer } from "electron";

// The same messages the WKWebView and WebView2 shells take: `{action, …}` in, DOM events out.
// The main process accepts them only from the trusted origin's main frame.
const boot = ipcRenderer.sendSync("linkshell:boot") as { appearance: string; visible: boolean; platform: string; zoom?: number } | undefined;

contextBridge.exposeInMainWorld("linkshellDesktop", {
  postMessage(message: unknown) {
    if (!message || typeof message !== "object") return;
    ipcRenderer.send("linkshell:message", message);
  },
  /** Electron draws the window: the page can leave room for the traffic lights. */
  shell: "electron",
  platform: boot?.platform ?? process.platform,
});

if (boot) {
  // Before first paint, so the page never flashes the other theme or a hidden state.
  (window as unknown as Record<string, unknown>).__LINKSHELL_DESKTOP_APPEARANCE__ = boot.appearance;
  (window as unknown as Record<string, unknown>).__LINKSHELL_DESKTOP_VISIBLE__ = boot.visible;
  (window as unknown as Record<string, unknown>).__LINKSHELL_DESKTOP_SHELL__ = "electron";
}

ipcRenderer.on("linkshell:event", (_event, name: unknown, detail: unknown) => {
  if (typeof name !== "string" || !name.startsWith("linkshell-")) return;
  if (name === "linkshell-desktop-visibility") (window as unknown as Record<string, unknown>).__LINKSHELL_DESKTOP_VISIBLE__ = (detail as { visible?: boolean })?.visible !== false;
  if (name === "linkshell-desktop-appearance") (window as unknown as Record<string, unknown>).__LINKSHELL_DESKTOP_APPEARANCE__ = (detail as { appearance?: string })?.appearance;
  window.dispatchEvent(new CustomEvent(name, { detail }));
});

ipcRenderer.on("linkshell:flush", async (_event, nonce: unknown) => {
  const flush = (window as unknown as { __LINKSHELL_DESKTOP_FLUSH__?: () => Promise<{ saved: boolean; pending: number }> }).__LINKSHELL_DESKTOP_FLUSH__;
  let result = { saved: true, pending: 0 };
  try { if (typeof flush === "function") result = await flush(); }
  catch { result = { saved: false, pending: 1 }; }
  ipcRenderer.send("linkshell:flushed", nonce, result);
});
