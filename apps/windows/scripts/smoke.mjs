import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('Windows smoke must run on Windows');
const bundle = resolve(process.argv[2] || 'build/LinkShell');
const cli = join(bundle, 'runtime/cli/dist/cli/src/index.js');
const node = join(bundle, 'runtime/node.exe');
const manifest = JSON.parse(readFileSync(join(bundle, 'standalone.json')));
const require = createRequire(cli);
const home = mkdtempSync(join(tmpdir(), 'linkshell-bundle-test-'));
const run = promisify(execFile);
const env = { ...process.env, LINKSHELL_HOME: home, LINKSHELL_GATEWAY: 'off', LINKSHELL_WINDOWS_HELPER: join(bundle, 'LinkShell.Screen.exe'), LINKSHELL_APP_BUNDLE: bundle };
let host;

/**
 * The Electron window, launched as installed against this host: the workspace loads in the
 * Windows layout and the page reaches the main process through the bridge.
 */
async function windowSmoke() {
  const profile = mkdtempSync(join(tmpdir(), 'linkshell-window-test-'));
  const child = spawn(join(bundle, 'LinkShell.exe'), [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--home', home], { env, stdio: 'ignore' });
  // Not windowsHide: a GUI process takes it as its first ShowWindow and the window would stay hidden.
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const deadline = Date.now() + 60_000;
  const wait = () => new Promise(resolve => setTimeout(resolve, 250));
  try {
    let port;
    while (!port) {
      if (Date.now() > deadline) throw new Error('The window did not open its debugging port');
      if (child.exitCode !== null) throw new Error(`LinkShell.exe exited ${child.exitCode}`);
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await wait(); }
    }
    let page;
    while (!page) {
      if (Date.now() > deadline) throw new Error('The workspace page did not load');
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
      page = targets.find(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
      if (!page) await wait();
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Cannot reach the page')); });
    const expression = `new Promise((resolve, reject) => {
      const until = Date.now() + 45000;
      const look = () => {
        const root = document.querySelector('.desktop-root');
        if (root) {
          const id = 'smoke-' + Date.now();
          window.addEventListener('linkshell-desktop-reply', (event) => {
            if (event.detail?.id !== id) return;
            resolve({ platform: window.linkshellDesktop?.platform, shell: root.dataset.shell, layout: root.dataset.platform, about: event.detail.result, error: event.detail.error });
          });
          window.linkshellDesktop.postMessage({ action: 'invoke', id, method: 'about', params: {} });
        } else if (Date.now() > until) reject(new Error('no workspace: ' + document.body?.innerText?.slice(0, 200)));
        else setTimeout(look, 250);
      };
      look();
    })`;
    let calls = 0;
    const evaluate = (source, ms = 50_000) => new Promise((resolve, reject) => {
      const id = ++calls;
      const timer = setTimeout(() => reject(new Error('The page did not answer')), ms);
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description ?? 'evaluation failed'));
        else resolve(message.result?.result?.value);
      };
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: source, awaitPromise: true, returnByValue: true } }));
    });
    const answer = await evaluate(expression);
    // For a person to look at (CI uploads them): the whole desktop, so the caption buttons show too.
    const shots = process.env.LINKSHELL_SMOKE_SHOTS;
    if (shots) {
      const shot = async (name) => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const file = join(resolve(shots), name).replace(/'/g, "''");
        await run('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $p = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($p); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); New-Item -ItemType Directory -Force -Path (Split-Path '${file}') | Out-Null; $p.Save('${file}')`], { windowsHide: true });
      };
      await shot('window-dark.png');
      await evaluate("window.linkshellDesktop.postMessage({ action: 'appearance', value: 'light' }), true");
      await shot('window-light.png');
      await evaluate("location.hash = '#view=manage', true");
      await shot('window-manage.png');
    }
    socket.close();
    assert.equal(answer.platform, 'win32');
    assert.equal(answer.shell, 'electron');
    assert.equal(answer.layout, 'windows');
    assert.equal(answer.error, undefined);
    assert.equal(answer.about.standalone, true);
    assert.equal(answer.about.version, manifest.version);
    assert.equal(answer.about.home, home);
  } finally {
    if (child.exitCode === null) await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
}

