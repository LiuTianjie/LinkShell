import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { standaloneBundle } from "../src/utils/standalone.js";
const temp = mkdtempSync(join(tmpdir(), "linkshell-bundle-test-"));
afterEach(() => rmSync(temp, { recursive: true, force: true }));
it("requires a complete app runtime and resolves linked CLI paths", () => {
  const app = join(temp, "LinkShell.app"), entry = join(app, "Contents/Resources/runtime/cli/index.js");
  mkdirSync(join(app, "Contents/Resources/runtime/cli"), { recursive: true });
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(entry, "");
  expect(standaloneBundle(entry)).toBeUndefined();
  writeFileSync(join(app, "Contents/MacOS/node"), "");
  writeFileSync(join(app, "Contents/Resources/standalone.json"), "{}");
  symlinkSync(entry, join(temp, "linkshell"));
  expect(standaloneBundle(join(temp, "linkshell"))).toBe(realpathSync(app));
  expect(standaloneBundle("/not-installed/linkshell")).toBeUndefined();
});
