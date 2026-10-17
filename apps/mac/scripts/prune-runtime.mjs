import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Keep executable runtime files and notices; native agents are the user's own installations. */
export function pruneRuntime(runtime, arch) {
  const store = join(runtime, 'node_modules/.pnpm');
  for (const name of readdirSync(store)) {
    // ClaudeDriver explicitly passes the user's Claude executable to ACP. Shipping a second
    // 200+ MB Claude binary would be unused and could diverge from the user's transcript format.
    if (name.startsWith('@anthropic-ai+claude-agent-sdk-darwin-')) rmSync(join(store, name), { recursive: true, force: true });
    if (name.startsWith('node-pty@')) {
      const pty = join(store, name, 'node_modules/node-pty');
      for (const directory of ['src', 'deps', 'third_party', 'scripts', 'typings']) rmSync(join(pty, directory), { recursive: true, force: true });
      const prebuilds = join(pty, 'prebuilds');
      for (const platform of readdirSync(prebuilds)) if (platform !== `darwin-${arch}`) rmSync(join(prebuilds, platform), { recursive: true, force: true });
    }
  }
  rmSync(join(runtime, 'src'), { recursive: true, force: true });
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (!existsSync(path) && readlinkSync(path).includes('claude-agent-sdk-darwin-')) rmSync(path);
      } else if (stat.isDirectory()) visit(path);
      else if (!/license|notice|copying|copyright/i.test(basename(path)) && /(?:\.map|\.d\.(?:ts|mts|cts)|\.tsbuildinfo)$/.test(name)) rmSync(path);
    }
  }
  visit(runtime);
}
