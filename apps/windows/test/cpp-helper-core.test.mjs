import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function findCpp20Compiler() {
  const candidates = process.platform === 'win32'
    ? [
        { cmd: 'clang++.exe', style: 'gnu' },
        { cmd: 'cl.exe', style: 'msvc' },
      ]
    : [
        { cmd: 'clang++', style: 'gnu' },
        { cmd: 'g++', style: 'gnu' },
      ];
  for (const c of candidates) {
    const probe = spawnSync(c.cmd, c.style === 'msvc' ? [] : ['--version'], { stdio: 'pipe', windowsHide: true });
    if (!probe.error && (probe.status === 0 || c.style === 'msvc')) return c;
  }
  return null;
}

test('portable C++20 helper_core unit suite compiles and passes', (context) => {
  const compiler = findCpp20Compiler();
  if (!compiler) {
    context.skip('No local C++20 compiler found on PATH');
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'linkshell-cpp20-helper-'));
  const includeDir = resolve('media/src');
  const sourceFile = resolve('media/test/helper_core_test.cpp');
  const outBin = join(scratch, process.platform === 'win32' ? 'helper_core_test.exe' : 'helper_core_test');

  try {
    if (compiler.style === 'msvc') {
      execFileSync(compiler.cmd, [
        '/nologo', '/utf-8', '/EHsc', '/std:c++20', `/I${includeDir}`, sourceFile, `/Fe:${outBin}`,
      ], { cwd: scratch, stdio: 'pipe', windowsHide: true });
    } else {
      execFileSync(compiler.cmd, [
        '-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror',
        ...(process.platform === 'win32' ? ['-D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH'] : []),
        `-I${includeDir}`, sourceFile, '-o', outBin,
      ], { stdio: 'pipe', windowsHide: true });
    }

    const stdout = execFileSync(outBin, [], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    assert.match(stdout, /helper_core_test passed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
