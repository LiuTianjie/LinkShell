// Imported only into the disposable copied Electron bundle by model-ui-e2e.mjs.
import { app } from 'electron';
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
app.setPath('userData', profile);
rmSync(join(profile, 'DevToolsActivePort'), { force: true });
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
appendFileSync(join(root, 'app-events.jsonl'), JSON.stringify({ event: 'app-start', pid: process.pid }) + '\n');
