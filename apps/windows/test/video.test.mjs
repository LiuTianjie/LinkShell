import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const helper = resolve('build/LinkShell.Screen.exe'), ffmpeg = resolve('build/media/ffmpeg.exe');
const skip = process.platform !== 'win32' || !existsSync(helper) || !existsSync(ffmpeg);
function accessible(context) {
  try { execFileSync(helper, ['--displays'], { windowsHide: true, stdio: 'pipe' }); return true; }
  catch (error) {
    if (/无法访问当前 Windows 桌面：\d+|请解锁 Windows|屏幕共享需要登录 Windows 桌面/.test(String(error.stderr))) { context.skip('Windows input desktop is unavailable'); return false; }
    throw error;
  }
}
function capture(env = process.env) {
  const child = spawn(helper, ['--video', '0', '640', '30', '1500000', ffmpeg], { windowsHide: true, env });
  const exited = once(child, 'exit');
  const parts = []; let errors = '';
  child.stdout.on('data', data => parts.push(data));
  child.stderr.on('data', data => { errors += data; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No hardware video: ' + errors)), 12_000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Video exited ${code}: ${errors}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return { child, ready, exited, parts, errors: () => errors };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('hardware H.264 is decodable and capture exits on parent EOF', { skip, timeout: 20_000 }, async context => {
  if (!accessible(context)) return;
  const session = capture();
  try { await session.ready; await delay(1500); }
  finally { session.child.stdin.end(); }
  assert.equal((await session.exited)[0], 0);
  assert.match(session.errors(), /\[video\] encoder=h264_(amf|nvenc|qsv|mf)/);
  const decoded = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-f', 'md5', 'pipe:1'], { windowsHide: true, input: Buffer.concat(session.parts), encoding: 'utf8', timeout: 5000 });
  assert.match(decoded, /MD5=[0-9a-f]{32}/);
});

test('disabling sharing terminates an active hardware capture', { skip, timeout: 20_000 }, async context => {
  if (!accessible(context)) return;
  const home = mkdtempSync(join(tmpdir(), 'linkshell-video-test-'));
  const session = capture({ ...process.env, LINKSHELL_HOME: home });
  try {
    await session.ready;
    writeFileSync(join(home, 'windows-screen-disabled'), 'disabled');
    assert.equal((await session.exited)[0], 1);
    assert.match(session.errors(), /允许远程屏幕/);
  } finally { session.child.stdin.end(); if (session.child.exitCode === null) session.child.kill(); rmSync(home, { recursive: true, force: true }); }
});

test('killing the native guard also kills its hardware encoder', { skip, timeout: 20_000 }, async context => {
  if (!accessible(context)) return;
  const session = capture();
  try {
    await session.ready;
    const pid = Number([...session.errors().matchAll(/\[video\] child=(\d+)/g)].at(-1)?.[1]);
    assert.ok(pid > 0);
    session.child.kill('SIGKILL'); await session.exited;
    await delay(300);
    assert.throws(() => process.kill(pid, 0));
  } finally { session.child.stdin.end(); if (session.child.exitCode === null) session.child.kill(); }
});
