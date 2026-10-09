#!/usr/bin/env node
// Keep the community renderer and the existing iOS patches on the same core.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'vendor-manifest.json'), 'utf8'));
const spm = manifest['libghostty-spm'];
const pin = spm.smoothScroll;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const patch = await readFile(join(root, pin.patch));
if (hash(patch) !== pin.patchSha256) throw new Error('iOS smooth-scroll patch checksum mismatch');
const input = hash(JSON.stringify({ commit: spm.commit, ...pin }));
const frameworks = join(root, 'ios/vendor/Frameworks');
const destination = join(frameworks, 'GhosttyKit.xcframework');
const stamp = join(frameworks, '.smooth-scroll.json');
const slices = ['ios-arm64', 'ios-arm64_x86_64-simulator'];
try {
  const installed = JSON.parse(await readFile(stamp, 'utf8'));
  if (existsSync(join(destination, 'Info.plist')) && installed.input === input && (await Promise.all(slices.map(async (slice) =>
    hash(await readFile(join(destination, slice, 'libghostty.a'))) === installed.libraries[slice]
  ))).every(Boolean)) {
    await rm(join(frameworks, '.checksum'), { force: true });
    console.log('[LinkTerminal] community Ghostty iOS core verified');
    process.exit(0);
  }
} catch { /* Missing or changed artifacts are rebuilt from pinned inputs. */ }

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The community iOS core currently requires an Apple silicon Mac to build.');
}
const cache = join(process.env.LINKSHELL_GHOSTTY_BUILD_CACHE || join(homedir(), 'Library/Caches/LinkShell/Ghostty'), input);
await mkdir(cache, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
async function archive(url, sha256, name, directory) {
  const path = join(cache, name);
  if (!existsSync(path) || hash(await readFile(path)) !== sha256) {
    console.log(`[LinkTerminal] fetching ${name}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== sha256) throw new Error(`${name}: checksum mismatch`);
    await writeFile(path, bytes);
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  run('tar', ['-xf', path, '-C', directory, '--strip-components=1']);
}
const output = join(cache, 'GhosttyKit.xcframework');
if (!existsSync(join(output, 'Info.plist'))) {
  const source = join(cache, 'ghostty');
  const adapter = join(cache, 'libghostty-spm');
  const zig = join(cache, 'zig');
  await archive(pin.zig.url, pin.zig.sha256, 'zig.tar.xz', zig);
  await archive(`https://codeload.github.com/ghostty-org/ghostty/tar.gz/${pin.ghosttyCommit}`, pin.ghosttySourceSha256, 'ghostty.tar.gz', source);
  await archive(`https://codeload.github.com/Lakr233/libghostty-spm/tar.gz/${spm.commit}`, pin.spmSourceSha256, 'spm.tar.gz', adapter);
  const env = { ...process.env, PATH: `${zig}:${process.env.PATH}`, BUILD_CACHE_ROOT: join(cache, 'build-cache'), ZIG_GLOBAL_CACHE_DIR: join(cache, 'build-cache/zig-global') };
  // Fetch the Apple dependency graph before the adapter's patcher (which
  // otherwise fetches every platform, including unrelated Linux fontconfig).
  run(join(zig, 'zig'), ['build', '--fetch', '-Dtarget=aarch64-ios-simulator', '-Dapp-runtime=none', '-Demit-exe=false', '-Demit-macos-app=false', '-Demit-xcframework=false', '-Dsentry=false'], { cwd: source, env });
  // Apply the iOS stack once before the rebased Macterm patch. Reapplying the
  // original patches after it would conflict with their now-extended hunks.
  run('zsh', [join(adapter, 'Script/apply-patches.sh'), source], { env });
  run('git', ['-C', source, 'apply', '--check', join(root, pin.patch)]);
  run('git', ['-C', source, 'apply', join(root, pin.patch)]);
  const builder = join(adapter, 'Script/build-ghostty.sh');
  const text = await readFile(builder, 'utf8');
  const apply = 'ZIG_GLOBAL_CACHE_DIR="$GLOBAL_CACHE_DIR" ./Script/apply-patches.sh "$SOURCE_DIR"';
  if (!text.includes(apply)) throw new Error('Pinned upstream build script changed');
  await writeFile(builder, text.replace(apply, '# Patch stack already applied by LinkShell.'));
  await writeFile(join(adapter, 'Patches/ghostty/9999-linkshell-smooth-scroll.patch'), patch);
  run('bash', [join(adapter, 'Script/build-platform.sh'), source, 'ios', join(cache, 'artifacts')], { env });
  run('bash', [join(adapter, 'Script/merge-xcframework.sh'), join(cache, 'artifacts'), output], { env });
}
const libraries = Object.fromEntries(await Promise.all(slices.map(async (slice) =>
  [slice, hash(await readFile(join(output, slice, 'libghostty.a')))]
)));
await mkdir(frameworks, { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(output, destination, { recursive: true });
await writeFile(stamp, `${JSON.stringify({ input, libraries }, null, 2)}\n`);
await rm(join(frameworks, '.checksum'), { force: true });
console.log('[LinkTerminal] community Ghostty core ready: iOS arm64, simulator arm64 + x86_64');
