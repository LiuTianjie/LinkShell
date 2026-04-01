#!/usr/bin/env node
// Fix node-pty spawn-helper permissions on macOS/Linux
import { chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

try {
  const require = createRequire(import.meta.url);
  const ptyPath = dirname(require.resolve("node-pty/package.json"));
  const candidates = [
    join(ptyPath, "prebuilds", "darwin-arm64", "spawn-helper"),
    join(ptyPath, "prebuilds", "darwin-x64", "spawn-helper"),
    join(ptyPath, "prebuilds", "linux-x64", "spawn-helper"),
    join(ptyPath, "prebuilds", "linux-arm64", "spawn-helper"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      chmodSync(p, 0o755);
    }
  }
} catch {
  // Silently ignore — not critical for install to succeed
}
