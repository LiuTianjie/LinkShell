import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("Windows and macOS cold-start ground, loading shell, and titleBarOverlay match tokens.css", () => {
  const mainSource = readFileSync(resolve(here, "../src/main/main.ts"), "utf8");
  const tokensCss = readFileSync(resolve(here, "../../desktop-ui/src/styles/tokens.css"), "utf8");

  assert.match(tokensCss, /--ls-ground:\s*light-dark\(#f2f3f6,\s*#090a0c\)/);
  assert.match(
    mainSource,
    /const ground = \(\) => \(nativeTheme\.shouldUseDarkColors \? "#090a0c" : "#f2f3f6"\);/,
  );
  assert.match(
    mainSource,
    /const overlay = \(\) => \(\{ color: "#00000000", symbolColor: nativeTheme\.shouldUseDarkColors \? "#eceef2" : "#141518", height: TOOLBAR \}\);/,
  );
  assert.match(mainSource, /const TOOLBAR = 42;/);
  assert.match(mainSource, /<meta name="color-scheme" content="light dark">/);
  assert.match(mainSource, /background:light-dark\(#f2f3f6,#090a0c\)/);
  assert.doesNotMatch(mainSource, /background:light-dark\(#f3f3f3,#1d1d1d\)/);
  assert.match(mainSource, /nativeTheme\.on\("updated",\s*updateWindowSurface\)/);
});
