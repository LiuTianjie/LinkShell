import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// LinkShell.Screen.exe --fusion against a real window (docs/v2/fusion.md §8.2, §8.4): the app
// catalog, launching Notepad, seeing its window with title-bar measurements, resizing and closing.
const helper = resolve('build/LinkShell.Screen.exe');
const supported = process.platform === 'win32' && existsSync(helper);

function fusion() {
  const child = spawn(helper, ['--fusion'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const waiters = [];
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  const next = (match, timeoutMs = 15_000) => {
    const seen = messages.findLast?.(match) ?? [...messages].reverse().find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matching message; stderr: ${errors.trim()}`)), timeoutMs);
      waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return { child, next, send, errors: () => errors };
}

test('fusion helper lists apps, shows a launched app\'s window with its title bar, resizes and closes it', { skip: !supported, timeout: 60_000 }, async (context) => {
  const { child, next, send, errors } = fusion();
  try {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const first = await Promise.race([next((m) => m.t === 'monitors', 10_000), exited.then(() => undefined)]);
    if (!first) {
      if (/请解锁 Windows|屏幕共享需要登录 Windows 桌面|无法访问当前 Windows 桌面/.test(errors())) { context.skip('Windows input desktop is locked or inaccessible in this test session'); return; }
      assert.fail(`helper exited: ${errors()}`);
    }
    assert.ok(first.monitors.length > 0 && first.monitors[0].w > 0 && first.monitors[0].scale > 0);

    send({ t: 'apps', rid: 1 });
    const apps = await next((m) => m.rid === 1, 30_000);
    assert.ok(Array.isArray(apps.apps) && apps.apps.length > 0, 'the Start menu has apps');
    const notepad = apps.apps.find((a) => /notepad/i.test(a.app));
    if (!notepad) { context.skip('no Notepad in this image\'s Start menu'); return; }

    send({ t: 'launch', app: notepad.app, rid: 2 });
    assert.equal((await next((m) => m.rid === 2)).ok, true);
    const listed = await next((m) => m.t === 'windows' && m.windows.some((w) => !w.popup && w.app === notepad.app), 20_000);
    const window = listed.windows.find((w) => !w.popup && w.app === notepad.app);
    assert.ok(window.id > 0 && window.w > 100 && window.h > 100, JSON.stringify(window));
    assert.ok(window.buttons && window.buttons.close, `the close button is found by hit testing: ${JSON.stringify(window.buttons)}`);

    send({ t: 'resize', hwnd: window.id, w: 640, h: 480 });
    const resized = await next((m) => m.t === 'windows' && m.windows.some((w) => w.id === window.id && Math.abs(w.w - 640) <= 2 && Math.abs(w.h - 480) <= 2));
    assert.ok(resized);

    send({ t: 'icon', app: notepad.app, rid: 3 });
    const icon = await next((m) => m.rid === 3);
    if (icon.png) assert.equal(Buffer.from(icon.png, 'base64').subarray(1, 4).toString(), 'PNG');

    send({ t: 'close', hwnd: window.id });
    await next((m) => m.t === 'windows' && !m.windows.some((w) => w.id === window.id), 15_000);
  } finally {
    child.stdin.end();
  }
});
