#!/usr/bin/env node
// Builds LinkShell.app, the signed helper that holds the Accessibility
// permission on a Mac and posts the phone's pointer and key events (see
// src/input.ts and src/input-helper.ts).
//
//   node scripts/build-helper.mjs <compiled input-helper.js> <output directory>
//
// It needs macOS, the Swift compiler and a "Developer ID Application" signing
// identity in the keychain (or LINKSHELL_SIGN_IDENTITY). Without them the app
// is skipped and the package falls back to compiling the helper on the user's
// computer — unless LINKSHELL_REQUIRE_HELPER=1, which a release sets so that a
// package never goes out without it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [sourceModule, outDir] = process.argv.slice(2);
const required = process.env.LINKSHELL_REQUIRE_HELPER === "1";
const BUNDLE_ID = "com.bd.linkshell.host";

function skip(reason) {
  if (required) {
    console.error(`[build-helper] ${reason}, and LINKSHELL_REQUIRE_HELPER=1`);
    process.exit(1);
  }
  console.warn(`[build-helper] ${reason} — skipping LinkShell.app (the helper will be compiled on the user's computer instead)`);
  process.exit(0);
}

if (!sourceModule || !outDir) {
  console.error("usage: node build-helper.mjs <compiled input-helper.js> <output directory>");
  process.exit(1);
}
if (process.platform !== "darwin") skip("not macOS");

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

let identity = process.env.LINKSHELL_SIGN_IDENTITY;
if (!identity) {
  const identities = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  identity = /"(Developer ID Application: [^"]+)"/.exec(identities)?.[1];
}
if (!identity) skip("no Developer ID Application signing identity in the keychain");
try {
  run("/usr/bin/xcode-select", ["-p"]);
} catch {
  skip("no Swift compiler (Xcode command line tools)");
}

const { INPUT_HELPER_SOURCE } = await import(pathToFileURL(resolve(sourceModule)).href);
const version = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version;
const hash = createHash("sha256").update(INPUT_HELPER_SOURCE).update(identity).update(version).digest("hex").slice(0, 16);
const app = join(resolve(outDir), "LinkShell.app");
const plistPath = join(app, "Contents/Info.plist");

if (existsSync(plistPath) && readFileSync(plistPath, "utf8").includes(hash)) {
  try {
    run("/usr/bin/codesign", ["--verify", "--strict", app]);
    console.log(`[build-helper] ${app} is up to date`);
    process.exit(0);
  } catch {
    // Built from this source but no longer intact: build it again.
  }
}

const work = mkdtempSync(join(tmpdir(), "linkshell-helper-"));
try {
  const source = join(work, "helper.swift");
  writeFileSync(source, INPUT_HELPER_SOURCE);
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const slice = join(work, arch);
    run("/usr/bin/swiftc", ["-O", "-swift-version", "5", "-target", `${arch}-apple-macos12.0`, "-o", slice, source], { timeout: 300_000 });
    slices.push(slice);
  }

  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  run("/usr/bin/lipo", ["-create", ...slices, "-output", join(app, "Contents/MacOS/LinkShell")]);

  // The app's face in System Settings: the same icon as the phone app.
  const icon = join(here, "../../../apps/client/assets/icon.png");
  let hasIcon = false;
  if (existsSync(icon)) {
    const iconset = join(work, "AppIcon.iconset");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      run("/usr/bin/sips", ["-z", String(size), String(size), icon, "--out", join(iconset, `icon_${size}x${size}.png`)]);
      run("/usr/bin/sips", ["-z", String(size * 2), String(size * 2), icon, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
    }
    run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(app, "Contents/Resources/AppIcon.icns")]);
    hasIcon = true;
  }

  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>LinkShell</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>LinkShell</string>
  <key>CFBundleDisplayName</key><string>LinkShell</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>${hasIcon ? "\n  <key>CFBundleIconFile</key><string>AppIcon</string>" : ""}
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>LinkShellSourceHash</key><string>${hash}</string>
</dict>
</plist>
`,
  );

  // The identity is what the system's permission is given to: the same one every release, so it is given once.
  run("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp", "--identifier", BUNDLE_ID, "--sign", identity, app]);
  run("/usr/bin/codesign", ["--verify", "--strict", app]);
  console.log(`[build-helper] built and signed ${app} (${identity})`);
} catch (error) {
  rmSync(app, { recursive: true, force: true });
  const detail = error.stderr?.toString().trim() || error.message;
  if (required) {
    console.error(`[build-helper] failed: ${detail}`);
    process.exit(1);
  }
  console.warn(`[build-helper] failed (${detail}) — skipping LinkShell.app`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
