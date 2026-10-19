import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
  assert.equal(typeof sdk.forkSession, 'function');
  const adapter = await import(pathToFileURL(require.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')).href);
  assert.ok((await adapter.claudeCliPath()).endsWith('claude.exe'));
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
  console.log(`Verified Windows bundle ${manifest.version}: CLI, named-pipe RPC, SQLite, sharp, ConPTY, FFmpeg shared runtime and standalone identity.`);
} finally {
  let timer;
  try {
    await Promise.race([host?.stop(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged host shutdown timed out')), 10_000); })]);
  } finally { clearTimeout(timer); }
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
// The SDK may retain module-level timers. Host and ConPTY teardown above is explicitly awaited.
process.exit(0);
