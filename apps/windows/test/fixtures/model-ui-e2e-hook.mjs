// Imported only into the disposable copied Electron bundle by model-ui-e2e.mjs.
import { app, BrowserWindow, clipboard, ipcMain } from 'electron';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const root = process.env.LINKSHELL_QA_ROOT;
const profile = process.env.LINKSHELL_QA_PROFILE;
const token = process.env.LINKSHELL_QA_TOKEN;
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !root || !profile || !token
  || !existsSync(join(root, 'qa-owner')) || readFileSync(join(root, 'qa-owner'), 'utf8') !== token
  || relative(root, profile).startsWith('..') || isAbsolute(relative(root, profile))) {
  throw new Error('The model UI hook requires its disposable Windows CI fixture.');
}
const record = event => appendFileSync(join(root, 'app-events.jsonl'), JSON.stringify({ pid: process.pid, ...event }) + '\n');
let savedClipboard, quitRestore;
let clipboardQueue = Promise.resolve(), pendingClipboard = 0, clipboardClosing = false;
async function plainClipboardSnapshot() {
  const items = await clipboard.read();
  if (items.length === 0 || (items.length === 1 && items[0].types.length === 0)) return { empty: true, text: '' };
  if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'text/plain') {
    throw new Error('Clipboard has non-text formats or multiple items; refusing to replace them.');
  }
  // Materialize this read's payload before a fixture write can replace the system clipboard.
  return { empty: false, text: await (await items[0].getType('text/plain')).text() };
}
async function restoreClipboard() {
  if (!savedClipboard) return { restored: true, changed: false };
  const saved = savedClipboard;
  if (saved.empty) clipboard.clear();
  else await clipboard.writeText(saved.text);
  const actual = await plainClipboardSnapshot();
  const restored = actual.empty === saved.empty && actual.text === saved.text;
  if (!restored) throw new Error('The original clipboard could not be restored.');
  savedClipboard = undefined;
  record({ event: 'clipboard-restored', restored: true });
  return { restored: true, changed: true };
}
// The original clipboard stays in this process only. This bridge never runs an editing command.
ipcMain.on('linkshell:message', (event, message) => {
  if (message?.action !== 'qaClipboard' || message.token !== token || !message.id
    || event.senderFrame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender)) return;
  if (clipboardClosing && message.operation !== 'restore') {
    event.sender.send('linkshell:event', 'linkshell-qa-clipboard', { id: message.id, error: 'Clipboard fixture is closing.' });
    return;
  }
  pendingClipboard++;
  clipboardQueue = clipboardQueue.catch(() => {}).then(async () => {
    let result, error;
    try {
      switch (message.operation) {
        case 'snapshot': {
          for (const method of ['read', 'readText', 'write', 'writeText', 'has', 'clear']) {
            if (typeof clipboard[method] !== 'function') throw new Error(`Missing Electron clipboard.${method} API.`);
          }
          if (!savedClipboard) savedClipboard = await plainClipboardSnapshot();
          result = { saved: true, api: { electron: process.versions.electron, read: 'ClipboardItem[] Promise', readText: 'Promise', writeText: 'Promise', clear: 'sync' } }; break;
        }
        case 'read':
          if (!savedClipboard) throw new Error('Snapshot the clipboard before inspecting it.');
          result = { text: await clipboard.readText() }; break;
        case 'write':
          if (!savedClipboard || typeof message.text !== 'string' || message.text.length > 1024) throw new Error('Invalid clipboard fixture.');
          await clipboard.writeText(message.text); result = { written: await clipboard.readText() === message.text }; break;
        case 'restore': result = await restoreClipboard(); break;
        default: throw new Error('Unknown clipboard fixture operation.');
      }
    } catch (failure) { error = failure.message; }
    finally { pendingClipboard--; }
    if (!event.sender.isDestroyed()) event.sender.send('linkshell:event', 'linkshell-qa-clipboard', { id: message.id, result, error });
  });
  void clipboardQueue.catch(() => {});
});
app.on('web-contents-created', (_event, web) => {
  // Passive evidence that the real right click reached Chromium. Menu.popup and native roles remain untouched.
  web.on('context-menu', (_event, params) => record({ event: 'editing-context', editable: params.isEditable,
    canCopy: params.editFlags.canCopy, canCut: params.editFlags.canCut, canPaste: params.editFlags.canPaste, canUndo: params.editFlags.canUndo }));
});
app.on('before-quit', event => {
  if (!savedClipboard && pendingClipboard === 0) return;
  event.preventDefault();
  clipboardClosing = true;
  if (quitRestore) return;
  // The harness explicitly awaits restore before taskkill; this covers ordinary native quit too.
  quitRestore = clipboardQueue.catch(() => {}).then(() => restoreClipboard());
  clipboardQueue = quitRestore;
  void quitRestore.then(() => { quitRestore = undefined; app.quit(); }, () => {
    record({ event: 'clipboard-restored', restored: false });
    quitRestore = undefined;
  });
});
app.setPath('userData', profile);
rmSync(join(profile, 'DevToolsActivePort'), { force: true });
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
record({ event: 'app-start' });
