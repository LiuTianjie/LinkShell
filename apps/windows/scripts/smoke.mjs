import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { webview2Files } from './webview2.mjs';

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
try {
  assert.equal((await run(node, [cli, '--version'], { env, windowsHide: true })).stdout.trim(), manifest.version);
  const media = await run(join(bundle, 'media/ffmpeg.exe'), ['-hide_banner', '-version'], { windowsHide: true, timeout: 5000 });
  assert.match(media.stdout, /ffmpeg version/);
  assert.ok(!media.stdout.includes('--enable-gpl'), 'The Windows media runtime must remain the LGPL build');
  assert.match(readFileSync(join(bundle, 'media/LICENSE.txt'), 'utf8'), /LESSER GENERAL PUBLIC LICENSE/);
  const { startHost } = await import(pathToFileURL(require.resolve('@linkshell/host')).href);
  host = await startHost({ home, version: 'packaged-smoke', drivers: () => [], iceServers: false, log: () => {} });
  const snapshot = JSON.parse((await run(node, [cli, 'desktop', '--action', 'snapshot'], { env, windowsHide: true, timeout: 30_000 })).stdout.trim());
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.source, 'standalone');
  assert.equal(snapshot.machine.platform, 'win32');
  for (const file of [...webview2Files, 'workspace/index.html']) assert.ok(existsSync(join(bundle, file)), `Missing workspace dependency: ${file}`);
  const { startDesktopWorkspace } = await import(pathToFileURL(join(bundle, 'runtime/cli/dist/cli/src/commands/desktop-workspace.js')).href);
  const workspace = await startDesktopWorkspace({ home, assets: join(bundle, 'workspace') });
  try {
    const url = new URL(workspace.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('desktop');
    const bootstrap = await (await fetch(`${url.origin}/desktop/bootstrap`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(bootstrap.localComputer.machine.platform, 'win32');
    assert.match(await (await fetch(`${url.origin}/config.js`)).text(), /"desktopPlatform":"win32"/);
  } finally { await workspace.stop(); }
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
  console.log(`Verified Windows bundle ${manifest.version}: CLI, named-pipe RPC, SQLite, sharp, ConPTY, FFmpeg, Claude SDK/external executable, workspace assets/sidecar, WebView2 loader and standalone identity.`);
} finally {
  let timer;
  try {
    await Promise.race([host?.stop(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged host shutdown timed out')), 10_000); })]);
  } finally { clearTimeout(timer); }
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
// The SDK may retain module-level timers. Host and ConPTY teardown above is explicitly awaited.
process.exit(0);
