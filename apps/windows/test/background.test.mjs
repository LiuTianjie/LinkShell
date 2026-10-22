import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';

test('background Git, ACP terminals and MCP receive hidden-window startup and retain output', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { gitInfo } = await import('../../../packages/host/dist/host/src/worktrees.js');
  const { AcpClientServices } = await import('../../../packages/host/dist/host/src/drivers/acp/client-services.js');
  const { AcpMcpBridge } = await import('../../../packages/host/dist/host/src/drivers/acp/mcp.js');
  const scratch = realpathSync(tmpdir()), root = mkdtempSync(join(scratch, 'linkshell-background-test-'));
  const originalPath = process.env.PATH, previousLog = process.env.LINKSHELL_QA_STARTUP_LOG;
  const log = join(root, 'startup.jsonl'), executable = join(root, 'git.exe');
  const env = { ...process.env, LINKSHELL_QA_STARTUP_LOG: log };
  let terminals, mcp;
  try {
    execFileSync(join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/codepage:65001', '/r:System.Web.Extensions.dll', '/out:' + executable, resolve('test/BackgroundStartupProbe.cs')], { windowsHide: true });
    process.env.PATH = root + delimiter + originalPath;
    process.env.LINKSHELL_QA_STARTUP_LOG = log;
    assert.deepEqual(await gitInfo(root), { root, branch: 'qa-main', head: '123abcd', dirty: false });
    terminals = new AcpClientServices({ env, scope: () => ({ cwd: root }), output: () => {} });
    const { terminalId } = await terminals.request('terminal/create', { sessionId: 'qa', command: executable, args: ['--terminal'] });
    assert.equal((await terminals.request('terminal/wait_for_exit', { sessionId: 'qa', terminalId })).exitCode, 0);
    assert.match((await terminals.request('terminal/output', { sessionId: 'qa', terminalId })).output, /TERMINAL_READY/);
    mcp = new AcpMcpBridge({ env, notify: () => {}, request: async () => null });
    const serverId = mcp.open({ type: 'acp', name: 'startup-fixture', command: executable, args: ['--mcp'] }, root);
    assert.deepEqual(await mcp.request({ serverId, requestId: 'qa', method: 'tools/list' }, new AbortController().signal), { result: { tools: [] } });
    // Observe the flags received by actual native children, including all four Git probes.
    const records = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 6);
    assert.ok(records.every(record => record.hidden), JSON.stringify(records));
  } finally {
    await terminals?.close(); await mcp?.close();
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (previousLog === undefined) delete process.env.LINKSHELL_QA_STARTUP_LOG; else process.env.LINKSHELL_QA_STARTUP_LOG = previousLog;
    assert.ok(realpathSync(root).startsWith(scratch + sep + 'linkshell-background-test-'));
    rmSync(root, { recursive: true, force: true });
  }
});
