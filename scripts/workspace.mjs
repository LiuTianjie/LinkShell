import { spawnSync } from 'node:child_process';

const action = process.argv[2];
if (!['build', 'typecheck', 'test'].includes(action)) throw new Error('Unknown workspace action');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run this script through pnpm');
const result = spawnSync(process.execPath, [pnpm, '-r', ...(process.platform !== 'darwin' ? ['--filter', '!@linkshell/mac'] : []), ...(action === 'test' ? ['--if-present', '--workspace-concurrency=1'] : []), action], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
