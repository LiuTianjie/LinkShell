import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const helper = resolve('build/LinkShell.Screen.exe');
const supported = process.platform === 'win32' && existsSync(helper);
const sharp = createRequire(new URL('../../../packages/host/package.json', import.meta.url))('sharp');
test('native screen enumerates physical displays and returns a bounded JPEG', { skip: !supported, timeout: 15_000 }, async context => {
  let displays;
  try { displays = JSON.parse(execFileSync(helper, ['--displays'], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' })); }
  catch (error) {
    if (/无法访问当前 Windows 桌面：\d+|请解锁 Windows|屏幕共享需要登录 Windows 桌面/.test(String(error.stderr))) { context.skip('Windows input desktop is locked or inaccessible in this test session'); return; }
    throw error;
  }
  assert.ok(displays.length > 0);
  assert.ok(displays[0].w > 0);
  const child = spawn(helper, ['--capture', '0', '640', '5'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const frame = await new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`capture exited ${code}`)));
      child.stdout.on('data', part => {
        data = Buffer.concat([data, part]);
        if (data.length >= 4 && data.length >= data.readUInt32LE(0) + 4) resolve(data.subarray(4, data.readUInt32LE(0) + 4));
      });
    });
    assert.equal(frame[0], 255); assert.equal(frame[1], 216);
    assert.ok(frame.length < 16 * 1024 * 1024);
  } finally { child.stdin.end(); }
  assert.equal((await exited)[0], 0);
});
test('input helper reports readiness, accepts Unicode in dry run, and exits on EOF', { skip: !supported, timeout: 10_000 }, async () => {
  const child = spawn(helper, ['0', '--dry-run'], { windowsHide: true });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); });
  const exited = once(child, 'exit');
  child.stdin.end(JSON.stringify({ t: 'text', s: 'Windows 中文输入' }) + '\n');
  assert.equal((await exited)[0], 0);
  assert.match(output, /"trusted":true/); assert.match(output, /Windows 中文输入/);
});
test('capture changes size and quality without restarting, pauses, and wakes on a keyframe request', { skip: !supported, timeout: 25_000 }, async context => {
  try { execFileSync(helper, ['--displays'], { windowsHide: true, stdio: 'pipe' }); }
  catch (error) {
    if (/无法访问当前 Windows 桌面：\d+|请解锁 Windows|屏幕共享需要登录 Windows 桌面/.test(String(error.stderr))) { context.skip('Windows desktop unavailable'); return; }
    throw error;
  }
  const child = spawn(helper, ['--capture', '0', '640', '30', '60'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let buffer = Buffer.alloc(0), frames = 0, current;
  child.stdout.on('data', part => {
    buffer = Buffer.concat([buffer, part]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0);
      current = Buffer.from(buffer.subarray(4, length + 4)); frames++;
      buffer = buffer.subarray(length + 4);
    }
  });
  async function until(predicate) {
    const end = Date.now() + 6000;
    while (!await predicate()) {
      assert.ok(Date.now() < end, 'capture did not produce expected frame');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const command = value => child.stdin.write(JSON.stringify(value) + '\n');
  try {
    await until(() => current);
    assert.equal((await sharp(current).metadata()).width, 640);
    // Verify actual pixels, not just the existence of a JPEG header.
    assert.ok((await sharp(current).stats()).channels.some(c => c.stdev > 5));
    command({t: 'profile', width: 854, fps: 24, quality: 66});
    await until(async () => current && (await sharp(current).metadata()).width === 854);
    command({t: 'pause', value: 1});
    await new Promise(resolve => setTimeout(resolve, 700));
    const pausedFrames = frames;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(frames, pausedFrames);
    command({t: 'pause', value: 0});
    await until(() => frames > pausedFrames);
    const beforeQuality = frames;
    command({t: 'profile', width: 854, fps: 24, quality: 85});
    await until(() => frames > beforeQuality);
    command({t: 'keyframe'});
    const beforeKey = frames;
    await until(() => frames > beforeKey);
    assert.equal(child.exitCode, null);
  } finally { child.stdin.end(); }
  assert.equal((await exited)[0], 0);
});
test('local screen opt-out blocks both capture and control', { skip: !supported }, () => {
  const home = mkdtempSync(join(tmpdir(), 'linkshell-screen-test-'));
  try {
    writeFileSync(join(home, 'windows-screen-disabled'), 'disabled');
    assert.throws(() => execFileSync(helper, ['--displays'], { windowsHide: true, env: { ...process.env, LINKSHELL_HOME: home }, stdio: 'pipe' }));
    assert.throws(() => execFileSync(helper, ['0', '--dry-run'], { windowsHide: true, env: { ...process.env, LINKSHELL_HOME: home }, input: '', stdio: 'pipe' }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('disabling sharing stops an idle input helper without waiting for another event', { skip: !supported, timeout: 10_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'linkshell-screen-idle-'));
  const child = spawn(helper, ['0', '--dry-run'], { windowsHide: true, env: { ...process.env, LINKSHELL_HOME: home } });
  const exited = once(child, 'exit');
  let output = '', disabled = false;
  child.stdout.on('data', data => {
    output += data.toString();
    if (!disabled && output.includes('"ready"')) { disabled = true; writeFileSync(join(home, 'windows-screen-disabled'), 'disabled'); }
  });
  try { assert.equal((await exited)[0], 1); assert.ok(disabled); }
  finally { child.stdin.end(); rmSync(home, { recursive: true, force: true }); }
});
