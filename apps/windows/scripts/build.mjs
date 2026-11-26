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
const appearance = [`/win32icon:${join(output, 'LinkShell.ico')}`, `/win32manifest:${join(root, 'src/app.manifest')}`];
const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) throw new Error('The Windows screen helper requires .NET Framework 4.8 on 64-bit Windows.');

// Minimal C# screen helper: LocalSystem service (UAC/lock-screen/admin input), Fusion window metadata,
// JPEG fallback, and offline MttVDD IddCx virtual display installation.
// Use /platform:anycpu on ARM64 so .NET 4.8.1 runs natively (required for SetupAPI driver installation).
const screenPlatform = arch === 'arm64' ? '/platform:anycpu' : '/platform:x64';
const screen = spawnSync(csc, [
  '/nologo', '/optimize+', screenPlatform, '/target:exe', '/codepage:65001',
  `/out:${join(output, 'LinkShell.Screen.exe')}`,
  '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.Core.dll', '/r:System.ServiceProcess.dll',
  join(root, 'src/Screen.cs'),
  join(root, 'src/DesktopDuplication.cs'),
  join(root, 'src/VideoCapture.cs'),
  join(root, 'src/Fusion.cs'),
  join(root, 'src/ScreenService.cs'),
  join(root, 'src/VirtualDisplay.cs'),
], { stdio: 'inherit', windowsHide: true });
if (screen.error) throw screen.error;
if (screen.status !== 0) process.exit(screen.status || 1);

if (!process.argv.includes('--skip-media')) {
  // Build the native C++20 libwebrtc media engine (LinkShell.Media.exe) for remote screen & Fusion.
  const sdkRoot = await ensureWebRtcSdk(arch);
  const mediaBuild = join(output, `media-build-${arch}`);
  const cmakeArch = arch === 'arm64' ? 'ARM64' : 'x64';
  const cmakeEnv = { ...process.env };
  // Ensure CMake picks its default Visual Studio generator so -A <x64|ARM64> always works.
  delete cmakeEnv.CMAKE_GENERATOR;
  delete cmakeEnv.CMAKE_GENERATOR_PLATFORM;
  delete cmakeEnv.CMAKE_GENERATOR_TOOLSET;

  console.log(`Configuring LinkShell.Media.exe (${arch}) with libwebrtc at ${sdkRoot}...`);
  const configure = spawnSync('cmake', [
    '-S', join(root, 'media'),
    '-B', mediaBuild,
    '-A', cmakeArch,
    `-DWEBRTC_ROOT=${sdkRoot}`,
  ], { stdio: 'inherit', windowsHide: true, env: cmakeEnv });
  if (configure.error) throw configure.error;
  if (configure.status !== 0) process.exit(configure.status || 1);

  console.log(`Building LinkShell.Media.exe (${arch}, Release)...`);
  const compiled = spawnSync('cmake', [
    '--build', mediaBuild,
    '--config', 'Release',
    '--parallel',
  ], { stdio: 'inherit', windowsHide: true, env: cmakeEnv });
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) process.exit(compiled.status || 1);

  const builtExe = join(mediaBuild, 'Release', 'LinkShell.Media.exe');
  if (!existsSync(builtExe)) throw new Error(`Missing built native media binary: ${builtExe}`);
  const archOut = arch === 'x64' ? join(output, 'LinkShell.Media.exe') : join(output, `LinkShell.Media-${arch}.exe`);
  cpSync(builtExe, archOut);
  if (arch !== 'x64') cpSync(builtExe, join(output, 'LinkShell.Media.exe'));
  const webrtcLicense = join(sdkRoot, 'LICENSE.md');
  if (existsSync(webrtcLicense)) cpSync(webrtcLicense, join(output, 'WEBRTC-LICENSE.md'));
}

if (process.argv.includes('--qa')) {
  // A window that reports the clicks, text, shortcuts and wheel the remote screen sends; development only.
  const probe = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', '/codepage:65001', ...appearance, `/out:${join(output, 'LinkShell.InputQA.exe')}`, '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', join(root, 'src/InputProbe.cs')], { stdio: 'inherit', windowsHide: true });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) process.exit(probe.status || 1);
}
