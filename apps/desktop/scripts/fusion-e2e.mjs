// Fusion's local half in the desktop app (FusionElectronHub + fusion.html) against the host's
// remote with its simulated platform, end to end on one computer: TLS-PSK control, one WebRTC
// connection, crop metadata from the SEI, a window drawn, input back to the remote window, a
// resize acknowledged, a close (docs/v2/fusion.md §8.4).
//
//   pnpm --filter @linkshell/desktop-ui build && pnpm --filter @linkshell/host build && pnpm --filter @linkshell/desktop exec tsc -p tsconfig.json
//   electron apps/desktop/scripts/fusion-e2e.mjs      (needs ffmpeg with libx264)
import { app, BrowserWindow, ipcMain } from "electron";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { FusionElectronHub } = await import(join(root, "apps/desktop/dist/main/fusion/electron-hub.js"));
const { FusionNodeRemote } = await import(join(root, "packages/host/dist/host/src/fusion/remote.js"));
const { SimulatedFusionPlatform, SIMULATED_APP } = await import(join(root, "packages/host/dist/host/src/fusion/simulated.js"));

const assets = join(root, "apps/desktop-ui/dist");
const home = mkdtempSync(join(tmpdir(), "fusion-e2e-"));
const log = (line) => console.log(line);
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(stepMs);
  }
}

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const file = join(assets, path === "/" ? "index.html" : path);
  if (!file.startsWith(assets) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const platform = new SimulatedFusionPlatform();
  const remote = new FusionNodeRemote(platform, { log, port: 0 });
  const token = `e2e-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const port = await remote.issue(token, []);
  const hub = new FusionElectronHub({
    computerKey: "e2e#simulated", name: "模拟远端", slug: "e2e000000000", home,
    pageURL: () => new URL(`${origin}/`),
    preload: join(root, "apps/desktop/dist/preload/fusion-hub.cjs"),
    relaunch: { executable: process.execPath, args: () => [] },
    isTrusted: (url) => url.startsWith(origin),
    log,
  });
  ipcMain.on("linkshell:fusion-hub", (event, body) => hub.fromPage(event.sender, body));
  hub.connect("127.0.0.1", port, token, SIMULATED_APP);

  const win = await until(async () => BrowserWindow.getAllWindows().find((w) => w.isVisible() && w.getTitle().includes("测试画面")), 20_000);
  check("a frameless window opens for the remote window", Boolean(win));
  if (win) {
    const picture = await until(async () => {
      const state = await win.webContents.executeJavaScript(`(() => { const v = document.querySelector("video"); return v && { w: v.videoWidth, h: v.videoHeight, width: v.style.width, transform: v.style.transform }; })()`);
      return state && state.w > 0 && state.width ? state : undefined;
    }, 20_000);
    check("its picture is decoded and placed by the SEI crop", Boolean(picture), picture ? JSON.stringify(picture) : "no frames");
    const status = hub.status();
    check("the hub reports a connected session with the app's window", status.connected === true && status.windowCounts[SIMULATED_APP] === 1, JSON.stringify({ connected: status.connected, counts: status.windowCounts }));

    const before = platform.inputs.length;
    const bounds = win.getBounds();
    win.focus();
    win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) });
    win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2), button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2), button: "left", clickCount: 1 });
    const clicked = await until(async () => platform.inputs.slice(before).find((i) => i.event.t === "down"), 8_000);
    check("a click reaches the remote window it was made in", Boolean(clicked) && "window" in clicked.target, clicked ? JSON.stringify(clicked) : `inputs: ${JSON.stringify(platform.inputs.slice(before))}`);
    const moved = platform.inputs.slice(before).filter((i) => i.event.t === "move").pop();
    check("the click's position is a fraction of the remote window (its middle here is its middle there)",
      Boolean(moved) && Math.abs(moved.event.x - 0.5) < 0.05 && Math.abs(moved.event.y - 0.5) < 0.05, moved ? JSON.stringify(moved.event) : "no move");

    win.setBounds({ ...win.getBounds(), width: 700, height: 500 });
    const resized = await until(async () => platform["windows"]?.find?.((w) => w.rect.w === 700) ?? undefined, 5_000);
    check("a resize here resizes the remote window", Boolean(resized));

    win.close();
    const closed = await until(async () => win.isDestroyed(), 8_000);
    check("closing it here asks the remote, and the window goes when the remote closes it", Boolean(closed));

    // The next window reuses the closed one's transceiver: its picture must still arrive (the
    // receiver drops packets that look older than what the transceiver last carried).
    hub.launchApp(SIMULATED_APP);
    const second = await until(async () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== win && w.isVisible() && w.getTitle().includes("测试画面")), 20_000);
    const secondPicture = second && await until(async () => {
      const state = await second.webContents.executeJavaScript(`(() => { const v = document.querySelector("video"); return v && { w: v.videoWidth, width: v.style.width, frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0 }; })()`);
      return state && state.w > 0 && state.width && state.frames > 5 ? state : undefined;
    }, 20_000);
    check("a window opened after another closed gets its picture on the reused transceiver", Boolean(secondPicture), secondPicture ? JSON.stringify(secondPicture) : "no frames");
  }
  hub.stop();
  remote.stop();
  server.close();
  rmSync(home, { recursive: true, force: true });
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
setTimeout(() => { console.log("FAIL timed out"); app.exit(2); }, 90_000).unref();
