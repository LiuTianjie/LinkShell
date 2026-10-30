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
  root = mkdtempSync(join(tmpdir(), 'linkshell-installer-update-test-'));
  runner = join(root, 'InstallerUpdateTests.exe');
  execFileSync(join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${runner}`,
    '/r:System.Core.dll', resolve('src/InstallerUpdate.cs'), resolve('test/InstallerUpdateTests.cs'),
  ], { windowsHide: true, stdio: 'pipe' });
});
after(() => {
  if (root && resolve(root).startsWith(resolve(tmpdir()) + '\\linkshell-installer-update-test-')) rmSync(root, { recursive: true, force: true });
});
for (const scenario of ['parameters', 'handoff', 'short-path-handoff', 'short-ready-directory', 'foreign-parent', 'missing-home', 'junction-home', 'junction-ancestor', 'junction-target-ancestor', 'junction-both-aliases', 'junction-external', 'junction-external-missing', 'junction-dangling']) {
  test(`installer update handoff: ${scenario}`, { skip: !supported }, (t) => {
    const result = execFileSync(runner, [scenario, root], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
    for (const line of result.split(/\r?\n/).filter((line) => line.startsWith('INFO '))) t.diagnostic(line);
    assert.match(result, new RegExp(`PASS ${scenario}`));
  });
}
