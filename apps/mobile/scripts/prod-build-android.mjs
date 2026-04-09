#!/usr/bin/env node

/**
 * Build a production Android AAB/APK for Play Store upload.
 *
 * Usage:
 *   node scripts/prod-build-android.mjs              # prebuild + bundle (AAB)
 *   node scripts/prod-build-android.mjs --apk        # build APK instead of AAB
 *   node scripts/prod-build-android.mjs --skip-prebuild   # skip expo prebuild
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const androidDir = resolve(appRoot, "android");
const buildDir = resolve(appRoot, "build");

const args = process.argv.slice(2);
const skipPrebuild = args.includes("--skip-prebuild");
const buildApk = args.includes("--apk");

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

// ── Step 0: Auto-increment Android versionCode ───────────────────────
const appJsonPath = resolve(appRoot, "app.json");
const appJson = JSON.parse(readFileSync(appJsonPath, "utf8"));
if (!appJson.expo.android) appJson.expo.android = {};
const prevCode = appJson.expo.android.versionCode ?? 0;
const nextCode = prevCode + 1;
appJson.expo.android.versionCode = nextCode;
writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n", "utf8");
console.log(`\n  ✦ versionCode: ${prevCode} → ${nextCode}`);

// ── Step 1: Prebuild terminal HTML ──────────────────────────────────
console.log("\n  ━━━ Step 1/3: Build terminal HTML ━━━");
run("node scripts/build-terminal-html.mjs");

// ── Step 2: Expo prebuild ───────────────────────────────────────────
if (!skipPrebuild) {
  console.log("\n  ━━━ Step 2/3: Expo prebuild ━━━");
  run("npx expo prebuild --platform android --clean");
} else {
  console.log("\n  ━━━ Step 2/3: Skipped (--skip-prebuild) ━━━");
}

// ── Step 3: Gradle build ────────────────────────────────────────────
const gradleTask = buildApk ? "assembleRelease" : "bundleRelease";
const outputLabel = buildApk ? "APK" : "AAB";
console.log(`\n  ━━━ Step 3/3: Gradle ${gradleTask} (${outputLabel}) ━━━`);

run(`./gradlew ${gradleTask}`, { cwd: androidDir });

// Copy output to build/
mkdirSync(buildDir, { recursive: true });

const outputFile = buildApk
  ? resolve(androidDir, "app/build/outputs/apk/release/app-release.apk")
  : resolve(androidDir, "app/build/outputs/bundle/release/app-release.aab");

const destFile = resolve(buildDir, buildApk ? "LinkShell.apk" : "LinkShell.aab");

if (!existsSync(outputFile)) {
  console.error(`\n  ✗ ${outputLabel} not found at ${outputFile}. Build failed.`);
  process.exit(1);
}

copyFileSync(outputFile, destFile);

console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Production Android build complete!

  ${outputLabel}:  ${destFile}

  ${buildApk
    ? "Install on device: adb install " + destFile
    : "Upload to Google Play Console:\n  https://play.google.com/console"}
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
