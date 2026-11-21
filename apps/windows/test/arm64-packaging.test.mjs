import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { resolveElectronTarget } from '../scripts/electron.mjs';
import { resolveMediaRelease } from '../scripts/media-runtime.mjs';
import { parseShasums, resolveNodeBinarySpec, resolveWindowsArch, windowsArtifactNames } from '../scripts/package.mjs';
import { pruneRuntime } from '../scripts/prune-runtime.mjs';

test('resolveWindowsArch defaults cleanly to x64 and supports x64/arm64 overrides', () => {
  assert.equal(resolveWindowsArch([], {}, 'win32', 'x64'), 'x64');
  assert.equal(resolveWindowsArch([], {}, 'win32', 'arm64'), 'arm64');
  assert.equal(resolveWindowsArch([], {}, 'darwin', 'arm64'), 'x64');
  assert.equal(resolveWindowsArch(['node', 'package.mjs', '--arch=arm64'], {}, 'win32', 'x64'), 'arm64');
  assert.equal(resolveWindowsArch(['node', 'package.mjs', '--arch', 'x64'], {}, 'win32', 'arm64'), 'x64');
  assert.equal(resolveWindowsArch([], { LINKSHELL_WINDOWS_ARCH: 'arm64' }, 'win32', 'x64'), 'arm64');
  assert.throws(() => resolveWindowsArch(['node', 'package.mjs', '--arch=ia32']), /Unsupported Windows architecture/);
});

test('windowsArtifactNames and resolveNodeBinarySpec produce arch-qualified outputs', () => {
  assert.deepEqual(windowsArtifactNames('0.10.113'), {
    arch: 'x64',
    archiveName: 'LinkShell-0.10.113-windows-x64.zip',
    installerName: 'LinkShell-Setup-0.10.113-windows-x64.exe',
  });
  assert.deepEqual(windowsArtifactNames('0.10.113', 'arm64'), {
    arch: 'arm64',
    archiveName: 'LinkShell-0.10.113-windows-arm64.zip',
    installerName: 'LinkShell-Setup-0.10.113-windows-arm64.exe',
  });

  const armNode = resolveNodeBinarySpec('22.21.0', 'arm64');
  assert.equal(armNode.url, 'https://nodejs.org/dist/v22.21.0/win-arm64/node.exe');
  assert.equal(armNode.checksumEntry, 'win-arm64/node.exe');

  const shasums = [
    '47cd67453da180a39cdf5daedb89862667b8e627e60c116607874633450cd30d  win-x64/node.exe',
    '17f35e7c7ed8626c6b9def40f57f8ae74ff6ff2e5788ca4bb0577d3e07d71bcc  win-arm64/node.exe',
  ].join('\n');
  assert.equal(parseShasums(shasums, 'win-arm64/node.exe'), '17f35e7c7ed8626c6b9def40f57f8ae74ff6ff2e5788ca4bb0577d3e07d71bcc');
  assert.equal(parseShasums(shasums, 'win-x64/node.exe'), '47cd67453da180a39cdf5daedb89862667b8e627e60c116607874633450cd30d');
});

test('electron and media runtime resolve native win32-x64 and win32-arm64 targets with verified SHA-256 sums', () => {
  const x64Electron = resolveElectronTarget('x64');
  const arm64Electron = resolveElectronTarget('arm64');
  assert.deepEqual(x64Electron.electronDistArgs.slice(-2), ['x64', 'win32']);
  assert.deepEqual(arm64Electron.electronDistArgs.slice(-2), ['arm64', 'win32']);
  assert.equal(arm64Electron.rceditAsset, 'rcedit-x64.exe');

  const x64Media = resolveMediaRelease('x64');
  const arm64Media = resolveMediaRelease('arm64');
  assert.match(x64Media.name, /win64-lgpl-shared-8\.1$/);
  assert.match(arm64Media.name, /winarm64-lgpl-shared-8\.1$/);
  assert.match(x64Media.sha256, /^[0-9a-f]{64}$/);
  assert.match(arm64Media.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(x64Media.sha256, arm64Media.sha256);
  assert.notEqual(x64Media.targetDir, arm64Media.targetDir);
});

test('pruneRuntime for arm64 retains win32-arm64 node-pty and sharp modules while removing x64 binaries', () => {
  const scratch = realpathSync(tmpdir());
  const root = mkdtempSync(join(scratch, 'linkshell-arm64-runtime-test-'));
  const keep = [
    'dist/cli/src/index.js',
    'node_modules/node-pty/prebuilds/win32-arm64/conpty.node',
    'node_modules/node-pty/prebuilds/win32-arm64/pty.node',
    'node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe',
    'node_modules/@img/sharp-win32-arm64/lib/sharp-win32-arm64.node',
    'node_modules/@img/sharp-libvips-win32-arm64/lib/libvips-42.dll',
    'node_modules/node-pty/LICENSE',
  ];
  const remove = [
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
    'node_modules/@img/sharp-libvips-win32-x64/lib/libvips-42.dll',
    'node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe',
  ];
  try {
    for (const path of [...keep, ...remove]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), path);
    }
    pruneRuntime(root, 'arm64');
    for (const path of keep) assert.ok(existsSync(join(root, path)), `ARM64 runtime file lost: ${path}`);
    for (const path of remove) assert.ok(!existsSync(join(root, path)), `Non-ARM64 file retained: ${path}`);
  } finally {
    assert.ok(realpathSync(root).startsWith(scratch + sep + 'linkshell-arm64-runtime-test-'));
    rmSync(root, { recursive: true, force: true });
  }
});
