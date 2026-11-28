import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { normalizeWindowsArch } from './prune-runtime.mjs';
import { ensureWebRtcSdk } from './webrtc-sdk.mjs';

if (process.platform !== 'win32') {
  console.log('Windows desktop: build on Windows (skipped on this platform).');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'build');
mkdirSync(output, { recursive: true });

function resolveBuildArch(argv = process.argv, env = process.env) {
  const inline = argv.find(arg => arg.startsWith('--arch='))?.slice(7);
  const idx = argv.indexOf('--arch');
  const flag = idx >= 0 ? argv[idx + 1] : undefined;
  const raw = inline ?? flag ?? env.LINKSHELL_WINDOWS_ARCH ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  return normalizeWindowsArch(raw);
}

const arch = resolveBuildArch();
const sharp = createRequire(join(root, '../../packages/host/package.json'))('sharp');
const brand = join(output, 'brand.png');
const rounded = await sharp(join(root, '../client/assets/icon.png')).resize(256, 256).composite([
  { input: Buffer.from('<svg width="256" height="256"><rect width="256" height="256" rx="56" fill="white"/></svg>'), blend: 'dest-in' },
]).png().toBuffer();
writeFileSync(brand, rounded);
const sizes = [16, 32, 48, 256];
const icons = await Promise.all(sizes.map(size => sharp(rounded).resize(size, size).png().toBuffer()));
const directory = Buffer.alloc(6 + 16 * icons.length);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(icons.length, 4);
let offset = directory.length;
icons.forEach((png, i) => {
  const at = 6 + 16 * i;
  directory[at] = directory[at + 1] = sizes[i] % 256;
  directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(png.length, at + 8); directory.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
writeFileSync(join(output, 'LinkShell.ico'), Buffer.concat([directory, ...icons]));

const buildMedia = !process.argv.includes('--skip-media');
const buildQa = process.argv.includes('--qa');
const sdkRoot = buildMedia ? await ensureWebRtcSdk(arch) : '';
const mediaBuild = join(output, `media-build-${arch}`);
const cmakeArch = arch === 'arm64' ? 'ARM64' : 'x64';
const cmakeEnv = { ...process.env };
// Ensure CMake picks its default Visual Studio generator so -A <x64|ARM64> always works.
delete cmakeEnv.CMAKE_GENERATOR;
delete cmakeEnv.CMAKE_GENERATOR_PLATFORM;
delete cmakeEnv.CMAKE_GENERATOR_TOOLSET;

const cmakeArgs = [
  '-S', join(root, 'media'),
  '-B', mediaBuild,
  '-A', cmakeArch,
  '-DLINKSHELL_BUILD_SCREEN=ON',
  `-DLINKSHELL_BUILD_MEDIA=${buildMedia ? 'ON' : 'OFF'}`,
  `-DLINKSHELL_BUILD_QA=${buildQa ? 'ON' : 'OFF'}`,
];
if (buildMedia) cmakeArgs.push(`-DWEBRTC_ROOT=${sdkRoot}`);

console.log(`Configuring native C++20 Windows binaries (${arch}, media=${buildMedia}, qa=${buildQa})...`);
const configure = spawnSync('cmake', cmakeArgs, { stdio: 'inherit', windowsHide: true, env: cmakeEnv });
if (configure.error) throw configure.error;
if (configure.status !== 0) process.exit(configure.status || 1);

console.log(`Building native C++20 Windows binaries (${arch}, Release)...`);
const compiled = spawnSync('cmake', [
  '--build', mediaBuild,
  '--config', 'Release',
  '--parallel',
], { stdio: 'inherit', windowsHide: true, env: cmakeEnv });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status || 1);

const builtScreen = join(mediaBuild, 'Release', 'LinkShell.Screen.exe');
if (!existsSync(builtScreen)) throw new Error(`Missing built native screen helper: ${builtScreen}`);
cpSync(builtScreen, join(output, 'LinkShell.Screen.exe'));
if (arch !== 'x64') cpSync(builtScreen, join(output, `LinkShell.Screen-${arch}.exe`));

if (buildMedia) {
  const builtExe = join(mediaBuild, 'Release', 'LinkShell.Media.exe');
  if (!existsSync(builtExe)) throw new Error(`Missing built native media binary: ${builtExe}`);
  const archOut = arch === 'x64' ? join(output, 'LinkShell.Media.exe') : join(output, `LinkShell.Media-${arch}.exe`);
  cpSync(builtExe, archOut);
  if (arch !== 'x64') cpSync(builtExe, join(output, 'LinkShell.Media.exe'));
  const webrtcLicense = join(sdkRoot, 'LICENSE.md');
  if (existsSync(webrtcLicense)) cpSync(webrtcLicense, join(output, 'WEBRTC-LICENSE.md'));
}

if (buildQa) {
  const builtQa = join(mediaBuild, 'Release', 'LinkShell.InputQA.exe');
  if (!existsSync(builtQa)) throw new Error(`Missing built native QA binary: ${builtQa}`);
  cpSync(builtQa, join(output, 'LinkShell.InputQA.exe'));
}
