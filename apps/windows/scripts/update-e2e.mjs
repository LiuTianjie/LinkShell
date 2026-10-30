import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Never point this harness at an installed app or a developer's live Host.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Windows update E2E requires a disposable Windows GitHub Actions runner.');
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(appRoot, '../..');
const artifacts = join(repo, 'artifacts');
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => stat(path).then(() => true, () => false);
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const inside = (root, path) => { const part = relative(root, path); return part && !part.startsWith('..') && !isAbsolute(part); };
// Windows may report the same fixture with RUNNER~1 or its long directory name.
const physicalPath = async path => (await realpath(path)).toLowerCase();
const samePhysicalPath = async (left, right) => await physicalPath(left) === await physicalPath(right);
const baseVersion = '65530.0.1', nextVersion = '65530.0.2';
const installerName = `LinkShell-Setup-${nextVersion}-windows-x64.exe`;
const officialInstaller = `https://github.com/LiuTianjie/LinkShell/releases/download/desktop-v${nextVersion}/${installerName}`;
const fixtureSession = randomUUID();
const result = { schema: 1, platform: process.platform, startedAt: new Date().toISOString(), scenarios: [], observations: [], processes: [], status: 'running' };
const report = resolve(process.env.LINKSHELL_UPDATE_E2E_REPORT || join(artifacts, 'windows-update-e2e'));
await mkdir(report, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'linkshell-update-e2e-'));
const token = randomUUID();
await writeFile(join(work, 'qa-owner'), token);
const target = join(work, '自定义 安装', 'LinkShell');
const home = join(work, '独立 数据', 'home');
const profile = join(work, '独立 界面');
const payload = join(work, 'payload');
const shortcuts = join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs');
const shortcut = join(shortcuts, 'LinkShell.lnk');
let fixture, connection, fixtureMode = 'corrupt', badInstaller, goodInstaller;
let sequence = 0;
const env = { ...process.env, LINKSHELL_HOME: home, LINKSHELL_GATEWAY: 'off', LINKSHELL_ICE_SERVERS: 'off', LINKSHELL_ENV_FROM_TERMINAL: '1',
  CODEX_HOME: join(work, 'agent-codex'), CLAUDE_CONFIG_DIR: join(work, 'agent-claude'),
  LINKSHELL_QA_ROOT: work, LINKSHELL_QA_PROFILE: profile, LINKSHELL_QA_TOKEN: token,
  LINKSHELL_APP_BUNDLE: target, LINKSHELL_WINDOWS_HELPER: join(target, 'LinkShell.Screen.exe'), LINKSHELL_MACHINE_NAME: 'Windows Update QA' };
