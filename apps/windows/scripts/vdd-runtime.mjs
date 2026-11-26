import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeWindowsArch } from './prune-runtime.mjs';

export const vddTag = '25.7.23';

// MIT-licensed SignPath-signed IddCx Virtual Display Driver (VirtualDrivers/Virtual-Display-Driver).
// Note: upstream's x64 driver-only zip is named "-x86.Driver.Only.zip" even though it ships
// PE32+ x86-64 MttVDD.dll and NTamd64 MttVDD.inf.
export const vddReleases = {
  x64: {
    tag: vddTag,
    name: 'VirtualDisplayDriver-x86.Driver.Only',
    sha256: 'e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a',
  },
  arm64: {
    tag: vddTag,
    name: 'VirtualDisplayDriver-ARM64.Driver.Only',
    sha256: 'dcd487161469c726bab60f174a7e7f70ee02afd437cad0d5c0e6755953de5a25',
  },
};

const REQUIRED_FILES = ['MttVDD.inf', 'mttvdd.cat', 'MttVDD.dll', 'vdd_settings.xml'];
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveVddRelease(arch = 'x64') {
  const targetArch = normalizeWindowsArch(arch);
  const release = vddReleases[targetArch];
  const url = `https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/${release.tag}/${release.name}.zip`;
  const targetDir = targetArch === 'x64' ? join(app, 'build', 'vdd') : join(app, 'build', `vdd-${targetArch}`);
  return { ...release, arch: targetArch, url, targetDir };
}

export async function ensureVdd(archOrOptions = 'x64') {
  const arch = typeof archOrOptions === 'string' ? archOrOptions : archOrOptions?.arch ?? 'x64';
  const release = resolveVddRelease(arch);
  const cache = join(app, 'build', 'vdd-cache');
  mkdirSync(cache, { recursive: true });
  const zip = join(cache, `${release.name}-${release.tag}.zip`);

  const hasValidZip = existsSync(zip)
    && createHash('sha256').update(readFileSync(zip)).digest('hex') === release.sha256;

  if (!hasValidZip) {
    console.log(`Downloading Virtual Display Driver (${release.arch}, ${release.tag})...`);
    const response = await fetch(release.url);
    if (!response.ok) throw new Error(`Virtual Display Driver download failed (${response.status}): ${release.url}`);
    const data = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== release.sha256) {
      throw new Error(`Virtual Display Driver (${release.arch}) checksum mismatch: expected ${release.sha256}, got ${actual}`);
    }
    writeFileSync(zip, data);
  }

  const unpacked = join(cache, `${release.name}-${release.tag}`);
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const result = spawnSync(tar, ['-xf', zip, '-C', unpacked], { windowsHide: true, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Cannot extract Virtual Display Driver (${result.status})`);
  }

  const sourceDir = existsSync(join(unpacked, 'VirtualDisplayDriver', 'MttVDD.inf'))
    ? join(unpacked, 'VirtualDisplayDriver')
    : unpacked;

  rmSync(release.targetDir, { recursive: true, force: true });
  mkdirSync(release.targetDir, { recursive: true });
  for (const file of REQUIRED_FILES) {
    const src = join(sourceDir, file);
    if (!existsSync(src)) throw new Error(`Virtual Display Driver package is missing ${file}`);
    cpSync(src, join(release.targetDir, file));
  }
  writeFileSync(
    join(release.targetDir, 'LINKSHELL-VDD-NOTICE.txt'),
    [
      'Virtual Display Driver (MttVDD / IddCx), unmodified SignPath-signed release.',
      'Upstream: https://github.com/VirtualDrivers/Virtual-Display-Driver',
      `Release: ${release.tag} (${release.arch})`,
      `Archive: ${release.url}`,
      `SHA256: ${release.sha256}`,
      'License: MIT License (Copyright VirtualDrivers contributors).',
      'Installed only when explicitly requested by the user in LinkShell Desktop settings.',
      '',
    ].join('\n'),
  );
  return release.targetDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inline = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7);
  const idx = process.argv.indexOf('--arch');
  const cliArch = inline ?? (idx >= 0 ? process.argv[idx + 1] : undefined) ?? process.env.LINKSHELL_WINDOWS_ARCH ?? 'x64';
  console.log(await ensureVdd(cliArch));
}
