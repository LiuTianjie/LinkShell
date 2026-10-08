#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'vendor-manifest.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [abi, pin] of Object.entries(manifest['libghostty-vt'].libraries)) {
  const destination = join(root, 'android/vendor', abi, 'libghostty-vt.a');
  if (existsSync(destination) && digest(await readFile(destination)) === pin.librarySha256) continue;
  const archive = await readFile(join(root, pin.archive));
  if (digest(archive) !== pin.archiveSha256) throw new Error(`${abi}: archive checksum mismatch`);
  const library = gunzipSync(archive);
  if (digest(library) !== pin.librarySha256) throw new Error(`${abi}: library checksum mismatch`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, library);
}
await writeFile(join(root, 'android/vendor/.checksum'), digest(Buffer.from(JSON.stringify(manifest['libghostty-vt']))));
console.log('[LinkTerminal] verified Android cores: arm64, armv7, x86_64');
