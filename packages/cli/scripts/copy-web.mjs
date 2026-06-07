#!/usr/bin/env node
// Copy the built web-dashboard SPA into the CLI package (packages/cli/web) so
// it ships in the npm tarball. The CLI's embedded gateway then serves it via
// WEB_DIST, giving LAN / self-hosted users the same in-app web console that the
// cloud gateway Docker image bundles separately.
//
// Non-fatal when the web build is absent: a CLI-only `tsc` build still
// succeeds; the embedded gateway just logs "web UI not bundled". Release builds
// must build apps/web-dashboard FIRST so this copy has something to pick up.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const src = resolve(here, "../../../apps/web-dashboard/dist");
const dest = resolve(here, "../web"); // packages/cli/web

if (!existsSync(resolve(src, "index.html"))) {
  console.warn(
    `[copy-web] web-dashboard build not found at ${src} — skipping. ` +
      `The in-app agent console will be blank for embedded-gateway users. ` +
      `Run \`pnpm --filter @linkshell/web-dashboard build\` first.`,
  );
  process.exit(0);
}

try {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-web] copied ${src} -> ${dest}`);
} catch (err) {
  console.error(`[copy-web] failed to copy web dist: ${err}`);
  process.exit(1);
}
