const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

app.setPath("userData", join(process.argv[2], "profile"));
// This checks input and menus, so CI does not need a physical GPU or an active Windows desktop.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let window, server, menu;
let count = 0;
const contexts = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:20px}textarea,input,p,button{display:block;margin:16px;width:400px;height:44px}</style>
<p id="text">Copyable conversation text</p><textarea id="editable">editable original</textarea>
<textarea id="readonly" readonly>readonly original</textarea><input id="password" type="password" value="fixture-password">
<button id="product">Product row</button><iframe sandbox="allow-scripts" src="http://localhost:PORT/preview"></iframe>
<script>document.querySelector('#product').oncontextmenu=event=>{event.preventDefault();window.productHandled=true;};</script>`;

app.whenReady().then(async () => {
  app.dock?.hide();
  const build = process.env.LINKSHELL_EDITING_MENU_BUILD || join(__dirname, "../../dist");
  const { installEditingContextMenu } = await import(pathToFileURL(join(build, "main/editing-context-menu.js")));
  const { WorkspacePolicy } = await import(pathToFileURL(join(build, "main/policy.js")));
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(request.url === "/preview"
      ? '<input id="preview" value="preview original">'
      : html.replaceAll("PORT", String(server.address().port)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const policy = new WorkspacePolicy(new URL(origin));
  ipcMain.on("linkshell:boot", (event) => {
    event.returnValue = policy.allowsBridge(event.senderFrame?.url, event.senderFrame === event.sender.mainFrame)
      ? { appearance: "light", visible: false, platform: process.platform } : undefined;
  });
  window = new BrowserWindow({ show: false, width: 800, height: 800, webPreferences: {
    preload: join(build, "preload/preload.cjs"), offscreen: true, contextIsolation: true,
    sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false,
  } });
  // Build real Electron menus from real Chromium contexts, without displaying a fixture on the desktop.
  // Native first-responder action execution still requires a visible desktop interaction check.
  Menu.prototype.popup = function () { menu = this; count++; };
  installEditingContextMenu(window.webContents, () => window, () => policy.isTrusted(window.webContents.getURL()));
  window.webContents.on("context-menu", (_event, params) => contexts.push(params));
  await window.loadURL(origin);
  const run = (code) => window.webContents.executeJavaScript(code, true);
  const open = async (id, select = true) => {
    const point = await run(`(() => {
      const element = document.getElementById(${JSON.stringify(id)}); element.focus();
      if (${select}) { if (element.select) element.select(); else {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      } }
      const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x + 20), y: Math.round(rect.y + 20) };
    })()`);
    menu = undefined;
    const before = count;
    window.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...point });
    const deadline = Date.now() + 2000;
    while (count === before && Date.now() < deadline && id !== "product") await pause(10);
    if (id === "product") await pause(100);
    return before;
  };
  const item = (role) => menu?.items.find((entry) => entry.role === role);
  await open("text");
  assert.equal(item("copy")?.enabled, true, "selected conversation text can be copied");
  assert.equal(item("cut"), undefined, "conversation selection cannot be cut");
  await open("editable");
  assert.equal(item("cut")?.enabled, true);
  assert.equal(item("copy")?.enabled, true);
  assert.equal(item("paste")?.enabled, contexts.at(-1).editFlags.canPaste);
  assert.equal(item("selectall")?.enabled, true);
  await window.webContents.insertText("fixture edit");
  await open("editable");
  assert.equal(item("undo")?.enabled, true, "native input edits enable undo");
  await open("readonly");
  assert.equal(item("copy")?.enabled, true);
  assert.equal(item("cut"), undefined);
  assert.equal(item("paste"), undefined);
  await open("password");
  assert.equal(item("copy")?.enabled, false, "password cannot be copied");
  assert.equal(item("cut")?.enabled, false, "password cannot be cut");
  const before = await open("product", false);
  assert.equal(count, before, "product menu must not also open the editing menu");
  assert.equal(await run("window.productHandled"), true);
  const frame = window.webContents.mainFrame.frames.find((entry) => entry.url.includes("/preview"));
  assert.ok(frame, "isolated preview loaded");
  assert.equal(await frame.executeJavaScript("typeof window.linkshellDesktop"), "undefined");
  assert.equal(policy.allowsBridge(frame.url, false), false);
  console.log("PASS native editing contexts");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => { window?.destroy(); server?.close(); app.quit(); });
