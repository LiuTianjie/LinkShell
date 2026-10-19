import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstaller } from './installer.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(app, 'package.json'))).version;
console.log(buildInstaller(join(app, '../../artifacts', `LinkShell-${version}-windows-x64.zip`), join(app, 'build/LinkShell.SetupQA.exe'), {
  main: 'InstallerVisual', sources: [join(app, 'test/InstallerVisual.cs')],
}));
