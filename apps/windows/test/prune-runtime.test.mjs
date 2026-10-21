import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pruneRuntime } from '../scripts/prune-runtime.mjs';

test('pruning reused bundles retains executable modules, x64 terminals and notices', () => {
  const scratch = realpathSync(tmpdir());
  const root = mkdtempSync(join(scratch, 'linkshell-runtime-test-'));
  const keep = [
    'dist/cli/src/index.js',
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    'node_modules/@linkshell/host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    'node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js',
    'node_modules/binary-data/src/node_modules/parser.js',
    'node_modules/node-pty/lib/worker/conoutSocketWorker.js',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
    'node_modules/node-pty/build/Release/conpty/conpty.dll',
    'node_modules/node-pty/LICENSE',
    'node_modules/example/LICENSE.map',
  ];
  const remove = [
    'src/index.ts',
    'dist/cli/src/index.js.map',
    'dist/cli/src/index.d.ts',
    'node_modules/@linkshell/mac/LinkShell.app.tar.gz',
    'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
    'node_modules/@linkshell/host/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
    'node_modules/node-pty/prebuilds/win32-arm64/conpty.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.pdb',
    'node_modules/node-pty/build/Release/conpty.pdb',
    'node_modules/node-pty/third_party/conpty/win10-arm64/OpenConsole.exe',
    'node_modules/node-pty/src/windowsPtyAgent.ts',
  ];
  try {
    for (const path of [...keep, ...remove]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), path);
    }
    pruneRuntime(root);
    pruneRuntime(root);
    for (const path of keep) assert.ok(existsSync(join(root, path)), `Runtime file lost: ${path}`);
    for (const path of remove) assert.ok(!existsSync(join(root, path)), `Unneeded file retained: ${path}`);
  } finally {
    assert.ok(realpathSync(root).startsWith(scratch + sep + 'linkshell-runtime-test-'));
    rmSync(root, { recursive: true, force: true });
  }
});
