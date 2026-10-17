#!/usr/bin/env node
// Sparkle's official release tool signs archives using the persistent login-Keychain key.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'config/desktop-release.json')));
const [tool, archive, downloadURL, output] = process.argv.slice(2);
if (!tool || !archive || !downloadURL || !output || !downloadURL.endsWith('/')) throw new Error('Usage: node appcast.mjs /path/to/generate_appcast archive.dmg https://download-prefix/ output.xml');
const temporary = mkdtempSync(join(tmpdir(), 'linkshell-appcast-'));
try {
  cpSync(resolve(archive), join(temporary, archive.split('/').at(-1)));
  execFileSync(resolve(tool), ['--account', config.keychainAccount, '--download-url-prefix', downloadURL, '--maximum-deltas', '0', '--maximum-versions', '1', '-o', join(temporary, 'appcast.xml'), temporary], { stdio: 'inherit' });
  cpSync(join(temporary, 'appcast.xml'), resolve(output));
} finally { rmSync(temporary, { recursive: true, force: true }); }
