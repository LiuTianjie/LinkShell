import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)("electron");
const hasDisplay = process.platform !== "linux" || !!process.env.DISPLAY;

test("Chromium editing contexts reach the native menu without granting preview access", { skip: !hasDisplay, timeout: 40_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "linkshell-editing-menu-"));
  try {
    const output = execFileSync(electron, [join(here, "fixtures/editing-context-menu.cjs"), directory], {
      timeout: 30_000,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /PASS native editing contexts/);
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
