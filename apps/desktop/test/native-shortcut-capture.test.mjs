import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("native bridge wraps setSystemShortcutCapture safely and main resets on exit/blur/navigation", () => {
  const nativeSrc = readFileSync(resolve(here, "../src/main/native.ts"), "utf8");
  const mainSrc = readFileSync(resolve(here, "../src/main/main.ts"), "utf8");
  const preloadSrc = readFileSync(resolve(here, "../src/preload/preload.cts"), "utf8");
  const hubSrc = readFileSync(resolve(here, "../src/main/fusion/electron-hub.ts"), "utf8");

  assert.match(nativeSrc, /setSystemShortcutCapture\?\(enabled:\s*boolean\):\s*boolean/);
  assert.match(nativeSrc, /setSystemShortcutCapture:\s*\(enabled\)\s*=>\s*Boolean\(raw\.setSystemShortcutCapture\?\.\(enabled\)\)/);

  // Main handles mDNS + shortcut capture + audioMuted forwarding + resets shortcut capture safely.
  assert.match(mainSrc, /case "setSystemShortcutCapture":/);
  assert.match(mainSrc, /case "startLanDiscovery":/);
  assert.match(mainSrc, /case "stopLanDiscovery":/);
  assert.match(mainSrc, /case "getLanHosts":/);
  assert.match(mainSrc, /adjusted\.audioMuted\s*=\s*Boolean\(message\.audioMuted\)/);
  assert.match(mainSrc, /window\.on\("blur"[\s\S]*?resetSystemShortcutCapture\(\)/);
  assert.match(mainSrc, /window\.on\("closed"[\s\S]*?resetSystemShortcutCapture\(\)/);
  assert.match(mainSrc, /did-start-navigation[\s\S]*?resetSystemShortcutCapture\(\)/);
  assert.match(mainSrc, /before-quit[\s\S]*?resetSystemShortcutCapture\(\)/);

  // Preload exposes the new bridge methods.
  assert.match(preloadSrc, /setSystemShortcutCapture\(enabled:\s*boolean\)/);
  assert.match(preloadSrc, /startLanDiscovery\(\)/);
  assert.match(preloadSrc, /stopLanDiscovery\(\)/);
  assert.match(preloadSrc, /getLanHosts\(\)/);

  // Electron Fusion hub negotiates file-clipboard feature.
  assert.match(hubSrc, /LOCAL_FEATURES\s*=\s*\["keys",\s*"clipboard",\s*"file-clipboard"\]/);
  assert.match(hubSrc, /case "clip\.file\.start":/);
  assert.match(hubSrc, /case "clip\.file\.chunk":/);
  assert.match(hubSrc, /case "clip\.file\.end":/);
});
