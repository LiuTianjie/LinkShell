// Imported only into copied test bundles by scripts/update-e2e.mjs.
import { app, dialog, session } from 'electron';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const root = process.env.LINKSHELL_QA_ROOT;
const profile = process.env.LINKSHELL_QA_PROFILE;
const token = process.env.LINKSHELL_QA_TOKEN;
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !root || !profile || !token
  || !existsSync(join(root, 'qa-owner')) || readFileSync(join(root, 'qa-owner'), 'utf8') !== token
  || relative(root, profile).startsWith('..') || isAbsolute(relative(root, profile))) {
  throw new Error('The Windows update test hook requires its disposable CI fixture.');
}
const origin = new URL(process.env.LINKSHELL_QA_ORIGIN);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Fixture must use loopback HTTP.');
const record = (event, detail = {}) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ event, pid: process.pid, at: Date.now(), ...detail }) + '\n');
app.setPath('userData', profile);
rmSync(join(profile, 'DevToolsActivePort'), { force: true });
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
record('app-start', { version: app.getVersion() });

// Observe native confirmation; retain the real dialog and the user's UIAutomation answer.
const showMessageBox = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  record('dialog', { message: options.message, buttons: options.buttons });
  const result = await showMessageBox(...args);
  record('dialog-result', { response: result.response });
  return result;
};
app.whenReady().then(() => {
  const installer = 'https://github.com/LiuTianjie/LinkShell/releases/download/desktop-v65530.0.2/LinkShell-Setup-65530.0.2-windows-x64.exe';
  const routes = new Map([
    ['https://api.github.com/repos/LiuTianjie/LinkShell/releases?per_page=100', '/releases'],
    [installer, '/installer'], [installer + '.sha256', '/checksum'],
  ]);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://api.github.com/repos/LiuTianjie/LinkShell/*', 'https://github.com/LiuTianjie/LinkShell/releases/download/*'] }, (details, done) => {
    const route = routes.get(details.url);
    record('fixture-request', { route: route ?? 'rejected' });
    done(route ? { redirectURL: origin.origin + route } : { cancel: true });
  });
});
