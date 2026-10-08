#!/usr/bin/env node
// Fetch and verify the pinned Apple core for native builds.
// Called by CocoaPods / Gradle; binary archives remain outside source control.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'vendor-manifest.json'), 'utf8'));
const { url, sha256 } = manifest['libghostty-spm'].xcframework;

const frameworksDir = join(root, 'ios', 'vendor', 'Frameworks');
const frameworkDir = join(frameworksDir, 'GhosttyKit.xcframework');
const stampFile = join(frameworksDir, '.checksum');

if (existsSync(frameworkDir) && existsSync(stampFile)) {
  const stamp = (await readFile(stampFile, 'utf8')).trim();
  if (stamp === sha256) {
    console.log('[LinkTerminal] GhosttyKit.xcframework up to date');
    process.exit(0);
  }
}

console.log(`[LinkTerminal] downloading GhosttyKit.xcframework (${url})`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
const zip = Buffer.from(await response.arrayBuffer());

const actual = createHash('sha256').update(zip).digest('hex');
if (actual !== sha256) {
  throw new Error(`checksum mismatch: expected ${sha256}, got ${actual}`);
}

await rm(frameworkDir, { recursive: true, force: true });
await mkdir(frameworksDir, { recursive: true });
const zipPath = join(frameworksDir, 'GhosttyKit.xcframework.zip');
await writeFile(zipPath, zip);
execFileSync('unzip', ['-oq', zipPath, '-d', frameworksDir]);
await rm(zipPath);
await writeFile(stampFile, `${sha256}\n`);
console.log('[LinkTerminal] GhosttyKit.xcframework ready');
