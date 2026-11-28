import { cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../../../', import.meta.url);
execFileSync('pnpm', ['--filter', '@linkshell/desktop-ui', 'build'], { cwd: root, stdio: 'inherit' });
const output = new URL('../web-client/', import.meta.url);
rmSync(output, { recursive: true, force: true });
cpSync(new URL('apps/desktop-ui/dist/', root), output, { recursive: true });
// Fusion's hidden Electron window entrypoint is never served by the browser gateway.
rmSync(new URL('fusion.html', output), { force: true });
