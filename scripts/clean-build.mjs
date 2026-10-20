import { readdirSync, rmSync } from 'node:fs';

// Keep package builds usable from cmd.exe, PowerShell and POSIX shells alike.
rmSync('dist', { recursive: true, force: true });
for (const file of readdirSync('.')) {
  if (file.endsWith('.tsbuildinfo')) rmSync(file);
}
