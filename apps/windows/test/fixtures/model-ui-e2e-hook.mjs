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
let savedClipboard;
function restoreClipboard() {
  if (!savedClipboard) return { restored: true, changed: false };
  const saved = savedClipboard;
  saved.empty ? clipboard.clear() : clipboard.writeText(saved.text);
  const formats = clipboard.availableFormats();
  const restored = saved.empty ? formats.length === 0 : formats.every(format => format === 'text/plain') && clipboard.readText() === saved.text;
  if (!restored) throw new Error('The original clipboard could not be restored.');
  savedClipboard = undefined;
  record({ event: 'clipboard-restored', restored: true });
  return { restored: true, changed: true };
}
// The original clipboard stays in this process only. This bridge never runs an editing command.
ipcMain.on('linkshell:message', (event, message) => {
  if (message?.action !== 'qaClipboard' || message.token !== token || !message.id
    || event.senderFrame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender)) return;
  let result, error;
  try {
    switch (message.operation) {
      case 'snapshot': {
        if (!savedClipboard) {
          const formats = clipboard.availableFormats();
          if (formats.some(format => format !== 'text/plain')) throw new Error('Clipboard has non-text formats; refusing to replace them.');
          savedClipboard = { empty: formats.length === 0, text: clipboard.readText() };
        }
        result = { saved: true }; break;
      }
      case 'read':
        if (!savedClipboard) throw new Error('Snapshot the clipboard before inspecting it.');
        result = { text: clipboard.readText() }; break;
      case 'write':
        if (!savedClipboard || typeof message.text !== 'string' || message.text.length > 1024) throw new Error('Invalid clipboard fixture.');
        clipboard.writeText(message.text); result = { written: clipboard.readText() === message.text }; break;
      case 'restore': result = restoreClipboard(); break;
      default: throw new Error('Unknown clipboard fixture operation.');
    }
  } catch (failure) { error = failure.message; }
  event.sender.send('linkshell:event', 'linkshell-qa-clipboard', { id: message.id, result, error });
});
app.on('web-contents-created', (_event, web) => {
  // Passive evidence that the real right click reached Chromium. Menu.popup and native roles remain untouched.
  web.on('context-menu', (_event, params) => record({ event: 'editing-context', editable: params.isEditable,
    canCopy: params.editFlags.canCopy, canCut: params.editFlags.canCut, canPaste: params.editFlags.canPaste, canUndo: params.editFlags.canUndo }));
});
app.on('will-quit', () => { try { restoreClipboard(); } catch { record({ event: 'clipboard-restored', restored: false }); } });
app.setPath('userData', profile);
rmSync(join(profile, 'DevToolsActivePort'), { force: true });
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
record({ event: 'app-start' });
