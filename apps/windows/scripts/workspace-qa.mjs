import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { ensureWebView2 } from './webview2.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');
const build = join(app, 'build');
const framework = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const refs = ['PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml'].map(name => `/r:${join(existsSync(join(framework, 'WPF', name + '.dll')) ? join(framework, 'WPF') : framework, name + '.dll')}`);
const executable = join(build, 'LinkShell.WorkspaceQA.exe');
const compiled = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/platform:x64', '/codepage:65001', '/target:exe', '/main:LinkShell.Windows.WorkspaceTests', `/out:${executable}`, ...refs, ...await ensureWebView2(), '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.Net.Http.dll', ...['src/Desktop.cs', 'src/Dashboard.cs', 'src/Workspace.cs', 'test/WorkspaceTests.cs'].map(name => join(app, name))], { windowsHide: true, stdio: 'inherit' });
if (compiled.error || compiled.status) throw compiled.error ?? new Error('Workspace QA compilation failed');
if (!process.argv.includes('--native')) {
  const result = spawnSync(executable, [], { windowsHide: true, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const home = mkdtempSync(join(tmpdir(), 'linkshell-workspace-qa-'));
process.env.LINKSHELL_HOME = home;
process.env.LINKSHELL_WINDOWS_HELPER = join(build, 'LinkShell.Screen.exe');
const { startHost } = await import('../../../packages/host/dist/host/src/index.js');
const driver = {
  id: 'codex', label: 'Codex (QA fixture)', tier: 'multi_client',
  behavior: { desktop: 'multi_client', history: 'native-snapshot', turnCompletion: 'native-events', busyInput: 'queue', fork: 'context', detach: 'local-only' },
  capabilities: { interrupt: true, steer: false, permissions: true, images: false, fork: false, models: false, modes: false },
  start: async () => ({ installed: true }), status: () => ({ installed: true }), stop: async () => {},
  listSessions: async () => [{ nativeId: 'workspace-qa', title: 'Windows 工作台 QA', cwd: home, createdAt: Date.now(), updatedAt: Date.now() }],
  attach: async () => [{ itemId: 'history-1', updates: [{ sessionUpdate: 'agent_message_chunk', messageId: 'history-1', content: { type: 'text', text: '工作台历史消息' } }] }],
  detach: async () => {},
};
const host = await startHost({ home, version: 'workspace-qa', drivers: () => [driver], iceServers: false, log: () => {} });
try {
  const child = spawn(executable, ['--native'], { windowsHide: true, stdio: 'inherit', env: {
    ...process.env, LINKSHELL_GATEWAY: 'off', LINKSHELL_DESKTOP_NODE: process.execPath,
    LINKSHELL_DESKTOP_CLI: join(root, 'packages/cli/dist/cli/src/index.js'), LINKSHELL_DESKTOP_WEB: join(root, 'apps/web/dist'),
    LINKSHELL_WORKSPACE_QA_OUTPUT: join(build, 'workspace-qa.png'),
  } });
  const timer = setTimeout(() => child.kill(), 120000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  if (code !== 0) throw new Error(`Native workspace QA failed: ${code}`);
} finally { await host.stop(); await rm(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); }
