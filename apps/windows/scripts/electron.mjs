// The Windows window: Electron (apps/desktop's version) as LinkShell.exe, with apps/desktop's
// compiled main and preload as resources/app, the same code the Mac app runs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(app, '../desktop');
// electron/rcedit's own release binary, pinned: npm marks every version of its wrapper unsupported.
export const rcedit = { version: '2.0.0', sha256: '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a' };
// Chromium's strings for the languages the UI is in.
const LOCALES = ['en-US.pak', 'zh-CN.pak', 'zh-TW.pak'];
// Files of the Electron folder that are not the app's: its sample app and its version note.
const SKIPPED = new Set(['electron.exe', 'resources', 'locales', 'LICENSE', 'version']);

async function rceditPath() {
  const file = join(app, 'build', `rcedit-${rcedit.version}`, 'rcedit-x64.exe');
  const valid = bytes => createHash('sha256').update(bytes).digest('hex') === rcedit.sha256;
  if (existsSync(file) && valid(readFileSync(file))) return file;
  const response = await fetch(`https://github.com/electron/rcedit/releases/download/v${rcedit.version}/rcedit-x64.exe`);
  if (!response.ok) throw new Error(`rcedit download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error('rcedit checksum mismatch');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

/** Puts the window into `bundle`; apps/desktop must be compiled (its dist) first. */
export async function assembleElectron(bundle, version) {
  if (!existsSync(join(desktop, 'dist/main/main.js'))) throw new Error('Compile apps/desktop first (pnpm --filter @linkshell/desktop exec tsc -p tsconfig.json).');
  const electron = execFileSync(process.execPath, [join(desktop, 'scripts/electron-dist.mjs'), 'x64', 'win32'], { encoding: 'utf8', windowsHide: true }).trim();
  for (const entry of readdirSync(electron)) {
    if (!SKIPPED.has(entry)) cpSync(join(electron, entry), join(bundle, entry), { recursive: true });
  }
  const exe = join(bundle, 'LinkShell.exe');
  cpSync(join(electron, 'electron.exe'), exe);
  // The bundle's LICENSE is LinkShell's.
  cpSync(join(electron, 'LICENSE'), join(bundle, 'ELECTRON-LICENSE.txt'));
  rmSync(join(bundle, 'locales'), { recursive: true, force: true });
  mkdirSync(join(bundle, 'locales'));
  for (const name of LOCALES) cpSync(join(electron, 'locales', name), join(bundle, 'locales', name));

  // Electron loads resources/app when there is no app.asar: a plain folder, as on the Mac.
  rmSync(join(bundle, 'resources'), { recursive: true, force: true });
  const appDir = join(bundle, 'resources/app');
  mkdirSync(appDir, { recursive: true });
  cpSync(join(desktop, 'dist'), join(appDir, 'dist'), { recursive: true });
  cpSync(join(desktop, 'assets'), join(appDir, 'assets'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'linkshell', productName: 'LinkShell', version, type: pkg.type, main: pkg.main, private: true }, null, 2));

  // Explorer, the taskbar and Task Manager read the executable's own icon and names.
  const numeric = `${version.replace(/[^0-9.].*$/, '').split('.').concat(['0', '0', '0']).slice(0, 4).join('.')}`;
  const strings = { CompanyName: 'LinkShell', FileDescription: 'LinkShell', ProductName: 'LinkShell', InternalName: 'LinkShell', OriginalFilename: 'LinkShell.exe', LegalCopyright: 'Copyright (c) 2026 LinkShell Contributors' };
  execFileSync(await rceditPath(), [exe,
    '--set-icon', join(app, 'build/LinkShell.ico'),
    '--set-file-version', numeric, '--set-product-version', version,
    ...Object.entries(strings).flatMap(([key, value]) => ['--set-version-string', key, value]),
  ], { stdio: 'inherit', windowsHide: true });
  return exe;
}
