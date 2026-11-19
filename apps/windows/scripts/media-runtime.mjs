import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// A shared LGPL build: no GPL encoders, and the libraries remain replaceable.
export const mediaRelease = {
  tag: 'autobuild-2026-11-18-12-39',
  name: 'ffmpeg-n8.1.3-36-ge22a4510c9-win64-lgpl-shared-8.1',
  sha256: '13a795e5620236ca4c304b580f0155130bdcecd87bf5e9f66f84b59d98783668',
  asset: 763357000,
};
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function ensureMedia() {
  const cache = join(app, 'build', 'media-cache');
  mkdirSync(cache, { recursive: true });
  const zip = join(cache, `${mediaRelease.name}.zip`);
  const url = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/${mediaRelease.tag}/${mediaRelease.name}.zip`;
  if (!existsSync(zip)) {
    console.log('Downloading the Windows hardware video runtime...');
    // Some networks reset github.com release downloads; the official asset API reaches the same file.
    let response;
    try { response = await fetch(url); }
    catch { response = await fetch(`https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/assets/${mediaRelease.asset}`, { headers: { Accept: 'application/octet-stream' } }); }
    if (!response.ok) throw new Error(`Media runtime download failed: ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== mediaRelease.sha256) throw new Error('Media runtime checksum mismatch');
    writeFileSync(zip, data);
  }
  if (createHash('sha256').update(readFileSync(zip)).digest('hex') !== mediaRelease.sha256) throw new Error('Cached media runtime checksum mismatch');
  const unpacked = join(cache, mediaRelease.name);
  if (!existsSync(join(unpacked, 'bin', 'ffmpeg.exe'))) {
    const result = spawnSync('tar.exe', ['-xf', zip, '-C', cache], { windowsHide: true, stdio: 'inherit' });
    if (result.error || result.status) throw result.error ?? new Error('Cannot extract media runtime');
  }
  const target = join(app, 'build', 'media');
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
  writeFileSync(join(target, 'LINKSHELL-MEDIA-NOTICE.txt'), `FFmpeg shared LGPL build, unmodified.\nUpstream: https://ffmpeg.org/\nBuild and corresponding source instructions: https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/${mediaRelease.tag}\nBinary: ${url}\nSHA256: ${mediaRelease.sha256}\nFFmpeg source revision: e22a4510c9 (release/8.1).\nThe shared libraries may be replaced by the user. LinkShell invokes ffmpeg as a separate process.\n`);
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await ensureMedia());
