import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeWindowsArch } from './prune-runtime.mjs';

export const webrtcSdkTag = 'webrtc-a545de4';

// Official prebuilt Google libwebrtc M150 static Windows libraries (livekit/rust-sdks,
// standard MSVC C++20 STL /MT, H.264 + H.265/HEVC + FlexFEC + WGC enabled).
export const webrtcSdkReleases = {
  x64: {
    tag: webrtcSdkTag,
    name: 'webrtc-win-x64-release',
    subdir: 'win-x64-release',
    sha256: '862403fcb248c7d8803487e4c22b8821c6130e89100cb9c69be95ef45ff46146',
  },
  arm64: {
    tag: webrtcSdkTag,
    name: 'webrtc-win-arm64-release',
    subdir: 'win-arm64-release',
    sha256: '1666ced8f6b66f95c32acb33ab7f4775f3d2222412415defae91e2634fe67624',
  },
};

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveWebRtcSdk(arch = 'x64', env = process.env) {
  const targetArch = normalizeWindowsArch(arch);
  const release = webrtcSdkReleases[targetArch];
  const cacheDir = resolve(env.LINKSHELL_WEBRTC_CACHE || join(app, 'build', 'webrtc-cache'));
  const tagDir = join(cacheDir, release.tag);
  const rootDir = join(tagDir, release.subdir);
  const zipPath = join(cacheDir, `${release.name}-${release.tag}.zip`);
  const url = `https://github.com/livekit/rust-sdks/releases/download/${release.tag}/${release.name}.zip`;
  return { ...release, arch: targetArch, url, cacheDir, tagDir, rootDir, zipPath };
}

export async function ensureWebRtcSdk(archOrOptions = 'x64') {
  const arch = typeof archOrOptions === 'string' ? archOrOptions : archOrOptions?.arch ?? 'x64';
  const spec = resolveWebRtcSdk(arch);
  const marker = join(spec.rootDir, '.linkshell-sha256');
  const libPath = join(spec.rootDir, 'lib', 'webrtc.lib');
  const headerPath = join(spec.rootDir, 'include', 'api', 'peer_connection_interface.h');
  if (existsSync(libPath) && existsSync(headerPath) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === spec.sha256) {
    return spec.rootDir;
  }

  mkdirSync(spec.cacheDir, { recursive: true });
  mkdirSync(spec.tagDir, { recursive: true });

  const hasValidZip = existsSync(spec.zipPath)
    && createHash('sha256').update(readFileSync(spec.zipPath)).digest('hex') === spec.sha256;

  if (!hasValidZip) {
    console.log(`Downloading libwebrtc (${spec.arch}, ${spec.tag})...`);
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`libwebrtc SDK download failed (${response.status}): ${spec.url}`);
    const data = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== spec.sha256) {
      throw new Error(`libwebrtc (${spec.arch}) checksum mismatch: expected ${spec.sha256}, got ${actual}`);
    }
    writeFileSync(spec.zipPath, data);
  }

  rmSync(spec.rootDir, { recursive: true, force: true });
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const extract = spawnSync(tar, ['-xf', spec.zipPath, '-C', spec.tagDir], { windowsHide: true, stdio: 'inherit' });
  if (extract.error || extract.status !== 0) {
    throw extract.error ?? new Error(`Cannot extract libwebrtc SDK (${extract.status})`);
  }
  if (!existsSync(libPath) || !existsSync(headerPath)) {
    throw new Error(`Extracted libwebrtc SDK is missing lib/webrtc.lib or headers in ${spec.rootDir}`);
  }
  writeFileSync(marker, `${spec.sha256}\n`);
  // Remove the zip after verified extraction so CI caches stay compact.
  rmSync(spec.zipPath, { force: true });
  return spec.rootDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inline = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7);
  const idx = process.argv.indexOf('--arch');
  const cliArch = inline ?? (idx >= 0 ? process.argv[idx + 1] : undefined) ?? process.env.LINKSHELL_WINDOWS_ARCH ?? 'x64';
  console.log(await ensureWebRtcSdk(cliArch));
}
