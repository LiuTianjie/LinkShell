import { contextBridge, ipcRenderer } from "electron";

// The same messages the WKWebView and WebView2 shells take: `{action, …}` in, DOM events out.
// The main process accepts them only from the trusted origin's main frame.
//
// The page runs in its own world (contextIsolation), so nothing set on `window` here is visible to
// it: the window's state reaches the page through the bridge below and as the same DOM events.
const boot = ipcRenderer.sendSync("linkshell:boot") as { appearance: string; visible: boolean; platform: string; zoom?: number } | undefined;

let appearance = boot?.appearance;
let visible = boot?.visible !== false;
type Flush = () => Promise<{ saved: boolean; pending: number }>;
let flush: Flush | undefined;

contextBridge.exposeInMainWorld("linkshellDesktop", {
  postMessage(message: unknown) {
    if (!message || typeof message !== "object") return;
    ipcRenderer.send("linkshell:message", message);
  },
  /** Electron draws the window: the page can leave room for the traffic lights. */
  shell: "electron",
  platform: boot?.platform ?? process.platform,
  /** The window's appearance setting now (system, light or dark), for a page that mounts later. */
  appearance: () => appearance,
  /** Whether the window is on screen now. */
  visible: () => visible,
  /** The page's save barrier: what the main process waits for before the window goes. */
  setFlush(next: unknown) {
    flush = typeof next === "function" ? (next as Flush) : undefined;
  },
});

ipcRenderer.on("linkshell:event", (_event, name: unknown, detail: unknown) => {
  if (typeof name !== "string" || !name.startsWith("linkshell-")) return;
  if (name === "linkshell-desktop-visibility") visible = (detail as { visible?: boolean })?.visible !== false;
  if (name === "linkshell-desktop-appearance") appearance = (detail as { appearance?: string })?.appearance ?? appearance;
  window.dispatchEvent(new CustomEvent(name, { detail }));
});

ipcRenderer.on("linkshell:flush", async (_event, nonce: unknown) => {
  let result = { saved: true, pending: 0 };
  try { if (flush) result = await flush(); }
  catch { result = { saved: false, pending: 1 }; }
  ipcRenderer.send("linkshell:flushed", nonce, result);
});
