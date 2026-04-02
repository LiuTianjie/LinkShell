#!/usr/bin/env node

/**
 * Build a production iOS archive for App Store / TestFlight upload.
 *
 * Usage:
 *   node scripts/prod-build.mjs              # prebuild + archive + export
 *   node scripts/prod-build.mjs --skip-prebuild   # skip expo prebuild (if already done)
 *   node scripts/prod-build.mjs --open        # open Xcode after prebuild (manual archive)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as hostPlatform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const iosDir = resolve(appRoot, "ios");
const buildDir = resolve(appRoot, "build");
const archivePath = resolve(buildDir, "LinkShell.xcarchive");
const exportPath = resolve(buildDir, "export");
const exportPlist = resolve(buildDir, "ExportOptions.plist");

const args = process.argv.slice(2);
const skipPrebuild = args.includes("--skip-prebuild");
const openXcode = args.includes("--open");

if (hostPlatform() !== "darwin") {
  console.error("Production iOS builds require macOS with Xcode.");
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`\n  → ${cmd}\n`);
  const result = spawnSync("sh", ["-c", cmd], {
    cwd: opts.cwd ?? appRoot,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    console.error(`\n  ✗ Command failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// ── Step 1: Prebuild terminal HTML ──────────────────────────────────
console.log("\n  ━━━ Step 1/5: Build terminal HTML ━━━");
run("node scripts/build-terminal-html.mjs");

// ── Step 2: Expo prebuild ───────────────────────────────────────────
if (!skipPrebuild) {
  console.log("\n  ━━━ Step 2/5: Expo prebuild ━━━");
  run("npx expo prebuild --platform ios --clean");
} else {
  console.log("\n  ━━━ Step 2/5: Skipped (--skip-prebuild) ━━━");
}

// ── Step 3: Pod install ─────────────────────────────────────────────
console.log("\n  ━━━ Step 3/5: Pod install ━━━");
run("pod install", { cwd: iosDir });

// ── Open Xcode mode ─────────────────────────────────────────────────
if (openXcode) {
  console.log("\n  Opening Xcode... Archive manually via Product → Archive");
  run(`open "${resolve(iosDir, "LinkShell.xcworkspace")}"`);
  process.exit(0);
}

// ── Step 4: xcodebuild archive ──────────────────────────────────────
console.log("\n  ━━━ Step 4/5: Archive (Release) ━━━");
mkdirSync(buildDir, { recursive: true });

// Detect scheme
const scheme = "LinkShell";

run([
  "xcodebuild",
  "archive",
  `-workspace "${resolve(iosDir, "LinkShell.xcworkspace")}"`,
  `-scheme "${scheme}"`,
  `-configuration Release`,
  `-archivePath "${archivePath}"`,
  `-destination "generic/platform=iOS"`,
  `CODE_SIGN_STYLE=Automatic`,
  `-allowProvisioningUpdates`,
  `COMPILER_INDEX_STORE_ENABLE=NO`,
].join(" "));

if (!existsSync(archivePath)) {
  console.error("\n  ✗ Archive not found. Build failed.");
  process.exit(1);
}

console.log(`\n  ✓ Archive created: ${archivePath}`);

// ── Step 5: Export IPA ──────────────────────────────────────────────
console.log("\n  ━━━ Step 5/5: Export IPA ━━━");

// Generate ExportOptions.plist for App Store upload
const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>destination</key>
    <string>upload</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>`;

import { writeFileSync } from "node:fs";
writeFileSync(exportPlist, plistContent, "utf8");

run([
  "xcodebuild",
  `-exportArchive`,
  `-archivePath "${archivePath}"`,
  `-exportOptionsPlist "${exportPlist}"`,
  `-exportPath "${exportPath}"`,
  `-allowProvisioningUpdates`,
].join(" "));

console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Production build complete!

  Archive:  ${archivePath}
  Export:   ${exportPath}

  The IPA has been uploaded to App Store Connect.
  Go to https://appstoreconnect.apple.com → TestFlight
  to manage your build.
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
