// Exercise the shipped viewer in an isolated headless Edge, including actual H.264 decoding.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../../..');
process.env.LINKSHELL_WINDOWS_HELPER = join(root, 'apps/windows/build/LinkShell.Screen.exe');
process.env.LINKSHELL_INPUT_DRY_RUN = '1';
const { ScreenShare } = await import(pathToFileURL(join(root, 'packages/host/dist/host/src/screen.js')));
const installed = process.argv.includes('--installed');
const logs = [], share = installed ? undefined : new ScreenShare(line => { logs.push(line); console.log(line); });
let browser, client, logFile, logOffset;
try {
  let screen;
  if (installed) {
    const { hostPaths } = await import(pathToFileURL(join(root, 'packages/host/dist/host/src/host.js')));
    const { connectHost } = await import(pathToFileURL(join(root, 'packages/host/dist/host/src/rpc/client.js')));
    const paths = hostPaths();
    logFile = join(paths.home, 'host.log'); logOffset = readFileSync(logFile).length;
    client = await connectHost(paths.hostSocket);
    screen = await client.call('screen.start', {});
  } else screen = await share.start();
  const profile = mkdtempSync(join(root, 'artifacts', 'video-browser-'));
  const executable = process.env.LINKSHELL_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, '--window-size=1280,800', `http://127.0.0.1:${screen.port}/?token=${screen.token}&display=0&video=1&width=1280&maxFps=60&measure=sync`], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { browser.once('error', reject); setTimeout(resolve, 25_000); });
  if (installed) logs.push(...readFileSync(logFile).subarray(logOffset).toString('utf8').split(/\r?\n/).filter(line => line.includes('[screen]')).map(line => line.slice(line.indexOf('[screen]'))));
  const measured = logs.filter(line => line.startsWith('[screen] measured:'));
  const records = measured.map(line => JSON.parse(line.slice('[screen] measured: '.length)));
  const tail = records.slice(-5);
  writeFileSync(join(root, installed ? 'artifacts/windows-video-installed.json' : 'artifacts/windows-video-browser.json'), JSON.stringify({ records, logs }, null, 2));
  assert.ok(records.filter(row => row.mode === 'video' && row.fps > 0).length >= 12, 'Browser did not sustain video presentation');
  assert.ok(tail.every(row => row.mode === 'video' && row.fps >= 5 && /H.?264/.test(row.codec)), 'Video stalled or fell back during the last five seconds');
  console.log(`Verified ${installed ? 'installed host' : 'development host'} browser video decode/presentation: ${records.filter(row => row.mode === 'video' && row.fps > 0).length} video samples`);
} finally {
  if (browser?.pid) spawnSync('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  client?.close(); share?.stop();
}
