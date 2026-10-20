import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');

export function buildInstaller(archive, output, { main = 'LinkShell.Windows.Installer', sources = [] } = {}) {
  if (process.platform !== 'win32' || !existsSync(archive)) throw new Error('Build the installer on Windows with an existing portable ZIP.');
  const version = JSON.parse(readFileSync(join(app, 'package.json'))).version;
  const versionFile = join(app, 'build/installer-version.txt');
  writeFileSync(versionFile, version);
  const framework = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const refs = ['PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml'].map(name => {
    const wpf = join(framework, 'WPF', name + '.dll');
    return '/r:' + (existsSync(wpf) ? wpf : join(framework, name + '.dll'));
  });
  const args = ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', '/codepage:65001', `/main:${main}`, ...refs,
    `/win32icon:${join(app, 'build/LinkShell.ico')}`, `/win32manifest:${join(app, 'src/app.manifest')}`, `/out:${output}`,
    `/resource:${archive},payload.zip`, `/resource:${versionFile},installer-version.txt`,
    `/resource:${join(app, 'src/DesktopTheme.xaml')},DesktopTheme.xaml`, `/resource:${join(app, 'build/brand.png')},brand.png`,
    '/r:System.Core.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    join(app, 'src/Installer.cs'), join(app, 'src/InstallerEngine.cs'), ...sources];
  const result = spawnSync(join(framework, 'csc.exe'), args, { windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Installer compiler failed (${result.status}).`);
  writeFileSync(`${output}.sha256`, `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${basename(output)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync(join(app, 'package.json'))).version;
  const archive = join(root, `artifacts/LinkShell-${version}-windows-x64.zip`);
  const expected = readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0];
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== expected) throw new Error('Portable ZIP checksum mismatch; rebuild the bundle.');
  console.log(buildInstaller(archive, join(root, `artifacts/LinkShell-Setup-${version}-windows-x64.exe`)));
}
