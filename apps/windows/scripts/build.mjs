import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ensureWebView2 } from './webview2.mjs';

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
if (!existsSync(csc)) throw new Error('The Windows desktop build requires .NET Framework 4.8 on 64-bit Windows.');
const wpf = join(dirname(csc), 'WPF');
const desktopReferences = ['PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml'].map(name => `/r:${join(existsSync(join(wpf, name + '.dll')) ? wpf : dirname(csc), name + '.dll')}`);
desktopReferences.push('/r:System.Net.Http.dll');
desktopReferences.push(...await ensureWebView2());
const workspaceSource = join(root, 'src/Workspace.cs');
const desktopResources = [`/resource:${join(root, 'src/DesktopTheme.xaml')},DesktopTheme.xaml`, `/resource:${brand},brand.png`];
const marksSource = readFileSync(join(root, '../client/src/theme/agent-marks.ts'), 'utf8');
const marks = JSON.parse(marksSource.slice(marksSource.indexOf('{', marksSource.indexOf('export const'))).trim().replace(/;$/, ''));
for (const [agent, mark] of Object.entries(marks)) for (const theme of ['light', 'dark']) {
  const foreground = mark.fg?.[theme] ?? '#ffffff';
  const size = mark.full ? 96 : 60, offset = (96 - size) / 2;
  const svg = mark.svg.replace(/<path(?![^>]*\bfill=)/g, `<path fill="${foreground}"`).replaceAll('currentColor', foreground).replace('<svg', `<svg x="${offset}" y="${offset}" width="${size}" height="${size}"`);
  const composed = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${mark.bg?.[theme] ? `<rect width="96" height="96" fill="${mark.bg[theme]}"/>` : ''}${svg}</svg>`;
  const name = `agent.${agent}.${theme}.png`, file = join(output, name);
  await sharp(Buffer.from(composed)).png().toFile(file);
  desktopResources.push(`/resource:${file},${name}`);
}
for (const [source, name, target] of [['Screen.cs', 'LinkShell.Screen.exe', 'exe'], ['Desktop.cs', 'LinkShell.exe', 'winexe']]) {
  const result = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', `/target:${target}`, '/codepage:65001', ...(target === 'winexe' ? [...appearance, ...desktopReferences, ...desktopResources] : []), `/out:${join(output, name)}`, '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.Core.dll', join(root, 'src', source), ...(target === 'winexe' ? [join(root, 'src/Dashboard.cs'), workspaceSource] : [join(root, 'src/DesktopDuplication.cs'), join(root, 'src/VideoCapture.cs')])], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (process.argv.includes('--qa')) {
  // The same labeled fixtures used by the Mac dashboard, embedded only in the QA executable.
  const macUsage = readFileSync(join(root, '../mac/Sources/LinkShell/DesktopUsage.swift'), 'utf8').match(/let fixture = #"(\{.*\})"#/)[1];
  writeFileSync(join(output, 'PreviewUsage.json'), macUsage);
  const QRCode = createRequire(join(root, '../../packages/cli/package.json'))('qrcode-terminal/vendor/QRCode');
  const previewLink = 'https://example.invalid/linkshell-design-preview';
  const qr = new QRCode(-1, 0); qr.addData(previewLink); qr.make();
  writeFileSync(join(output, 'PreviewPair.json'), JSON.stringify({ code: '000000', link: previewLink, qr: qr.modules }));
  writeFileSync(join(output, 'PreviewSnapshot.json'), JSON.stringify({ status: 'running', cliVersion: '0.10.45', account: { state: 'signed-out' }, machine: { hostname: '这台电脑', hostVersion: '0.10.45', agents: [{ id: 'codex', label: 'Codex', installed: true, version: '0.163.0' }, { id: 'claude', label: 'Claude Code', installed: true, version: '2.1.292' }] }, gateway: { status: 'online', devices: [{ id: 'preview', name: '我的 iPhone', online: true }] }, screen: { recording: true, control: true }, sessions: [{ id: 'one', agent: 'codex', title: '登录流程', cwd: 'C:\\Projects\\LinkShell', state: 'running', pendingPermissions: 0 }, { id: 'two', agent: 'claude', title: '发布检查', cwd: 'C:\\Projects\\LinkShell', state: 'waiting', pendingPermissions: 1 }, { id: 'three', agent: 'codex', title: '项目文档', cwd: 'C:\\Projects\\LinkShell', state: 'idle', pendingPermissions: 0 }] }));
  const probe = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', '/codepage:65001', ...appearance, `/out:${join(output, 'LinkShell.InputQA.exe')}`, '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', join(root, 'src/InputProbe.cs')], { stdio: 'inherit', windowsHide: true });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) process.exit(probe.status || 1);
  writeFileSync(join(output, 'node-path.txt'), process.execPath);
  for (const [entry, name] of [['SmokeDesktop', 'LinkShell.QA.exe'], ['PreviewDesktop', 'LinkShell.Preview.exe']]) {
    const result = spawnSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', `/main:LinkShell.Windows.${entry}`, '/codepage:65001', ...appearance, ...desktopReferences, ...desktopResources, ...['PreviewUsage.json', 'PreviewSnapshot.json', 'PreviewPair.json'].map(file => `/resource:${join(output, file)},${file}`), `/out:${join(output, name)}`, '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.Core.dll', join(root, 'src/Desktop.cs'), join(root, 'src/Dashboard.cs'), workspaceSource, join(root, 'src/SmokeDesktop.cs')], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
