import { cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = new URL('../../../', import.meta.url);
execFileSync('pnpm', ['--filter', '@linkshell/web', 'build'], { cwd: root, stdio: 'inherit' });
const output = new URL('../web-client/', import.meta.url);
rmSync(output, { recursive: true, force: true });
cpSync(new URL('apps/web/dist/', root), output, { recursive: true });
