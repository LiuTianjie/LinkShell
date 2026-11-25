import { contextBridge, ipcRenderer } from "electron";

// The page runs in its own isolated world (contextIsolation + sandbox).
// Request/response RPC uses native Electron `ipcRenderer.invoke("linkshell:invoke")`;
// one-way UI notifications and main->renderer events remain cleanly separated.
const boot = ipcRenderer.sendSync("linkshell:boot") as
  | { appearance: string; visible: boolean; platform: string; opaqueWindow?: boolean; zoom?: number }
  | undefined;

let appearance = boot?.appearance;
let visible = boot?.visible !== false;
const initialOpaqueWindow = boot?.opaqueWindow === true;
type Flush = () => Promise<{ saved: boolean; pending: number }>;
let flush: Flush | undefined;

async function invokeMain<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const reply = (await ipcRenderer.invoke("linkshell:invoke", { method, params })) as
    | { ok: true; result: T }
    | { ok: false; error: string };
  if (!reply || !reply.ok) throw new Error(reply?.error || "操作失败，请重试");
  return reply.result;
}

contextBridge.exposeInMainWorld("linkshellDesktop", {
  /** Native Electron async RPC (replaces legacy postMessage + CustomEvent reply multiplexing). */
  invoke<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return invokeMain<T>(method, params);
  },
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
  /** Whether the user configured an opaque window surface, known before the first paint. */
  opaqueWindow: () => initialOpaqueWindow,
  /** The page's save barrier: what the main process waits for before the window goes. */
  setFlush(next: unknown) {
    flush = typeof next === "function" ? (next as Flush) : undefined;
  },
  setSystemShortcutCapture(enabled: boolean): Promise<boolean> {
    return invokeMain<boolean>("setSystemShortcutCapture", { enabled: Boolean(enabled) }).catch(() => false);
  },
  startLanDiscovery(): Promise<unknown[]> {
    return invokeMain<unknown[]>("startLanDiscovery", {}).catch(() => []);
  },
  stopLanDiscovery(): Promise<void> {
    return invokeMain("stopLanDiscovery", {}).then(() => undefined, () => undefined);
  },
  getLanHosts(): Promise<unknown[]> {
    return invokeMain<unknown[]>("getLanHosts", {}).catch(() => []);
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
