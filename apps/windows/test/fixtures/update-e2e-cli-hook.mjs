// Imported only into copied CI bundles; observe production update commands without replacing them.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { standaloneBundle } from './utils/standalone.js';

const root = process.env.LINKSHELL_QA_ROOT, home = process.env.LINKSHELL_HOME;
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !root || !home
  || readFileSync(join(root, 'qa-owner'), 'utf8') !== process.env.LINKSHELL_QA_TOKEN) throw new Error('CLI update observer requires its disposable CI fixture.');
const action = process.argv[process.argv.indexOf('--action') + 1];
const read = name => { try { return readFileSync(join(home, name), 'utf8'); } catch { return undefined; } };
const json = name => { try { return JSON.parse(read(name)); } catch { return undefined; } };
const physical = path => { try { return realpathSync.native(path).toLowerCase(); } catch { return null; } };
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
if (process.argv.includes('desktop') && ['prepare-update', 'recover-update', 'stop-update-host'].includes(action)) {
  const initialHostPID = Number(read('host.pid')) || null;
  const record = (event, exitCode) => {
    const hostPID = Number(read('host.pid')) || null, launch = json('host-launch.json'), marker = json('desktop-update.json');
    const app = standaloneBundle(), owner = launch?.pid === hostPID ? launch.appBundle : undefined;
    appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ event, pid: process.pid, at: Date.now(), action, exitCode,
      initialHostPID, initialHostAlive: alive(initialHostPID), hostPID, markerExists: Boolean(marker), markerApp: marker?.app,
      app, owner, appPhysical: physical(app), ownerPhysical: physical(owner), home }) + '\n');
  };
  record('cli-update-start');
  process.on('exit', code => record('cli-update-end', code));
}
