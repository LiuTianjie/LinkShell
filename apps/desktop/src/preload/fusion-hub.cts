import { contextBridge, ipcRenderer } from "electron";

// Fusion's hidden page (fusion.html): messages to and from its hub in the main process, which
// accepts them only from this page's own webContents on the trusted origin.
contextBridge.exposeInMainWorld("linkshellFusionHub", {
  send(message: unknown) {
    if (!message || typeof message !== "object") return;
    ipcRenderer.send("linkshell:fusion-hub", message);
  },
  onMessage(listener: (message: unknown) => void) {
    if (typeof listener !== "function") return;
    ipcRenderer.on("linkshell:fusion-hub", (_event, message: unknown) => listener(message));
  },
  platform: process.platform,
});
