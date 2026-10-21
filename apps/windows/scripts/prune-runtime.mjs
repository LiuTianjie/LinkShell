import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export function isRuntimeDependency(name) {
  // ClaudeDriver passes the user's own executable to ACP, as on macOS.
  return name !== '@linkshell/mac' && !/^@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-/.test(name);
}

export function isRuntimePath(path) {
  const normalized = path.replaceAll('\\', '/');
  const packages = normalized.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  for (const [, name] of packages) if (!isRuntimeDependency(name)) return false;
  if (/^src(?:\/|$)/.test(normalized)) return false;
  if (/(?:^|\/)node_modules\/node-pty\/(?:src|deps|third_party|scripts|typings|build\/Debug)(?:\/|$)/.test(normalized)) return false;
  const platform = /(?:^|\/)node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(normalized)?.[1];
  if (platform && platform !== 'win32-x64') return false;
  // Keep executable JS (including packages with src/node_modules) and all notices.
  return /license|notice|copying|copyright/i.test(basename(normalized)) ||
    !/(?:\.pdb|\.map|\.d\.(?:ts|mts|cts)|\.tsbuildinfo)$/i.test(normalized);
}

export function pruneRuntime(runtime) {
  const root = realpathSync(runtime);
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      // Staged packages must be materialized before pruning; never follow a junction.
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Nonportable runtime link: ${path}`);
      if (!isRuntimePath(relative(root, path))) {
        if (!realpathSync(path).startsWith(root + sep)) throw new Error(`Outside staged runtime: ${path}`);
        rmSync(path, { recursive: stat.isDirectory(), force: true });
      } else if (stat.isDirectory()) visit(path);
    }
  }
  visit(root);
}
