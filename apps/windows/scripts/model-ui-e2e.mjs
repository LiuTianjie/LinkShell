import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Model UI E2E requires a disposable Windows GitHub Actions runner.');
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(appRoot, '../..'), artifacts = join(repo, 'artifacts');
const report = join(artifacts, 'windows-model-ui-e2e');
const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => stat(path).then(() => true, () => false);
const inside = (root, path) => { const part = relative(root, path); return !!part && !part.startsWith('..') && !isAbsolute(part); };
const physical = async path => (await realpath(path)).toLowerCase();
const work = await mkdtemp(join(tmpdir(), 'linkshell-model-ui-e2e-'));
const target = join(work, '独立 安装', 'LinkShell'), home = join(work, '独立 数据');
const profile = join(work, '独立 界面'), user = join(work, '用户 目录'), codexHome = join(work, 'empty-codex');
const token = randomUUID(), windows = process.env.WINDIR || 'C:\\Windows';
const codexVersion = '0.162.1';
const codexArchive = `https://registry.npmjs.org/@openai/codex/-/codex-${codexVersion}-win32-x64.tgz`;
const codexIntegrity = 'dfl4MhHuEi0ARKyNmrTxk+RQmsWNCQAoVLUtrYq+yrW1C8P2sg5ziwgHUUACHjYLKuACV7ARH5Nq5pnCz3GlaQ==';
// This is the layout in the integrity-pinned native package, not the older codex/ layout.
const codexBinary = 'package/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const codexExe = join(work, 'official-codex', codexBinary);
const result = { schema: 1, startedAt: new Date().toISOString(), status: 'running', scenarios: [] };
const rpcEvents = [], requests = new Map();
let connection, forbiddenRPC = false, clipboardNeedsRestore = false, clipboardRestored;
// Do not inherit account tokens, API keys, proxies, NODE_OPTIONS or a runner's agent configuration.
const env = {
  SystemRoot: windows, WINDIR: windows, COMSPEC: join(windows, 'System32/cmd.exe'),
  PATH: [dirname(codexExe), join(target, 'runtime'), join(windows, 'System32'), windows,
    join(windows, 'System32/Wbem'), join(windows, 'System32/WindowsPowerShell/v1.0')].join(';'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: join(work, 'temp'), TMP: join(work, 'temp'),
  USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'), LOCALAPPDATA: join(user, 'AppData/Local'),
  GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(work, 'empty-claude'),
  LINKSHELL_HOME: home, LINKSHELL_GATEWAY: 'off', LINKSHELL_ICE_SERVERS: 'off', LINKSHELL_ENV_FROM_TERMINAL: '1',
  LINKSHELL_APP_BUNDLE: target, LINKSHELL_WINDOWS_HELPER: join(target, 'LinkShell.Screen.exe'), LINKSHELL_MACHINE_NAME: 'Windows Model QA',
  LINKSHELL_QA_ROOT: work, LINKSHELL_QA_PROFILE: profile, LINKSHELL_QA_TOKEN: token,
};
const log = text => console.log(`[windows-model-ui-e2e] ${text}`);
const safeError = error => String(error?.message || error).replaceAll(work, '<fixture>').replace(/(?:wss?|https?):\/\/[^\s"']+/g, '<url>');
const exec = (command, args, options = {}) => run(command, args, { env, cwd: user, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options });
const cli = async action => JSON.parse((await exec(join(target, 'runtime/node.exe'), [join(target, 'runtime/cli/dist/cli/src/index.js'), 'desktop', '--action', action])).stdout.trim());
const readEvents = async name => (await readFile(join(work, name), 'utf8').catch(() => '')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
async function until(label, fn, timeout = 120_000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    if (forbiddenRPC) throw new Error('The UI attempted to send a prompt.');
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(300);
  }
  throw new Error(`${label} timed out${last ? ': ' + safeError(last) : ''}`);
}
async function check(name, fn) {
  log(name); const started = Date.now();
  try { const evidence = await fn(); result.scenarios.push({ name, status: 'passed', elapsedMs: Date.now() - started, evidence }); }
  catch (error) { result.scenarios.push({ name, status: 'failed', elapsedMs: Date.now() - started, error: safeError(error) }); throw error; }
}
async function processList() {
  const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath} | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress';
  const output = (await exec('powershell.exe', ['-NoProfile', '-Command', script])).stdout.trim();
  const parsed = output ? JSON.parse(output) : [], root = await physical(work), owned = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const path = await physical(item.ExecutablePath).catch(() => undefined);
    if (path && inside(root, path)) owned.push(item);
  }
  return owned;
}
async function probeCodex() {
  const child = spawn(codexExe, ['app-server'], { env, cwd: user, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, buffer = '';
  const rejectPending = error => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
  child.on('error', rejectPending); child.on('exit', () => rejectPending(new Error('Codex probe exited'))); child.stderr.resume();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const call = pending.get(message.id); if (!call) continue;
      pending.delete(message.id); clearTimeout(call.timer);
      message.error ? call.reject(new Error(`Codex ${call.method} failed (${message.error.code})`)) : call.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    assert.ok(['initialize', 'account/read', 'config/read', 'model/list'].includes(method));
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 90_000);
    pending.set(id, { resolve, reject, timer, method }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'linkshell_model_ui_qa', title: 'LinkShell QA', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const account = await rpc('account/read', { refreshToken: false });
    assert.equal(account.account, null); assert.equal(account.requiresOpenaiAuth, true);
    const config = (await rpc('config/read', { includeLayers: false })).config;
    assert.equal(config.cli_auth_credentials_store, 'file'); assert.equal(config.model, null); assert.equal(config.model_provider, null);
    const catalog = await rpc('model/list', { includeHidden: false }); assert.ok(catalog.data.length > 1); assert.ok(!catalog.nextCursor);
    return { account: null, requiresOpenaiAuth: true, credentialStore: 'file', models: catalog.data.map(item => ({ model: item.model, isDefault: item.isDefault })) };
  } finally {
    child.kill(); await until('Codex probe exit', () => child.exitCode !== null || child.signalCode !== null, 15_000);
    rejectPending(new Error('Codex probe closed'));
  }
}
function observeRPC(method, params) {
  if (!method.startsWith('Network.webSocketFrame')) return;
  let message; try { message = JSON.parse(params.response.payloadData); } catch { return; }
  const key = params.requestId + ':' + message.id;
  if (method === 'Network.webSocketFrameSent' && message.method) {
    if (['sessions.send', 'sessions.prompt', 'turn/start', 'turn/steer', 'review/start', 'thread/compact/start', 'command/exec'].includes(message.method)) forbiddenRPC = true;
    if (!['agents.models', 'sessions.create', 'sessions.setConfig', 'sessions.subscribe', 'sessions.unsubscribe'].includes(message.method)) return;
    const input = message.params || {};
    const safe = { agent: input.agent, model: input.model, sessionId: input.sessionId, optionId: input.optionId, value: input.value,
      ...(message.method === 'sessions.create' ? { promptAbsent: !input.prompt?.length, cwdIsIsolated: inside(work, input.cwd) } : {}) };
    requests.set(key, { method: message.method, params: safe });
    rpcEvents.push({ at: Date.now(), event: 'request', method: message.method, params: safe });
  } else if (method === 'Network.webSocketFrameReceived') {
    if (message.method === 'session.event' && message.params?.update?.sessionUpdate === 'ls_config') {
      const option = message.params.update.options.find(option => option.id === 'model');
      rpcEvents.push({ at: Date.now(), event: 'config', sessionId: message.params.sessionId, seq: message.params.seq,
        model: option?.current, values: option?.values?.map(value => ({ value: value.value, name: value.name })) });
      return;
    }
    const request = requests.get(key); if (!request) return; requests.delete(key);
    const output = message.result;
    const safe = request.method === 'agents.models' ? { models: output?.models?.map(model => ({ value: model.value, name: model.name })), current: output?.current }
      : request.method === 'sessions.create' ? { sessionId: output?.session?.id, nativeId: output?.session?.nativeId, model: output?.session?.model } : {};
    rpcEvents.push({ at: Date.now(), event: 'response', ...request, ok: !message.error, ...(message.error ? { code: message.error.code } : {}), result: safe });
  }
}
async function attach() {
  const boot = await until('Electron start', async () => (await readEvents('app-events.jsonl')).at(-1));
  const page = await until('Electron CDP page', async () => {
    const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    return pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:'));
  });
  const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(); let sequence = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP connection failed')); });
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    if (value.method) { observeRPC(value.method, value.params); return; }
    const call = pending.get(value.id); if (!call) return; pending.delete(value.id); clearTimeout(call.timer);
    value.error ? call.reject(new Error(`CDP error ${value.error.code}`)) : call.resolve(value.result);
  };
  socket.onclose = () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP closed')); } pending.clear(); };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 60_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error('Renderer evaluation failed'); return response.result.value;
  };
  connection = { pid: boot.pid, command, evaluate, close: () => socket.close() };
  await command('Network.enable'); await command('Page.enable'); await command('Page.reload');
  await until('desktop workspace', () => evaluate(`Boolean(window.linkshellDesktop && document.querySelector('.desktop-root'))`));
  return boot.pid;
}
async function click(selector, index = 0) {
  const point = await until(`enabled visible ${selector}`, () => connection.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})][${index}];if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x+r.width/2,y:r.y+r.height/2}:undefined})()`));
  await connection.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await connection.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
const newModel = 'button[aria-label="选择模型"]';
const composerModel = 'button.composer-chip[data-category="model"]';
const newRows = '.new-session-menu[data-state="open"] [role="menuitemradio"]';
const composerRows = '.composer-chip-menu[data-state="open"] [role="menuitemradio"]';
async function menuRows(selector) {
  return until('populated model menu', () => connection.evaluate(`(()=>{const rows=[...document.querySelectorAll(${JSON.stringify(selector)})];return rows.length>1?rows.map(e=>({name:e.querySelector('.new-session-option > span,.composer-chip-option > span')?.textContent,checked:e.getAttribute('aria-checked')==='true'})):undefined})()`));
}
async function dismissMenu() {
  await connection.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await connection.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until('model menu closes', () => connection.evaluate(`!document.querySelector('.new-session-menu[data-state="open"],.composer-chip-menu[data-state="open"]')`));
}
async function screenshot(name) {
  const shot = await connection.command('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(report, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function clipboardFixture(operation, text) {
  const id = randomUUID();
  const response = await connection.evaluate(`new Promise(resolve=>{const id=${JSON.stringify(id)};const timer=setTimeout(()=>{window.removeEventListener('linkshell-qa-clipboard',reply);resolve({error:'Clipboard fixture timeout'});},10000);function reply(event){if(event.detail?.id!==id)return;clearTimeout(timer);window.removeEventListener('linkshell-qa-clipboard',reply);resolve(event.detail)}window.addEventListener('linkshell-qa-clipboard',reply);window.linkshellDesktop.postMessage({action:'qaClipboard',token:${JSON.stringify(token)},id,operation:${JSON.stringify(operation)},text:${JSON.stringify(text)}})})`);
  if (response.error) throw new Error(response.error); return response.result;
}
async function nativeEditingMenu(selector, name, editFlag, evidenceName) {
  const before = (await readEvents('app-events.jsonl')).length;
  const point = await connection.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();const r=e.getBoundingClientRect();return{x:r.x+22,y:r.y+22}})()`);
  await connection.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
  await connection.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
  const context = await until('native editing context', async () => (await readEvents('app-events.jsonl')).slice(before).find(event => event.event === 'editing-context'), 15_000);
  assert.equal(context.editable, true); assert.equal(context[editFlag], true, `${name} must be enabled by Chromium.`);
  const started = Date.now(), timeoutMs = 90_000, helperDump = evidenceName + '.json';
  let response;
  try {
    response = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(appRoot, 'test/helpers/native-menu-uia.ps1'),
      '-AppProcessId', String(connection.pid), '-MenuItemName', name, '-TimeoutSeconds', '30', '-DumpPath', join(report, helperDump)], { timeout: timeoutMs });
  } catch (error) {
    await writeFile(join(report, evidenceName + '-driver.json'), JSON.stringify({ name, pid: connection.pid, elapsedMs: Date.now() - started,
      searchTimeoutSeconds: 30, startupBudgetMs: 60_000, timeoutMs, code: error.code, signal: error.signal, killed: error.killed,
      stdout: safeError(error.stdout ?? '').slice(-16000), stderr: safeError(error.stderr ?? '').slice(-16000), helperDump }, null, 2));
    throw new Error(`Native ${name} helper failed; see ${evidenceName}-driver.json and ${helperDump}.`);
  }
  const invoked = JSON.parse(response.stdout.trim()); assert.equal(invoked.clicked, true); assert.equal(invoked.pid, connection.pid); assert.equal(invoked.name, name); assert.equal(invoked.controlType, 'ControlType.MenuItem');
  assert.ok(['InvokePattern', 'MSAA.accDoDefaultAction'].includes(invoked.invocationMethod));
  return { name, invoked: true, invocationMethod: invoked.invocationMethod, controlType: invoked.controlType, processId: invoked.pid, chromiumEnabled: true };
}
const responseAfter = (index, method, matches = () => true) => rpcEvents.slice(index).find(event => event.event === 'response' && event.method === method && event.ok && matches(event));
async function persisted(sessionId) {
  const source = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.LINKSHELL_HOME+'/state.db',{readOnly:true});const id=${JSON.stringify(sessionId)};const row=db.prepare("SELECT value FROM driver_state WHERE session_id=? AND key='overrides'").get(id);const events=db.prepare('SELECT body FROM events WHERE session_id=? ORDER BY seq').all(id).map(row=>JSON.parse(row.body));const config=events.findLast(event=>event.sessionUpdate==='ls_config');console.log(JSON.stringify({model:row?JSON.parse(row.value).model:null,configModel:config?.options.find(option=>option.id==='model')?.current,messageCount:events.filter(event=>/message|tool_call/.test(event.sessionUpdate)).length,turnStarts:events.filter(event=>event.sessionUpdate==='ls_turn'&&event.state==='started').length}));db.close();`;
  return JSON.parse((await exec(join(target, 'runtime/node.exe'), ['--input-type=module', '-e', source])).stdout.trim());
}

try {
  await mkdir(report, { recursive: true });
  for (const directory of [home, profile, user, codexHome, env.CLAUDE_CONFIG_DIR, env.TEMP, env.APPDATA, env.LOCALAPPDATA]) await mkdir(directory, { recursive: true });
  await writeFile(join(work, 'qa-owner'), token);
  await writeFile(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  await writeFile(join(home, 'config.json'), JSON.stringify({ gateway: 'off', setup: true }));
  let bundle = process.argv[2] && resolve(process.argv[2]);
  if (!bundle) {
    const stages = (await readdir(artifacts)).filter(name => name.startsWith('windows-stage-'));
    assert.equal(stages.length, 1, 'Pass exactly one staging bundle.'); bundle = join(artifacts, stages[0], 'LinkShell');
  }
  assert.ok(inside(artifacts, bundle)); assert.match(relative(artifacts, bundle), /^windows-stage-[^\\/]+[\\/]LinkShell$/);
  for (const name of ['LinkShell.exe', 'runtime/node.exe', 'standalone.json']) assert.ok(await exists(join(bundle, name)), `Missing ${name}`);
  let catalog;
  await check('official pinned Codex in an empty account environment', async () => {
    const response = await fetch(codexArchive, { signal: AbortSignal.timeout(120_000) }); assert.equal(response.status, 200);
    const archive = Buffer.from(await response.arrayBuffer()); assert.equal(createHash('sha512').update(archive).digest('base64'), codexIntegrity);
    const destination = join(work, 'official-codex'); await mkdir(destination); const path = join(work, 'codex.tgz'); await writeFile(path, archive);
    await exec('tar.exe', ['-xzf', path, '-C', destination]); await rm(path);
    const binary = await stat(codexExe).catch(() => undefined);
    assert.ok(binary?.isFile(), `Official Codex ${codexVersion} archive is missing ${codexBinary}`);
    assert.ok((await stat(user)).isDirectory(), 'The isolated Codex working directory must exist before launch.');
    const version = (await exec(codexExe, ['--version'])).stdout.trim(); assert.equal(version, `codex-cli ${codexVersion}`);
    catalog = await probeCodex(); assert.ok(!(await exists(join(codexHome, 'auth.json'))));
    return { version, integrityVerified: true, binary: codexBinary, binaryBytes: binary.size, workingDirectoryExists: true, ...catalog };
  });
  let hostPID, appServerPID;
  await check('real Electron and bundled Host discover official Codex', async () => {
    await mkdir(dirname(target), { recursive: true }); await cp(bundle, target, { recursive: true });
    for (const [entry, fixture] of [['resources/app/dist/main/main.js', 'model-ui-e2e-hook.mjs'], ['runtime/cli/dist/cli/src/index.js', 'model-ui-native-observer.mjs']]) {
      const file = join(target, entry); await cp(join(appRoot, 'test/fixtures', fixture), join(dirname(file), fixture));
      await writeFile(file, (await readFile(file, 'utf8')).replace(/^(#![^\n]*\n)?/, prefix => prefix + `import './${fixture}';\n`));
    }
    await cli('start');
    const status = await until('bundled Host running', async () => { const value = await cli('snapshot'); return value.status === 'running' && value; });
    assert.equal(status.home, home); assert.equal(await physical(status.hostOwner), await physical(target));
    hostPID = Number((await readFile(join(home, 'host.pid'), 'utf8')).trim());
    const child = spawn(join(target, 'LinkShell.exe'), ['--home', home], { env, cwd: user, stdio: 'ignore' }); child.on('error', error => log(safeError(error)));
    const electronPID = await attach();
    const account = await until('real Host native account/read', async () => (await readEvents('native-events.jsonl')).find(event => event.event === 'response' && event.method === 'account/read' && event.ok));
    assert.equal(account.accountNull, true); assert.equal(account.requiresOpenaiAuth, true);
    appServerPID = (await readEvents('native-events.jsonl')).find(event => event.event === 'app-server-start')?.pid;
    const agentProcess = (await processList()).find(item => item.ProcessId === appServerPID);
    assert.ok(agentProcess); assert.equal(await physical(agentProcess.ExecutablePath), await physical(codexExe));
    return { electronPID, hostPID, appServerPID, hostVersion: status.machine.hostVersion, accountNull: true };
  });
  let selected, initial, sessionId, selectedName;
  await check('new-session picker uses real agents.models and creates an empty native thread', async () => {
    if (await connection.evaluate(`Boolean(document.querySelector('.management-back'))`)) await click('.management-back');
    const before = rpcEvents.length; await click('.desktop-new-session');
    const listed = await until('actual agents.models response', () => responseAfter(before, 'agents.models', event => event.params.agent === 'codex'));
    assert.ok(listed.result.models.length > 1);
    assert.deepEqual(listed.result.models.map(model => model.value).sort(), catalog.models.map(model => model.model).sort());
    initial = listed.result.current; assert.ok(initial);
    selected = listed.result.models.find(model => model.value !== initial).value;
    await click(newModel); const rows = await menuRows(newRows); assert.equal(rows.length, listed.result.models.length);
    const choiceIndex = listed.result.models.findIndex(model => model.value === selected); selectedName = rows[choiceIndex].name;
    const pickBefore = rpcEvents.length; await click(newRows, choiceIndex);
    await until('selected model settings preview RPC', () => responseAfter(pickBefore, 'agents.models', event => event.params.model === selected));
    await click(newModel); const picked = await menuRows(newRows); assert.equal(picked[choiceIndex].checked, true); await screenshot('new-session-selected'); await dismissMenu();
    assert.equal(await connection.evaluate(`document.querySelector('textarea[aria-label="任务描述"]').value`), '');
    const createBefore = rpcEvents.length; await click('button[aria-label="开始会话"]');
    const created = await until('real sessions.create response', () => responseAfter(createBefore, 'sessions.create'));
    assert.equal(created.params.model, selected); assert.equal(created.params.promptAbsent, true); assert.equal(created.params.cwdIsIsolated, true);
    sessionId = created.result.sessionId; assert.ok(sessionId);
    const native = await until('native thread/start response', async () => (await readEvents('native-events.jsonl')).find(event => event.event === 'response' && event.method === 'thread/start' && event.ok));
    assert.ok(native.threadId); assert.equal(native.turns, 0);
    if (created.result.nativeId) assert.equal(native.threadId, created.result.nativeId);
    await until('session model config', () => rpcEvents.some(event => event.event === 'config' && event.sessionId === sessionId && event.model === selected));
    await until('session composer ready', () => connection.evaluate(`Boolean(document.querySelector(${JSON.stringify(composerModel)}))`));
    return { initialModel: initial, selectedModel: selected, previewRPC: 'agents.models', sessionId, nativeThreadCreated: true, turns: native.turns };
  });
  let savedName;
  await check('session model UI writes real sessions.setConfig and persistent Host override', async () => {
    const config = rpcEvents.findLast(event => event.event === 'config' && event.sessionId === sessionId);
    const index = config.values.findIndex(value => value.value === initial); assert.ok(index >= 0);
    await click(composerModel); const rows = await menuRows(composerRows); savedName = rows[index].name;
    assert.equal(rows.find(row => row.name === selectedName)?.checked, true);
    const before = rpcEvents.length; await click(composerRows, index);
    await until('sessions.setConfig success', () => responseAfter(before, 'sessions.setConfig', event => event.params.sessionId === sessionId && event.params.optionId === 'model' && event.params.value === initial));
    await until('Host confirmed selected option', () => rpcEvents.slice(before).some(event => event.event === 'config' && event.sessionId === sessionId && event.model === initial));
    const state = await persisted(sessionId); assert.equal(state.model, initial); assert.equal(state.configModel, initial); assert.equal(state.messageCount, 0); assert.equal(state.turnStarts, 0);
    await click(composerModel); assert.equal((await menuRows(composerRows)).find(row => row.name === savedName)?.checked, true); await screenshot('session-model-saved'); await dismissMenu();
    return { optionId: 'model', value: initial, actualRPC: 'sessions.setConfig', ...state };
  });
  await check('leave and reopen session, then reload renderer with the same Host', async () => {
    await click('.desktop-places .desktop-place', 0);
    await until('left session for the session overview', () => connection.evaluate(`Boolean(document.querySelector('.desktop-places .desktop-place[aria-current="page"]')) && !document.querySelector(${JSON.stringify(composerModel)})`));
    const row = `.tree-session[data-session-id="${sessionId}"]`; await click(row);
    await click(composerModel); assert.equal((await menuRows(composerRows)).find(row => row.name === savedName)?.checked, true); await dismissMenu();
    const before = rpcEvents.length; await connection.command('Page.reload');
    await until('reloaded workspace', () => connection.evaluate(`Boolean(document.querySelector('.desktop-root'))`));
    if (await connection.evaluate(`Boolean(document.querySelector('.management-back'))`)) await click('.management-back');
    await click(row);
    await until('fresh subscription after renderer reload', () => responseAfter(before, 'sessions.subscribe', event => event.params.sessionId === sessionId));
    await click(composerModel); assert.equal((await menuRows(composerRows)).find(row => row.name === savedName)?.checked, true); await screenshot('reopened-model'); await dismissMenu();
    assert.equal(Number((await readFile(join(home, 'host.pid'), 'utf8')).trim()), hostPID);
    assert.ok((await processList()).some(item => item.ProcessId === appServerPID));
    const state = await persisted(sessionId); assert.equal(state.model, initial); assert.equal(state.configModel, initial); assert.equal(state.messageCount, 0); assert.equal(state.turnStarts, 0);
    assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
    assert.ok(!(await exists(join(codexHome, 'auth.json')))); assert.ok(!(await exists(join(home, 'auth.json'))));
    const native = await readEvents('native-events.jsonl');
    assert.ok(native.some(event => event.method === 'model/list' && event.event === 'response' && event.ok));
    assert.equal(native.filter(event => event.event === 'forbidden-request' || ['turn/start', 'turn/steer', 'review/start', 'thread/compact/start', 'command/exec'].includes(event.method)).length, 0);
    assert.equal(forbiddenRPC, false);
    return { reopenedModel: initial, rendererReloaded: true, hostPIDUnchanged: true, appServerPIDUnchanged: true,
      globalModelConfigChanged: false, credentialsPresent: false, inferenceRequests: 0, ...state };
  });
  await check('real Windows native Copy, Cut, Paste and Undo preserve clipboard state', async () => {
    const saved = await clipboardFixture('snapshot'); assert.equal(saved.saved, true); clipboardNeedsRestore = true;
    assert.equal((await clipboardFixture('write', 'LinkShell clipboard baseline')).written, true);
    await connection.command('Page.bringToFront');
    await click('.desktop-new-session');
    const input = 'textarea[aria-label="任务描述"]', sample = `LinkShell 原生菜单 ${randomUUID()}`;
    await click(input); await connection.command('Input.insertText', { text: sample });
    const inputValue = () => connection.evaluate(`document.querySelector(${JSON.stringify(input)})?.value`);
    await until('native input entered', async () => await inputValue() === sample);
    await connection.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await connection.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await until('text selected', () => connection.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(input)});return e.selectionStart===0&&e.selectionEnd===e.value.length})()`));
    const actions = [];
    actions.push(await nativeEditingMenu(input, '复制', 'canCopy', 'native-copy'));
    await until('native Copy clipboard equality', async () => (await clipboardFixture('read')).text === sample); assert.equal(await inputValue(), sample);
    actions.push(await nativeEditingMenu(input, '剪切', 'canCut', 'native-cut'));
    await until('native Cut removes selected text', async () => await inputValue() === ''); assert.equal((await clipboardFixture('read')).text, sample);
    actions.push(await nativeEditingMenu(input, '粘贴', 'canPaste', 'native-paste'));
    await until('native Paste restores copied text', async () => await inputValue() === sample); assert.equal((await clipboardFixture('read')).text, sample);
    actions.push(await nativeEditingMenu(input, '撤销', 'canUndo', 'native-undo'));
    await until('native Undo reverses Paste', async () => await inputValue() === ''); assert.equal((await clipboardFixture('read')).text, sample);
    await screenshot('native-menu-editing-complete');
    clipboardRestored = (await clipboardFixture('restore')).restored; assert.equal(clipboardRestored, true); clipboardNeedsRestore = false;
    const native = await readEvents('native-events.jsonl');
    assert.equal(native.filter(event => event.event === 'forbidden-request' || ['turn/start', 'turn/steer', 'review/start', 'thread/compact/start', 'command/exec'].includes(event.method)).length, 0);
    assert.equal(forbiddenRPC, false);
    return { actions, copyClipboardEqualsSelection: true, cutRemovedSelection: true, cutClipboardEqualsSelection: true,
      pasteEqualsClipboard: true, undoReversedPaste: true, promptEmpty: true, clipboardRestored: true, inferenceRequests: 0 };
  });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = safeError(error); process.exitCode = 1; log(result.error);
  if (connection) {
    await screenshot('failure').catch(() => {});
    const ui = await connection.evaluate(`({headings:[...document.querySelectorAll('h1,h2')].map(e=>e.textContent),buttons:[...document.querySelectorAll('button')].slice(0,100).map(e=>({text:e.textContent?.slice(0,120),label:e.getAttribute('aria-label'),disabled:e.disabled})),notices:[...document.querySelectorAll('[role="alert"],.error-notice')].map(e=>e.textContent?.slice(0,500))})`).catch(() => undefined);
    if (ui) await writeFile(join(report, 'failure-ui.json'), JSON.stringify(ui, null, 2));
  }
} finally {
  const cleanupErrors = [];
  if (clipboardNeedsRestore && connection) {
    try { clipboardRestored = (await clipboardFixture('restore')).restored; assert.equal(clipboardRestored, true); clipboardNeedsRestore = false; }
    catch (error) { clipboardRestored = false; cleanupErrors.push(safeError(error)); }
  }
  connection?.close();
  for (const item of await processList().catch(error => { cleanupErrors.push(safeError(error)); return []; })) {
    await exec('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { timeout: 15_000 }).catch(() => {});
  }
  await mkdir(report, { recursive: true });
  await writeFile(join(report, 'rpc-events.jsonl'), rpcEvents.map(event => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(join(report, 'native-events.jsonl'), (await readEvents('native-events.jsonl')).map(event => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(join(report, 'editing-events.jsonl'), (await readEvents('app-events.jsonl')).filter(event => ['editing-context', 'clipboard-restored'].includes(event.event)).map(event => JSON.stringify(event)).join('\n') + '\n');
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }).catch(error => cleanupErrors.push(safeError(error)));
  result.cleanup = { temporaryFilesRemoved: !(await exists(work)), clipboardRestored, errors: cleanupErrors };
  if (cleanupErrors.length) { result.status = 'failed'; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString(); await writeFile(join(report, 'report.json'), JSON.stringify(result, null, 2));
  log(`Result: ${result.status}; sanitized report: ${report}`);
}
