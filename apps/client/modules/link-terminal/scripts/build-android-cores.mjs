#!/usr/bin/env node
// Rebuild all Android cores without changing the release ABI set.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'vendor-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const core = manifest['libghostty-vt'];
const pin = core;
const cache = join(root, 'android', '.ghostty-build');
await mkdir(cache, { recursive: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function archive(name, url, sha256) {
  const destination = join(cache, name);
  if (existsSync(destination) && digest(await readFile(destination)) === sha256) return destination;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== sha256) throw new Error(`Checksum mismatch: ${name}`);
  await writeFile(destination, bytes);
  return destination;
}
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
if (!arch || !['darwin', 'linux'].includes(process.platform)) throw new Error('Build on Linux or macOS with Docker and an Android NDK.');
const zig = manifest.buildTools[`zig-${arch}-linux`];
const zigArchive = await archive('zig.tar.xz', zig.url, zig.sha256);
const sourceArchive = await archive('ghostty.tar.gz', `https://codeload.github.com/ghostty-org/ghostty/tar.gz/${core.commit}`, pin.sourceArchiveSha256);
execFileSync('tar', ['-xf', zigArchive, '-C', cache], { stdio: 'inherit' });
execFileSync('tar', ['-xf', sourceArchive, '-C', cache], { stdio: 'inherit' });
const source = join(cache, `ghostty-${core.commit}`);
execFileSync('patch', ['-p1', '-i', join(root, 'patches/android-main-thread.patch')], { cwd: source, stdio: 'inherit' });
const candidates = [process.env.ANDROID_NDK_HOME, process.env.ANDROID_NDK_ROOT,
  process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'ndk', pin.ndk),
  process.platform === 'darwin' && join(process.env.HOME, 'Library/Android/sdk/ndk', pin.ndk)];
const ndk = candidates.find((candidate) => candidate && existsSync(candidate));
if (!ndk) throw new Error(`Set ANDROID_NDK_HOME to Android NDK ${pin.ndk}.`);
const flags = ['build', '-Demit-lib-vt', '-Dtarget=arm-linux-androideabi', '-Dsimd=false', '-Doptimize=ReleaseFast', '--prefix'];
for (const [abi, libraryPin] of Object.entries(core.libraries)) {
  const buildFlags = flags.map((flag) => flag === '-Dtarget=arm-linux-androideabi' ? `-Dtarget=${libraryPin.target}` : flag);
  if (process.platform === 'darwin') {
    const sysroot = join(resolve(ndk), 'toolchains/llvm/prebuilt/darwin-x86_64/sysroot');
    execFileSync('docker', ['run', '--rm', '-v', `${cache}:/work`, '-v', `${sysroot}:/ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot:ro`,
      '-e', 'ANDROID_NDK_HOME=/ndk', '-e', 'ZIG_GLOBAL_CACHE_DIR=/work/zig-cache', '-w', `/work/ghostty-${core.commit}`,
      'node:22', `/work/zig-${arch}-linux-${pin.zig}/zig`, ...buildFlags, `/work/output-${abi}`], { stdio: 'inherit' });
  } else {
    execFileSync(join(cache, `zig-${arch}-linux-${pin.zig}/zig`), [...buildFlags, join(cache, `output-${abi}`)], {
      cwd: source, env: { ...process.env, ANDROID_NDK_HOME: resolve(ndk), ZIG_GLOBAL_CACHE_DIR: join(cache, 'zig-cache') }, stdio: 'inherit',
    });
  }
  const library = await readFile(join(cache, `output-${abi}/lib/libghostty-vt.a`));
  const compressed = gzipSync(library, { level: 9 });
  await mkdir(dirname(join(root, libraryPin.archive)), { recursive: true });
  await writeFile(join(root, libraryPin.archive), compressed);
  libraryPin.librarySha256 = digest(library);
  libraryPin.archiveSha256 = digest(compressed);
  console.log(`Prepared ${abi} Ghostty: ${libraryPin.librarySha256}`);
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
