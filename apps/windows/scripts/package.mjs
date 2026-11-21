import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstaller } from './installer.mjs';
import { ensureMedia } from './media-runtime.mjs';
import { assembleElectron } from './electron.mjs';
import { isRuntimeDependency, isRuntimePath, normalizeWindowsArch, pruneRuntime } from './prune-runtime.mjs';
import { signWindowsBinaries } from './sign.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');

export function resolveWindowsArch(argv = process.argv, env = process.env, platform = process.platform, hostArch = process.arch) {
  const inline = argv.find(arg => arg.startsWith('--arch='))?.slice(7);
  const flagIndex = argv.indexOf('--arch');
  const flagValue = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const raw = inline ?? flagValue ?? env.LINKSHELL_WINDOWS_ARCH ?? (platform === 'win32' && hostArch === 'arm64' ? 'arm64' : 'x64');
  return normalizeWindowsArch(raw);
}

export function windowsArtifactNames(version, arch = 'x64') {
  const targetArch = normalizeWindowsArch(arch);
  return {
    arch: targetArch,
    archiveName: `LinkShell-${version}-windows-${targetArch}.zip`,
    installerName: `LinkShell-Setup-${version}-windows-${targetArch}.exe`,
  };
}

export function resolveNodeBinarySpec(nodeVersion, arch = 'x64') {
  const targetArch = normalizeWindowsArch(arch);
  return {
    arch: targetArch,
    url: `https://nodejs.org/dist/v${nodeVersion}/win-${targetArch}/node.exe`,
    shasumsUrl: `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`,
    checksumEntry: `win-${targetArch}/node.exe`,
  };
}

export function parseShasums(text, entryName) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === entryName) return match[1].toLowerCase();
  }
  return undefined;
}

