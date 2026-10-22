import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('tray panel survives deactivation during closing without reopening or crashing', { skip: process.platform !== 'win32' }, () => {
  const scratch = realpathSync(tmpdir()), root = mkdtempSync(join(scratch, 'linkshell-tray-test-'));
  const framework = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const runner = join(root, 'TrayPanelTests.exe');
  try {
    const references = ['PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml'].map(name => {
      const wpf = join(framework, 'WPF', name + '.dll');
      return '/r:' + (existsSync(wpf) ? wpf : join(framework, name + '.dll'));
    });
    execFileSync(join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001', `/out:${runner}`, ...references,
      resolve('src/TrayPanel.cs'), resolve('test/TrayPanelTests.cs')], { windowsHide: true, stdio: 'pipe' });
    const result = execFileSync(runner, [], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.match(result, /PASS tray dismissal/);
  } finally {
    assert.ok(realpathSync(root).startsWith(scratch + sep + 'linkshell-tray-test-'));
    rmSync(root, { recursive: true, force: true });
  }
});
