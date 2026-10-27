#!/usr/bin/env node
// Development build of LinkShellNative.node (apps/mac, product LinkShellNative) into ./native,
// beside links to the WebRTC and Sparkle frameworks it loads through @loader_path. A packaged
// app gets its own release build in Contents/Frameworks (scripts/package.mjs). Skipped off macOS.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);
const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mac = resolve(here, "../mac");
const scratch = join(mac, "build/swiftpm");
const args = ["build", "--product", "LinkShellNative", "--package-path", mac, "--scratch-path", scratch];
execFileSync("/usr/bin/swift", args, { stdio: "inherit" });
const bin = execFileSync("/usr/bin/swift", [...args, "--show-bin-path"], { encoding: "utf8" }).trim();
const out = join(here, "native");
mkdirSync(out, { recursive: true });
cpSync(join(bin, "libLinkShellNative.dylib"), join(out, "LinkShellNative.node"));
for (const framework of ["WebRTC.framework", "Sparkle.framework"]) {
  const link = join(out, framework);
  rmSync(link, { recursive: true, force: true });
  if (existsSync(join(bin, framework))) symlinkSync(join(bin, framework), link);
}
console.log(`[build-native] ${join(out, "LinkShellNative.node")}`);