delete env.ELECTRON_RUN_AS_NODE;
const log = message => console.log(`[windows-update-e2e] ${message}`);
const check = async (name, fn) => {
  log(name); const started = Date.now();
  try { const evidence = await fn(); result.scenarios.push({ name, status: 'passed', elapsedMs: Date.now() - started, evidence }); }
  catch (error) { result.scenarios.push({ name, status: 'failed', elapsedMs: Date.now() - started, error: error.message }); throw error; }
};
async function until(label, fn, timeout = 90_000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(300);
  }
  throw new Error(`${label} timed out${last ? ': ' + last.message : ''}`);
}
const events = async () => (await readFile(join(work, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const exec = async (command, args, extra = {}) => run(command, args, { env, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...extra });
const cli = async (...args) => JSON.parse((await exec(join(target, 'runtime/node.exe'), [join(target, 'runtime/cli/dist/cli/src/index.js'), 'desktop', '--action', ...args])).stdout.trim());
const recordPID = (pid, role) => { assert.ok(Number.isSafeInteger(pid) && pid > 0); if (!result.processes.some(item => item.pid === pid)) result.processes.push({ pid, role }); return pid; };
const hostPID = async () => recordPID(Number((await readFile(join(home, 'host.pid'), 'utf8')).trim()), 'host');
const hashFile = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
async function patchBundle(path, version) {
  for (const name of ['resources/app/package.json', 'runtime/cli/package.json', 'standalone.json']) {
    const file = join(path, name), value = await readJSON(file); value.version = version; await writeFile(file, JSON.stringify(value, null, 2));
  }
  const main = join(path, 'resources/app/dist/main/main.js');
  await writeFile(main, `import './update-e2e-hook.mjs';\n${await readFile(main, 'utf8')}`);
  await cp(join(appRoot, 'test/fixtures/update-e2e-hook.mjs'), join(dirname(main), 'update-e2e-hook.mjs'));
}
async function buildInstaller(kind) {
  const directory = join(work, kind); await mkdir(directory);
  const archive = join(directory, 'payload.zip'), output = join(directory, installerName), versionFile = join(directory, 'version.txt');
  await exec('tar.exe', ['-a', '-cf', archive, '-C', payload, '.'], { timeout: 240_000 });
  await writeFile(versionFile, nextVersion);
  const framework = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const refs = [];
  for (const name of ['PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml']) {
    const wpf = join(framework, 'WPF', name + '.dll'); refs.push('/r:' + (await exists(wpf) ? wpf : join(framework, name + '.dll')));
  }
  const compiled = await exec(join(framework, 'csc.exe'), ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', '/codepage:65001', '/main:LinkShell.Windows.Installer', ...refs,
    `/win32icon:${join(appRoot, 'build/LinkShell.ico')}`, `/win32manifest:${join(appRoot, 'src/app.manifest')}`, `/out:${output}`,
    `/resource:${archive},payload.zip`, `/resource:${versionFile},installer-version.txt`, `/resource:${join(appRoot, 'src/DesktopTheme.xaml')},DesktopTheme.xaml`, `/resource:${join(appRoot, 'build/brand.png')},brand.png`,
    '/r:System.Core.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    ...['Installer.cs', 'InstallerEngine.cs', 'InstallerUpdate.cs'].map(name => join(appRoot, 'src', name))], { timeout: 240_000 });
  await writeFile(join(report, `compiler-${kind}.log`), compiled.stdout + compiled.stderr);
  await rm(archive); return { path: output, size: (await stat(output)).size, hash: await hashFile(output) };
}
async function startFixture() {
  fixture = createServer((request, response) => {
    const selected = fixtureMode === 'good' ? goodInstaller : badInstaller;
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/releases') {
      const checksum = `${selected.hash}  ${installerName}\n`;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ tag_name: `desktop-v${nextVersion}`, draft: false, prerelease: false, assets: [
        { name: installerName, browser_download_url: officialInstaller, size: selected.size },
        { name: installerName + '.sha256', browser_download_url: officialInstaller + '.sha256', size: Buffer.byteLength(checksum) },
      ] }]));
    } else if (request.url === '/checksum') response.end(`${selected.hash}  ${installerName}\n`);
    else if (request.url === '/installer') {
      response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Content-Length', selected.size);
      let first = true; const corrupt = fixtureMode === 'corrupt';
      const mutation = new Transform({ transform(chunk, encoding, done) { if (first && corrupt) { chunk[0] ^= 1; first = false; } done(null, chunk); } });
      void pipeline(createReadStream(selected.path), mutation, response).catch(error => { if (!response.destroyed) response.destroy(error); });
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  env.LINKSHELL_QA_ORIGIN = `http://127.0.0.1:${fixture.address().port}`;
}
async function seed() {
  const source = `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    const require=createRequire(process.env.LINKSHELL_APP_BUNDLE+'/runtime/cli/package.json');
    const wire=await import(pathToFileURL(require.resolve('@linkshell/wire')));
    const {HostStore}=await import(new URL('./store.js',pathToFileURL(require.resolve('@linkshell/host'))));
    const home=process.env.LINKSHELL_HOME;const identity=wire.createIdentity();const device=wire.createIdentity();
    writeFileSync(join(home,'identity.json'),JSON.stringify(identity));
    writeFileSync(join(home,'paired-devices.json'),JSON.stringify([{id:device.id,signKey:device.signKey,boxKey:device.boxKey,name:'QA phone',pairedAt:Date.now()}]));
    writeFileSync(join(home,'machine.json'),JSON.stringify({machineId:${JSON.stringify(randomUUID())},createdAt:new Date().toISOString()}));
    writeFileSync(join(home,'config.json'),JSON.stringify({gateway:'off',setup:true}));
    writeFileSync(join(home,'home-sentinel.txt'),'Windows update QA preserved home');
    const store=new HostStore(join(home,'state.db'));const id=${JSON.stringify(fixtureSession)};
    store.upsertSession({id,agent:'codex',nativeId:'qa-update-history',cwd:home,title:'QA preserved history',preview:'Synthetic session for installer persistence',createdAt:Date.now(),updatedAt:Date.now()});
    store.appendEvent(id,{sessionUpdate:'user_message_chunk',content:{type:'text',text:'QA user message'}});
    store.appendEvent(id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'QA agent response'}});store.close();`;
  await exec(join(target, 'runtime/node.exe'), ['--input-type=module', '-e', source]);
}
async function preservedState() {
  const hashes = {};
  for (const name of ['identity.json', 'paired-devices.json', 'machine.json', 'home-sentinel.txt']) hashes[name] = await hashFile(join(home, name));
  const source = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.LINKSHELL_HOME+'/state.db',{readOnly:true});const id=${JSON.stringify(fixtureSession)}; console.log(JSON.stringify({integrity:db.prepare('PRAGMA integrity_check').get(),session:db.prepare('SELECT id,native_id,title,preview,cwd FROM sessions WHERE id=?').get(id),events:db.prepare('SELECT seq,body FROM events WHERE session_id=? AND seq<=2 ORDER BY seq').all(id)}));db.close();`;
  const database = JSON.parse((await exec(join(target, 'runtime/node.exe'), ['--input-type=module', '-e', source])).stdout);
  assert.equal(database.integrity.integrity_check, 'ok'); assert.equal(database.session?.id, fixtureSession);
  assert.deepEqual(database.events.map(event => JSON.parse(event.body)), [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'QA user message' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'QA agent response' } },
  ]);
  return { hashes, database };
}
async function attach(previousPID) {
  connection?.close();
  const started = await until('new Electron process', async () => {
    const boots = (await events()).filter(event => event.event === 'app-start');
    const previousIndex = previousPID ? boots.findLastIndex(event => event.pid === previousPID) : -1;
    return boots.slice(previousIndex + 1).at(-1);
  });
  recordPID(started.pid, 'electron');
  const page = await until('Electron CDP page', async () => {
    const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    return pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:'));
  });
  const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(); let callID = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP connection failed')); });
  socket.onmessage = ({ data }) => { const value = JSON.parse(data); const call = pending.get(value.id); if (!call) return; pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(new Error(JSON.stringify(value.error))) : call.resolve(value.result); };
  socket.onclose = () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP closed')); } pending.clear(); };
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++callID; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 60_000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || 'Renderer evaluation failed'); return value.result.value; };
  connection = { pid: started.pid, command, evaluate, close: () => socket.close() };
  await until('desktop bridge', () => evaluate(`Boolean(window.linkshellDesktop && document.querySelector('.desktop-root'))`));
  return connection;
}
async function invoke(method, params = {}) {
  const id = 'qa-' + ++sequence;
  return connection.evaluate(`new Promise((resolve,reject)=>{const id=${JSON.stringify(id)};const timer=setTimeout(()=>{window.removeEventListener('linkshell-desktop-reply',reply);reject(new Error('Bridge timeout'));},45000);function reply(event){if(event.detail?.id!==id)return;clearTimeout(timer);window.removeEventListener('linkshell-desktop-reply',reply);event.detail.error?reject(new Error(String(event.detail.error))):resolve(event.detail.result)}window.addEventListener('linkshell-desktop-reply',reply);window.linkshellDesktop.postMessage({action:'invoke',id,method:${JSON.stringify(method)},params:${JSON.stringify(params)}})})`);
}
async function snapshot(version) {
  const about = await invoke('about'); assert.equal(about.version, version); assert.equal(about.home, home); assert.equal(about.standalone, true);
  const status = await cli('snapshot'); assert.equal(status.status, 'running'); assert.equal(status.cliVersion, version); assert.equal(status.machine.hostVersion, version); assert.equal(status.home, home);
  assert.ok(await samePhysicalPath(status.hostOwner, target), 'The Host must belong to this copied bundle.');
  return { appVersion: about.version, hostVersion: status.machine.hostVersion, hostPID: await hostPID(), homePreserved: true };
}
async function clickControl(selector, text) {
  const point = await until(`visible control ${text}`, () => connection.evaluate(`(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>item.textContent.trim()===${JSON.stringify(text)}&&!item.disabled);if(!element)return; element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x+r.width/2,y:r.y+r.height/2}:undefined})()`));
  await connection.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await connection.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function available() {
  await connection.evaluate(`location.hash='#view=manage';true`);
  await clickControl('.management-nav-item', '更新');
  const before = await invoke('updateStatus');
  await clickControl('button', '立即检查');
  return until('available update', async () => { const status = await invoke('updateStatus'); return !status.checking && status.checkedAt !== before.checkedAt && status.available && status.version === nextVersion && status; });
}
async function native(pid, button, name, timeout = 180) {
  const dump = join(report, `${name}.json`), started = Date.now();
  // .NET/UIA initialization and the first screenshot compilation precede the helper's search clock.
  const timeoutMs = (timeout + 60) * 1000;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(appRoot, 'test/helpers/native-uia.ps1'), '-AppProcessId', String(pid), '-TimeoutSeconds', String(timeout), '-DumpPath', dump, '-ScreenshotPath', join(report, `${name}.png`)];
  args.push(...(button ? ['-ButtonName', button] : ['-InspectOnly']));
  let completed;
  try {
    completed = await exec('powershell.exe', args, { timeout: timeoutMs });
    const value = JSON.parse(completed.stdout.trim());
    assert.equal(value.pid, pid, 'Native UIA must report the requested process.');
    if (button) {
      assert.equal(value.name, button, 'Native UIA must invoke the requested button.');
      assert.equal(value.clicked, true, 'The required native button must actually be invoked.');
    } else assert.equal(value.inspected, true, 'Native UIA must observe the requested window.');
    await writeFile(join(report, `${name}-call.json`), JSON.stringify({ pid, button, status: 'passed', elapsedMs: Date.now() - started, timeoutMs, helper: value }, null, 2));
    return value;
  } catch (error) {
    const progress = (await readFile(dump + '.progress.jsonl', 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const details = { pid, button, status: 'failed', elapsedMs: Date.now() - started, timeoutMs, error: error.message,
      code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? false,
      stdout: error.stdout ?? completed?.stdout ?? '', stderr: error.stderr ?? completed?.stderr ?? '', lastPhase: progress.at(-1) ?? null,
      helper: await readJSON(dump).catch(() => null) };
    await writeFile(join(report, `${name}-call.json`), JSON.stringify(details, null, 2));
    throw new Error(`Native UIA ${name} failed after ${details.elapsedMs} ms (phase: ${details.lastPhase?.phase ?? 'PowerShell startup'}, code: ${details.code}, signal: ${details.signal}, killed: ${details.killed}): ${error.message}`, { cause: error });
  }
}
async function observeNative(pid, name) {
  // Version, Host and data assertions decide the scenario; these screenshots are supporting evidence.
  try {
    const value = await native(pid, undefined, name, 10);
    const status = value.screenshot?.captured ? 'captured' : 'unavailable';
    result.observations.push({ name, status, evidence: value });
    if (status === 'unavailable') log(`Optional ${name} screenshot unavailable; see ${name}.json.`);
  } catch (error) {
    result.observations.push({ name, status: 'unavailable', error: error.message });
    log(`Optional ${name} observation unavailable; see ${name}-call.json.`);
  }
}
async function confirm(name) {
  const prior = connection.pid;
  await clickControl('button', '下载并更新 App…');
  await native(prior, '安装并重启', name + '-confirm');
  const installerPID = await until('installer ready handshake', async () => {
    const cache = join(profile, 'windows-updates');
    for (const scope of await readdir(cache).catch(() => [])) for (const directory of await readdir(join(cache, scope)).catch(() => [])) {
      const pid = Number(await readFile(join(cache, scope, directory, 'ready'), 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0 && !result.processes.some(item => item.pid === pid)) return recordPID(pid, 'installer');
    }
  });
  return { prior, installerPID };
}
async function processList() {
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath} | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`;
  const text = (await exec('powershell.exe', ['-NoProfile', '-Command', script])).stdout.trim();
  const values = text ? JSON.parse(text) : [], candidates = Array.isArray(values) ? values : [values];
  const root = await physicalPath(work), owned = [];
  // Resolve both sides with the same API; lexical short/long-path filtering can miss owned processes.
  for (const candidate of candidates) {
    const executable = await physicalPath(candidate.ExecutablePath).catch(() => undefined);
    if (executable && inside(root, executable)) owned.push(candidate);
  }
  return owned;
}
try {
  assert.ok(!(await exists(shortcut)), 'Disposable runner already has a LinkShell Start Menu shortcut; refusing to replace it.');
  let bundle = process.argv[2] && resolve(process.argv[2]);
  if (!bundle) {
    const stages = (await readdir(artifacts)).filter(name => name.startsWith('windows-stage-'));
    assert.equal(stages.length, 1, 'Pass exactly one built staging bundle as the first argument.'); bundle = join(artifacts, stages[0], 'LinkShell');
  }
  assert.ok(inside(artifacts, bundle), 'Source must be a staging bundle in this checkout artifacts directory.');
  assert.match(relative(artifacts, bundle), /^windows-stage-[^\\/]+[\\/]LinkShell$/);
  for (const file of ['LinkShell.exe', 'runtime/node.exe', 'standalone.json']) assert.ok(await exists(join(bundle, file)), `Missing ${file}`);
  await mkdir(home, { recursive: true }); await mkdir(profile); await mkdir(dirname(target), { recursive: true });
  await mkdir(env.CODEX_HOME); await mkdir(env.CLAUDE_CONFIG_DIR);
  await check('compile real installers from copied bundles', async () => {
    await cp(bundle, target, { recursive: true }); await cp(bundle, payload, { recursive: true });
    await patchBundle(target, baseVersion); await patchBundle(payload, nextVersion);
    const entry = join(payload, 'runtime/cli/dist/cli/src/index.js'), original = await readFile(entry, 'utf8');
    const injection = `if(process.argv.includes('desktop')&&process.argv.includes('recover-update')){const {appendFileSync}=await import('node:fs');appendFileSync(process.env.LINKSHELL_QA_ROOT+'/events.jsonl',JSON.stringify({event:'injected-recovery-failure',pid:process.pid,at:Date.now()})+'\\n');process.exit(74)}\n`;
    await writeFile(entry, original.replace(/^(#![^\n]*\n)?/, prefix => prefix + injection));
    badInstaller = await buildInstaller('bad'); await writeFile(entry, original); goodInstaller = await buildInstaller('good');
    await rm(payload, { recursive: true, force: true }); await startFixture(); await seed();
    return { badBytes: badInstaller.size, goodBytes: goodInstaller.size, testVersion: nextVersion };
  });
  let baseline;
  await check('baseline app and real bundled Host in isolated Chinese paths', async () => {
    await cli('start');
    const child = spawn(join(target, 'LinkShell.exe'), ['--home', home], { env, stdio: 'ignore' });
    recordPID(child.pid, 'electron'); child.on('error', error => log(error.message));
    await attach(); await invoke('setSetting', { key: 'autoCheck', value: false });
    baseline = await preservedState(); const value = await snapshot(baseVersion);
    await connection.evaluate(`location.hash='#view=manage';true`); await observeNative(connection.pid, 'baseline');
    return value;
  });
  await check('SHA-256 failure preserves running Host and never starts installer', async () => {
    const before = await hostPID(); await available(); await clickControl('button', '下载并更新 App…');
    const state = await until('checksum rejection', async () => { const state = await invoke('updateStatus'); return !state.installing && /SHA-256/.test(state.message) && state; });
    assert.equal(await hostPID(), before); assert.equal((await processList()).filter(item => basename(item.ExecutablePath).startsWith('LinkShell-Setup-')).length, 0);
    assert.deepEqual(await preservedState(), baseline); await snapshot(baseVersion);
    return { message: state.message, sameHostPID: true, installerStarted: false };
  });
  await check('real installer recovery failure rolls back and reopens original app', async () => {
    fixtureMode = 'bad'; await available(); const oldHost = await hostPID(); const { prior, installerPID } = await confirm('rollback');
    await native(installerPID, '重新打开 LinkShell', 'rollback-reopen', 300);
    await attach(prior); const value = await snapshot(baseVersion); assert.notEqual(value.hostPID, oldHost);
    assert.ok((await events()).some(event => event.event === 'injected-recovery-failure'), 'Injected failure must actually execute in the replaced bundle.');
    assert.deepEqual(await preservedState(), baseline); assert.ok(!(await exists(join(home, 'desktop-update.json'))), 'Rollback recovery marker must be cleared.');
    const failed = (await readdir(dirname(target))).filter(name => name.startsWith('LinkShell.failed-')); assert.ok(failed.length > 0, 'Failed new bundle should remain until a successful update cleans it.');
    return { ...value, failedBundleCount: failed.length, identityAndHistoryPreserved: true };
  });
  await check('retry installs new app and Host, preserves identity and history, cleans failed copies', async () => {
    fixtureMode = 'good'; await available(); const oldHost = await hostPID(); const { prior, installerPID } = await confirm('success');
    await attach(prior); const value = await snapshot(nextVersion); assert.notEqual(value.hostPID, oldHost);
    assert.deepEqual(await preservedState(), baseline); assert.ok(!(await exists(join(home, 'desktop-update.json'))));
    const leftovers = (await readdir(dirname(target))).filter(name => /^LinkShell\.(previous|failed|install)-/.test(name)); assert.deepEqual(leftovers, []);
    await until('successful installer exits', async () => !(await processList()).some(item => item.ProcessId === installerPID));
    await observeNative(connection.pid, 'updated'); return { ...value, identityAndHistoryPreserved: true, oldBundlesRemoved: true };
  });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = error.stack || error.message; process.exitCode = 1;
  log(error.stack || error.message);
  for (const process of await processList().catch(() => [])) {
    recordPID(process.ProcessId, 'failure-observed-owned');
    if (/LinkShell(?:-Setup-.*)?\.exe$/i.test(basename(process.ExecutablePath))) await native(process.ProcessId, undefined, `failure-${process.ProcessId}`, 5).catch(() => {});
  }
} finally {
  connection?.close();
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
  // Only processes whose executable is inside this run's random fixture are eligible for teardown.
  const owned = await processList().catch(() => []);
  for (const process of owned) {
    recordPID(process.ProcessId, 'cleanup-observed-owned');
    await exec('taskkill.exe', ['/PID', String(process.ProcessId), '/T', '/F'], { timeout: 15_000 }).catch(() => {});
  }
  const cleanupErrors = [];
  if (await exists(shortcut)) {
    try {
      const shortcutEnv = { ...env, LINKSHELL_QA_SHORTCUT: shortcut };
      const readTarget = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($env:LINKSHELL_QA_SHORTCUT);$link.TargetPath | ConvertTo-Json -Compress`;
      const observed = JSON.parse((await exec('powershell.exe', ['-NoProfile', '-Command', readTarget], { env: shortcutEnv })).stdout.trim());
      assert.ok(await samePhysicalPath(observed, join(target, 'LinkShell.exe')), 'Refusing to remove a foreign shortcut.');
      // Re-read before deletion so a changed shortcut is never removed after the physical-path check.
      const removeOwned = `$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($env:LINKSHELL_QA_SHORTCUT);if($link.TargetPath -eq $env:LINKSHELL_QA_SHORTCUT_TARGET){Remove-Item -LiteralPath $env:LINKSHELL_QA_SHORTCUT -Force}else{throw 'Refusing to remove a changed shortcut'}`;
      await exec('powershell.exe', ['-NoProfile', '-Command', removeOwned], { env: { ...shortcutEnv, LINKSHELL_QA_SHORTCUT_TARGET: observed } });
    } catch (error) { cleanupErrors.push(error.message); }
  }
  await writeFile(join(report, 'events.jsonl'), (await events()).map(event => JSON.stringify(event)).join('\n') + '\n');
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }).catch(error => cleanupErrors.push(error.message));
  result.cleanup = { temporaryFilesRemoved: !(await exists(work)), errors: cleanupErrors };
  if (cleanupErrors.length) { result.status = 'failed'; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  await writeFile(join(report, 'report.json'), JSON.stringify(result, null, 2));
  log(`Result: ${result.status}; sanitized report: ${report}`);
}
