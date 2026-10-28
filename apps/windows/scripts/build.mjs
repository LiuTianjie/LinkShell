import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') {
  console.log('Windows desktop: build on Windows (skipped on this platform).');
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'build');
mkdirSync(output, { recursive: true });
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
// The window is Electron (scripts/electron.mjs); the screen helper stays native: DXGI capture,
// Media Foundation H.264 and SendInput.
const screen = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/codepage:65001', `/out:${join(output, 'LinkShell.Screen.exe')}`, '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.Core.dll', join(root, 'src/Screen.cs'), join(root, 'src/DesktopDuplication.cs'), join(root, 'src/VideoCapture.cs')], { stdio: 'inherit', windowsHide: true });
if (screen.error) throw screen.error;
if (screen.status !== 0) process.exit(screen.status || 1);
if (process.argv.includes('--qa')) {
  // A window that reports the clicks, text, shortcuts and wheel the remote screen sends; development only.
  const probe = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', '/codepage:65001', ...appearance, `/out:${join(output, 'LinkShell.InputQA.exe')}`, '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', join(root, 'src/InputProbe.cs')], { stdio: 'inherit', windowsHide: true });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) process.exit(probe.status || 1);
}
