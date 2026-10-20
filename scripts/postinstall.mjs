import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform === 'darwin' && existsSync('node_modules/.pnpm')) {
  for (const name of readdirSync('node_modules/.pnpm').filter(name => name.startsWith('node-pty@'))) {
    for (const arch of ['arm64', 'x64']) {
      const file = join('node_modules/.pnpm', name, 'node_modules/node-pty/prebuilds', `darwin-${arch}`, 'spawn-helper');
      if (existsSync(file)) chmodSync(file, 0o755);
    }
  }
}
