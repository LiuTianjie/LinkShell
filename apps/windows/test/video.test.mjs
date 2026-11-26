import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const media = resolve('build/LinkShell.Media.exe');
const helper = resolve('build/LinkShell.Screen.exe');
const skipMedia = process.platform !== 'win32' || !existsSync(media);
const skipHelper = process.platform !== 'win32' || !existsSync(helper);

test('native C++20 libwebrtc media engine passes --selftest and reports encoder capabilities', { skip: skipMedia, timeout: 20_000 }, () => {
  const stdout = execFileSync(media, ['--selftest'], { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, true, stdout);
  assert.equal(result.webrtcReady, true, stdout);
  assert.equal(typeof result.hwH264, 'boolean');
  assert.equal(typeof result.hwHevc, 'boolean');
  assert.equal(typeof result.wgcSupported, 'boolean');
  assert.ok(Array.isArray(result.displays), stdout);
});

test('native media engine speaks JSON-lines status/displays protocol and exits cleanly on quit/EOF', { skip: skipMedia, timeout: 20_000 }, async () => {
  const child = spawn(media, ['--engine'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', line => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return; }
    lines.push(parsed);
    for (const waiter of [...waiters]) {
      if (waiter.match(parsed)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    }
  });
  const next = (match, timeoutMs = 10_000) => {
    const existing = lines.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for media engine line; stderr: ${stderr}`)), timeoutMs);
      waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  };
  try {
    const status = await next(msg => msg.t === 'status');
    assert.equal(status.video, true);
    assert.equal(status.videoReconfigure, true);
    assert.equal(status.keys, true);
    child.stdin.write(`${JSON.stringify({ t: 'displays' })}\n`);
    const displays = await next(msg => msg.t === 'displays');
    assert.ok(Array.isArray(displays.list));
    child.stdin.write(`${JSON.stringify({ t: 'quit' })}\n`);
  } finally {
    child.stdin.end();
  }
  const [code] = await exited;
  assert.equal(code, 0, `LinkShell.Media.exe exited ${code}: ${stderr}`);
});

test('native screen helper reports virtual display driver status JSON cleanly', { skip: skipHelper, timeout: 10_000 }, () => {
  const stdout = execFileSync(helper, ['--vdd-status'], { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 8_000 });
  const status = JSON.parse(stdout.trim());
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(typeof status.enabled, 'boolean');
  assert.equal(typeof status.active, 'boolean');
  assert.equal(typeof status.virtualMonitors, 'number');
  assert.equal(typeof status.driverBundled, 'boolean');
});