try {
  assert.equal((await run(node, [cli, '--version'], { env, windowsHide: true })).stdout.trim(), manifest.version);
  // The first load of the copied shared runtime can exceed five seconds on a fresh runner.
  const mediaStarted = Date.now();
  const media = await run(join(bundle, 'media/ffmpeg.exe'), ['-hide_banner', '-version'], { windowsHide: true, timeout: 30_000 });
  console.log(`Packaged FFmpeg version probe completed in ${Date.now() - mediaStarted} ms.`);
  assert.match(media.stdout, /ffmpeg version/);
  assert.ok(!media.stdout.includes('--enable-gpl'), 'The Windows media runtime must remain the LGPL build');
  assert.match(readFileSync(join(bundle, 'media/LICENSE.txt'), 'utf8'), /LESSER GENERAL PUBLIC LICENSE/);
  const { startHost } = await import(pathToFileURL(require.resolve('@linkshell/host')).href);
  host = await startHost({ home, version: 'packaged-smoke', drivers: () => [], iceServers: false, log: () => {} });
  const snapshot = JSON.parse((await run(node, [cli, 'desktop', '--action', 'snapshot'], { env, windowsHide: true, timeout: 30_000 })).stdout.trim());
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.source, 'standalone');
  assert.equal(snapshot.machine.platform, 'win32');
  for (const file of ['LinkShell.exe', 'resources/app/package.json', 'resources/app/dist/main/main.js', 'resources/app/dist/preload/preload.cjs', 'resources/app/assets/tray.png', 'resources/app/assets/icon.png', 'workspace/index.html']) {
    assert.ok(existsSync(join(bundle, file)), `Missing window file: ${file}`);
  }
  assert.ok(!existsSync(join(bundle, 'resources/default_app.asar')), "Electron's sample app must not ship");
  const versionInfo = JSON.parse((await run('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${join(bundle, 'LinkShell.exe').replace(/'/g, "''")}').VersionInfo | Select-Object ProductName, FileDescription, ProductVersion | ConvertTo-Json`], { windowsHide: true })).stdout);
  assert.equal(versionInfo.ProductName, 'LinkShell');
  assert.equal(versionInfo.FileDescription, 'LinkShell');
  assert.equal(versionInfo.ProductVersion, manifest.version);
  const { startDesktopWorkspace } = await import(pathToFileURL(join(bundle, 'runtime/cli/dist/cli/src/commands/desktop-workspace.js')).href);
  const workspace = await startDesktopWorkspace({ home, assets: join(bundle, 'workspace') });
  try {
    const url = new URL(workspace.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('desktop');
    const bootstrap = await (await fetch(`${url.origin}/desktop/bootstrap`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(bootstrap.localComputer.machine.platform, 'win32');
    assert.match(await (await fetch(`${url.origin}/config.js`)).text(), /"desktopPlatform":"win32"/);
  } finally { await workspace.stop(); }
  await windowSmoke();
  const hostRequire = createRequire(require.resolve('@linkshell/host'));
  const sdk = await import(pathToFileURL(hostRequire.resolve('@anthropic-ai/claude-agent-sdk')).href);
  assert.equal(typeof sdk.forkSession, 'function');
  assert.equal(typeof sdk.renameSession, 'function');
  const adapterPath = hostRequire.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
  for (const owner of [hostRequire, createRequire(adapterPath)]) {
    const sdkRequire = createRequire(owner.resolve('@anthropic-ai/claude-agent-sdk'));
    assert.throws(() => sdkRequire.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'), { code: 'MODULE_NOT_FOUND' });
  }
  // Exercise ACP's external-executable route without needing a signed-in agent in CI.
  const external = await run(node, [adapterPath, '--cli', '-e', "console.log('PACKAGED_EXTERNAL_AGENT')"], {
    env: { ...env, CLAUDE_CODE_EXECUTABLE: node, CLAUDE_CONFIG_DIR: join(home, 'claude') }, windowsHide: true, timeout: 30_000,
  });
  assert.equal(external.stdout.trim(), 'PACKAGED_EXTERNAL_AGENT');
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'indigo' } }).png().toBuffer();
  assert.equal(png[0], 137);
  const pty = require('node-pty').spawn(node, ['-e', "console.log('PACKAGED_PTY_READY');process.stdin.on('data',()=>process.exit(0))"], { cwd: home, env, cols: 80, rows: 24, useConptyDll: true });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { pty.kill(); reject(new Error('Packaged ConPTY timed out')); }, 10_000);
    pty.onData(data => { output += data; if (output.includes('PACKAGED_PTY_READY')) pty.write('done\r'); });
    pty.onExit(({ exitCode }) => { clearTimeout(timer); if (exitCode === 0 && output.includes('PACKAGED_PTY_READY')) resolve(); else reject(new Error(`Packaged ConPTY exited ${exitCode}`)); });
  });
  console.log(`Verified Windows bundle ${manifest.version}: CLI, named-pipe RPC, SQLite, sharp, ConPTY, FFmpeg, Claude SDK/external executable, workspace assets/sidecar, the Electron window and its bridge, and standalone identity.`);
} finally {
  let timer;
  try {
    await Promise.race([host?.stop(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged host shutdown timed out')), 10_000); })]);
  } finally { clearTimeout(timer); }
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
// The SDK may retain module-level timers. Host and ConPTY teardown above is explicitly awaited.
process.exit(0);