async function resolveTargetNodeExe(artifacts, arch) {
  if (arch === process.arch) return process.execPath;
  const spec = resolveNodeBinarySpec(process.versions.node, arch);
  const cached = join(artifacts, `node-${process.versions.node}-win-${arch}.exe`);
  const sumsResponse = await fetch(spec.shasumsUrl);
  if (!sumsResponse.ok) throw new Error(`Cannot fetch Node checksums (${sumsResponse.status})`);
  const expected = parseShasums(await sumsResponse.text(), spec.checksumEntry);
  if (!expected) throw new Error(`Missing Node checksum entry for ${spec.checksumEntry}`);
  if (existsSync(cached) && createHash('sha256').update(readFileSync(cached)).digest('hex') === expected) {
    return cached;
  }
  const exeResponse = await fetch(spec.url);
  if (!exeResponse.ok) throw new Error(`Cannot fetch Node binary for ${arch} (${exeResponse.status})`);
  const bytes = Buffer.from(await exeResponse.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Node ${arch} checksum mismatch`);
  writeFileSync(cached, bytes);
  return cached;
}

async function runPackage() {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new Error('Package on Windows x64 or arm64.');
  }
  const arch = resolveWindowsArch();
  const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'))).version;
  const { archiveName, installerName } = windowsArtifactNames(version, arch);
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const reuse = process.argv.find(arg => arg.startsWith('--stage='))?.slice(8);
  const scratch = reuse ? resolve(reuse) : mkdtempSync(join(artifacts, `windows-stage-${arch}-`));
  if (!scratch.startsWith(artifacts + '\\') || !/^windows-stage-/.test(relative(artifacts, scratch))) {
    throw new Error('Staging must be a windows-stage-* directory inside artifacts.');
  }
  const bundle = join(scratch, 'LinkShell');
  const runtime = join(bundle, 'runtime');
  const cli = join(runtime, 'cli');
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  };
  const pnpm = process.env.npm_execpath;
  if (!pnpm || !/pnpm\.(?:c?js)$/.test(pnpm)) throw new Error('Run through pnpm: pnpm --filter @linkshell/windows build:standalone');
  run(process.execPath, [join(app, 'scripts/build.mjs')]);
  run(process.execPath, [pnpm, '--filter', '@linkshell/desktop-ui', 'build']);
  run(process.execPath, [pnpm, '--filter', '@linkshell/desktop', 'exec', 'tsc', '-p', 'tsconfig.json']);
  mkdirSync(runtime, { recursive: true });
  // Deploy the locked production graph. The portable copy replaces junctions with real files.
  const deployed = join(scratch, 'deployed');
  if (!reuse) run(process.execPath, [pnpm, '--filter', 'linkshell-cli', '--prod', 'deploy', '--legacy', deployed]);
  function portable(source, target, ancestors = new Set(), packageRoot = false) {
    if (!isRuntimePath(relative(cli, target), arch)) return;
    const real = realpathSync(source);
    if (ancestors.has(real)) return; // pnpm's package self-reference is not needed at runtime.
    const stat = lstatSync(real);
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      const next = new Set([...ancestors, real]);
      for (const name of readdirSync(real)) {
        // Some packages ship source modules under src/node_modules (binary-data does).
        // Only dependency links at the package root are reconstructed by packageCopy.
        if (packageRoot && name === 'node_modules') continue;
        portable(join(real, name), join(target, name), next);
      }
    } else {
      // Avoid rewriting unchanged native binaries during a source-only package refresh.
      if (reuse && existsSync(target) && statSync(target).size === stat.size && readFileSync(real).equals(readFileSync(target))) return;
      cpSync(real, target);
    }
  }
  // Top-level links in pnpm's graph do not contain their dependency links: materialize per package.
  const copied = new Set();
  function packageCopy(source, target, stack = new Set()) {
    const real = realpathSync(source);
    if (stack.has(real) || copied.has(target)) return;
    copied.add(target);
    const next = new Set([...stack, real]);
    portable(real, target, new Set(), true);
    const pkg = JSON.parse(readFileSync(join(real, 'package.json')));
    for (const name of Object.keys({ ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (!isRuntimeDependency(name, arch)) continue;
      let directory = real, found;
      for (;;) {
        const candidate = join(directory, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) { found = candidate; break; }
        const parent = dirname(directory);
        if (directory === parent) break;
        directory = parent;
      }
      if (!found) {
        if (pkg.optionalDependencies?.[name] || pkg.peerDependencies?.[name]) continue;
        throw new Error(`Missing runtime dependency: ${pkg.name} -> ${name}`);
      }
      // Hoist a single version to keep Windows paths short. Conflicting versions stay nested.
      const wanted = JSON.parse(readFileSync(join(found, 'package.json'))).version;
      const top = join(cli, 'node_modules', name);
      if (!existsSync(join(top, 'package.json')) || JSON.parse(readFileSync(join(top, 'package.json'))).version === wanted) packageCopy(found, top, next);
      else packageCopy(found, join(target, 'node_modules', name), next);
    }
  }
  packageCopy(deployed, cli);
  console.log(`Windows (${arch}) runtime dependencies copied (${copied.size} packages).`);
  // A cached dependency graph is reusable while source builds are refreshed every time.
  for (const name of ['cli', 'host', 'gateway', 'wire']) {
    const target = name === 'cli' ? cli : join(cli, 'node_modules/@linkshell', name);
    cpSync(join(root, 'packages', name, 'dist'), join(target, 'dist'), { recursive: true });
  }
  // Also clean reused staging directories created before these exclusions existed.
  pruneRuntime(cli, arch);
  cpSync(await resolveTargetNodeExe(artifacts, arch), join(runtime, 'node.exe'));
  const nodeLicense = join(artifacts, `node-${process.versions.node}-LICENSE.txt`);
  if (!existsSync(nodeLicense)) {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
    if (!response.ok) throw new Error(`Cannot fetch bundled Node license: ${response.status}`);
    const license = await response.text();
    if (!license.includes('Node.js') || !license.includes('Permission is hereby granted')) throw new Error('Invalid Node license');
    writeFileSync(nodeLicense, license);
  }
  cpSync(nodeLicense, join(runtime, 'NODE-LICENSE.txt'));
  cpSync(join(app, 'build/LinkShell.Screen.exe'), join(bundle, 'LinkShell.Screen.exe'));
  // A reused staging directory may still hold the earlier WebView2 window's loader.
  for (const file of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Wpf.dll', 'WebView2Loader.dll', 'WEBVIEW2-LICENSE.txt', 'WEBVIEW2-NOTICE.txt']) rmSync(join(bundle, file), { force: true });
  await assembleElectron(bundle, version, arch);
  signWindowsBinaries([join(bundle, 'LinkShell.exe'), join(bundle, 'LinkShell.Screen.exe')]);
  // Delete only the owned staged assets so an upgrade never carries stale web bundles.
  const workspaceAssets = join(bundle, 'workspace');
  rmSync(workspaceAssets, { recursive: true, force: true });
  cpSync(join(root, 'apps/desktop-ui/dist'), workspaceAssets, { recursive: true });
  cpSync(await ensureMedia(arch), join(bundle, 'media'), { recursive: true });
  cpSync(join(root, 'LICENSE'), join(bundle, 'LICENSE'));
  writeFileSync(join(bundle, 'standalone.json'), JSON.stringify({ version, nodeVersion: process.versions.node, platform: 'win32', arch }, null, 2));
  writeFileSync(join(bundle, 'linkshell.cmd'), '@echo off\r\nsetlocal\r\nset "LINKSHELL_APP_BUNDLE=%~dp0"\r\nset "LINKSHELL_WINDOWS_HELPER=%~dp0LinkShell.Screen.exe"\r\n"%~dp0runtime\\node.exe" "%~dp0runtime\\cli\\dist\\cli\\src\\index.js" %*\r\nexit /b %errorlevel%\r\n');
  if (arch === process.arch) {
    run(join(runtime, 'node.exe'), [join(cli, 'dist/cli/src/index.js'), '--version']);
    run(process.execPath, [join(app, 'scripts/smoke.mjs'), bundle]);
  } else {
    console.log(`[package] Skipping execution smoke on ${process.arch} host for ${arch} target bundle.`);
  }
  const archive = join(artifacts, archiveName);
  if (existsSync(archive)) rmSync(archive);
  run('tar.exe', ['-a', '-cf', archive, '-C', bundle, '.']);
  const installer = join(artifacts, installerName);
  buildInstaller(archive, installer);
  for (const file of [archive, installer]) writeFileSync(`${file}.sha256`, `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${relative(artifacts, file)}\n`);
  console.log(`Windows (${arch}) package: ${installer}\nPortable: ${archive}\nStaging: ${bundle}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPackage();
}
