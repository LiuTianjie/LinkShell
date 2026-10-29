import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const supported = process.platform === 'win32';
let root, runner;
before(() => {
  if (!supported) return;
  root = mkdtempSync(join(tmpdir(), 'linkshell-installer-test-'));
  runner = join(root, 'InstallerTests.exe');
  execFileSync(join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${runner}`,
    '/r:System.Core.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    resolve('src/InstallerEngine.cs'), resolve('test/InstallerTests.cs'),
  ], { windowsHide: true, stdio: 'pipe' });
});
after(() => {
  if (root && resolve(root).startsWith(resolve(tmpdir()) + '\\linkshell-installer-test-')) rmSync(root, { recursive: true, force: true });
});
for (const scenario of ['fresh', 'cancel', 'cancel-at-commit', 'update', 'rollback', 'prepare-failure', 'foreign', 'locked', 'transient-lock', 'traversal', 'incomplete', 'shortcut-failure', 'long-path', 'shortcut-real', 'cleanup']) {
  test(`installer transaction: ${scenario}`, { skip: !supported }, () => {
    const result = execFileSync(runner, [scenario, root], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
    assert.match(result, new RegExp(`PASS ${scenario}`));
  });
}
