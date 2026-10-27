#!/usr/bin/env node
// Development only: a busy, always-moving window on the Mac's built-in display, so the screen
// sent to a viewer has something to encode at its full frame rate. Close it with ⌘Q.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electron = createRequire(import.meta.url)("electron");
const dir = mkdtempSync(join(tmpdir(), "linkshell-motion-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "linkshell-motion", main: "main.cjs" }));
writeFileSync(join(dir, "main.cjs"), `
const { app, BrowserWindow, screen } = require("electron");
app.whenReady().then(() => {
  const display = screen.getAllDisplays().find((d) => d.internal) ?? screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const win = new BrowserWindow({ x: x + 40, y: y + 40, width: Math.round(width * 0.7), height: Math.round(height * 0.7), title: "LinkShell motion" });
  win.loadURL("data:text/html," + encodeURIComponent(\`<body style="margin:0;background:#111;overflow:hidden"><canvas></canvas><script>
    const c = document.querySelector("canvas"), g = c.getContext("2d");
    const size = () => { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio; }; size(); onresize = size;
    const draw = (t) => { const w = c.width, h = c.height; g.fillStyle = "hsl(" + (t / 20 % 360) + " 40% 12%)"; g.fillRect(0, 0, w, h);
      g.font = (40 * devicePixelRatio) + "px -apple-system"; g.fillStyle = "#fff";
      for (let i = 0; i < 18; i++) g.fillText("LinkShell 120Hz " + Math.round(t) + " ms", ((t / 3 + i * 211) % (w + 600)) - 600, (i + 1) * h / 19);
      for (let i = 0; i < 40; i++) { g.fillStyle = "hsl(" + (i * 9 + t / 10) + " 80% 60%)"; g.fillRect((t / 2 + i * 97) % w, (Math.sin(t / 300 + i) + 1) * h / 2.2, 60, 60); }
      requestAnimationFrame(draw); }; requestAnimationFrame(draw);
  <\\/script>\`));
});`);
const child = spawn(electron, [dir], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
