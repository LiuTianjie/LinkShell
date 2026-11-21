import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeWindowsArch } from './prune-runtime.mjs';

// A shared LGPL build: no GPL encoders, and the libraries remain replaceable.
export const mediaReleases = {
  x64: {
    tag: 'autobuild-2026-11-18-12-39',
    name: 'ffmpeg-n8.1.3-36-ge22a4510c9-win64-lgpl-shared-8.1',
    sha256: '13a795e5620236ca4c304b580f0155130bdcecd87bf5e9f66f84b59d98783668',
    asset: 763357000,
  },
  arm64: {
    tag: 'autobuild-2026-11-18-12-39',
    name: 'ffmpeg-n8.1.3-36-ge22a4510c9-winarm64-lgpl-shared-8.1',
    sha256: '0fa5c8be51bf6fa3d6c58f26e1be62941bbb8f3ad54786c5b332b78d6d48f097',
    asset: 763357328,
  },
};
export const mediaRelease = mediaReleases.x64;

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveMediaRelease(arch = 'x64') {
  const targetArch = normalizeWindowsArch(arch);
  const release = mediaReleases[targetArch];
  const url = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/${release.tag}/${release.name}.zip`;
  const assetUrl = `https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/assets/${release.asset}`;
  const targetDir = targetArch === 'x64' ? join(app, 'build', 'media') : join(app, 'build', `media-${targetArch}`);
  return { ...release, arch: targetArch, url, assetUrl, targetDir };
}

export async function ensureMedia(archOrOptions = 'x64') {
  const arch = typeof archOrOptions === 'string' ? archOrOptions : archOrOptions?.arch ?? 'x64';
  const release = resolveMediaRelease(arch);
  const cache = join(app, 'build', 'media-cache');
  mkdirSync(cache, { recursive: true });
  const zip = join(cache, `${release.name}.zip`);
  const url = release.url;
  if (!existsSync(zip)) {
    console.log(`Downloading the Windows (${release.arch}) hardware video runtime...`);
    // Some networks reset github.com release downloads; the official asset API reaches the same file.
    let response;
    try { response = await fetch(url); }
    catch { response = await fetch(release.assetUrl, { headers: { Accept: 'application/octet-stream' } }); }
    if (!response.ok) throw new Error(`Media runtime download failed: ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== release.sha256) throw new Error('Media runtime checksum mismatch');
    writeFileSync(zip, data);
  }
  if (createHash('sha256').update(readFileSync(zip)).digest('hex') !== release.sha256) throw new Error('Cached media runtime checksum mismatch');
  const unpacked = join(cache, release.name);
  if (!existsSync(join(unpacked, 'bin', 'ffmpeg.exe'))) {
    const result = spawnSync('tar.exe', ['-xf', zip, '-C', cache], { windowsHide: true, stdio: 'inherit' });
    if (result.error || result.status) throw result.error ?? new Error('Cannot extract media runtime');
  }
  const target = release.targetDir;
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(join(unpacked, 'bin'))) {
    if (name !== 'ffmpeg.exe' && !name.endsWith('.dll')) continue;
    const source = join(unpacked, 'bin', name), destination = join(target, name);
    // A running development capture has the DLLs open; identical builds need no replacement.
    if (existsSync(destination) && statSync(source).size === statSync(destination).size && readFileSync(source).equals(readFileSync(destination))) continue;
    cpSync(source, destination);
  }
  for (const name of readdirSync(unpacked)) {
    if (/license|copying|readme/i.test(name)) cpSync(join(unpacked, name), join(target, name), { recursive: true });
  }
  const gpl = join(cache, 'COPYING.GPLv3');
  if (!existsSync(gpl)) {
    const response = await fetch('https://api.github.com/repos/FFmpeg/FFmpeg/contents/COPYING.GPLv3?ref=e22a4510c9');
    if (!response.ok) throw new Error('Cannot retrieve the GPL text incorporated by LGPLv3');
    const data = await response.json();
    const license = Buffer.from(data.content || '', 'base64').toString('utf8');
    if (!license.includes('GNU GENERAL PUBLIC LICENSE') || !license.includes('Version 3')) throw new Error('Invalid GPL license text');
    writeFileSync(gpl, license);
  }
  cpSync(gpl, join(target, 'COPYING.GPLv3'));
  writeFileSync(join(target, 'LINKSHELL-MEDIA-NOTICE.txt'), `FFmpeg shared LGPL build, unmodified.\nUpstream: https://ffmpeg.org/\nBuild and corresponding source instructions: https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/${release.tag}\nBinary: ${url}\nSHA256: ${release.sha256}\nFFmpeg source revision: e22a4510c9 (release/8.1).\nThe shared libraries may be replaced by the user. LinkShell invokes ffmpeg as a separate process.\n`);
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inline = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7);
  const idx = process.argv.indexOf('--arch');
  const cliArch = inline ?? (idx >= 0 ? process.argv[idx + 1] : undefined) ?? process.env.LINKSHELL_WINDOWS_ARCH ?? 'x64';
  console.log(await ensureMedia(cliArch));
}
