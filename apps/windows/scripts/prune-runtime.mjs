import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export function normalizeWindowsArch(arch = 'x64') {
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported Windows architecture: ${arch}`);
  return arch;
}

export function isRuntimeDependency(name, arch = 'x64') {
  const targetArch = normalizeWindowsArch(arch);
  if (name === '@linkshell/mac' || /^@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-/.test(name)) return false;
  if (/^@img\/sharp-(?:libvips-)?(?:darwin|linux|freebsd|openbsd|win32)-/.test(name) && !name.endsWith(`-win32-${targetArch}`)) return false;
  return true;
}

export function isRuntimePath(path, arch = 'x64') {
  const targetArch = normalizeWindowsArch(arch);
  const normalized = path.replaceAll('\\', '/');
  const packages = normalized.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  for (const [, name] of packages) if (!isRuntimeDependency(name, targetArch)) return false;
  if (/^src(?:\/|$)/.test(normalized)) return false;
  if (/(?:^|\/)node_modules\/node-pty\/(?:src|deps|third_party|scripts|typings|build\/Debug)(?:\/|$)/.test(normalized)) return false;
  const platform = /(?:^|\/)node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(normalized)?.[1];
  if (platform && platform !== `win32-${targetArch}`) return false;
  // Keep executable JS (including packages with src/node_modules) and all notices.
  return /license|notice|copying|copyright/i.test(basename(normalized)) ||
    !/(?:\.pdb|\.map|\.d\.(?:ts|mts|cts)|\.tsbuildinfo)$/i.test(normalized);
}

export function pruneRuntime(runtime, arch = 'x64') {
  const targetArch = normalizeWindowsArch(arch);
  const root = realpathSync(runtime);
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      // Staged packages must be materialized before pruning; never follow a junction.
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Nonportable runtime link: ${path}`);
      if (!isRuntimePath(relative(root, path), targetArch)) {
        if (!realpathSync(path).startsWith(root + sep)) throw new Error(`Outside staged runtime: ${path}`);
        rmSync(path, { recursive: stat.isDirectory(), force: true });
      } else if (stat.isDirectory()) visit(path);
    }
  }
  visit(root);
}
