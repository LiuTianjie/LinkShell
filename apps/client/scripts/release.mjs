#!/usr/bin/env node
// Release builds of the app, from a clean prebuild of the release variant.
//
//   node scripts/release.mjs ios [version]       archive + upload to TestFlight
//   node scripts/release.mjs android [version]   build/outputs: AAB + APK
//
// With a version (CI passes the tag's), app.json gets it and the build number
// MAJOR*10000 + MINOR*100 + PATCH first; otherwise app.json is used as is.
// --prepare-only exports an IPA locally without uploading or distributing it.
// Development builds are separate: APP_VARIANT=development (see app.config.js).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const prepareOnly = args.includes("--prepare-only");
const [platform, version] = args.filter((arg) => arg !== "--prepare-only");
if (args.some((arg) => arg.startsWith("--") && arg !== "--prepare-only")) throw new Error("unknown release option");
const TEAM_ID = "L95PYLFT86";

if (platform !== "ios" && platform !== "android") {
  console.error("usage: node scripts/release.mjs ios|android [x.y.z] [--prepare-only]");
  process.exit(1);
}

const env = { ...process.env };
delete env.APP_VARIANT;

function run(command, args, cwd = root) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit", env });
}

const appJsonPath = join(root, "app.json");
const app = JSON.parse(readFileSync(appJsonPath, "utf8"));
if (version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a version: ${version}`);
  const [, major, minor, patch] = match.map(Number);
  const code = major * 10000 + minor * 100 + patch;
  app.expo.version = version;
  app.expo.ios.buildNumber = String(code);
  app.expo.android.versionCode = code;
  writeFileSync(appJsonPath, `${JSON.stringify(app, null, 2)}\n`);
}
console.log(`LinkShell ${app.expo.version} (${platform === "ios" ? app.expo.ios.buildNumber : app.expo.android.versionCode})`);

run("npx", ["expo", "prebuild", "--platform", platform, "--clean"]);

const outDir = join(root, "build", "release");
mkdirSync(outDir, { recursive: true });

if (platform === "ios") {
  const archive = join(outDir, "LinkShell.xcarchive");
  rmSync(archive, { recursive: true, force: true });
  run("xcodebuild", [
    "archive",
    "-workspace", "ios/LinkShell.xcworkspace",
    "-scheme", "LinkShell",
    "-configuration", "Release",
    "-archivePath", archive,
    "-derivedDataPath", join(outDir, "DerivedData"),
    "-destination", "generic/platform=iOS",
    "-allowProvisioningUpdates",
    "CODE_SIGN_STYLE=Automatic",
    `DEVELOPMENT_TEAM=${TEAM_ID}`,
    "COMPILER_INDEX_STORE_ENABLE=NO",
  ]);
  const options = join(outDir, "ExportOptions.plist");
  writeFileSync(
    options,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${prepareOnly ? "export" : "upload"}</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`,
  );
  run("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportOptionsPlist", options, "-exportPath", join(outDir, "export"), "-allowProvisioningUpdates"]);
  console.log(prepareOnly ? `\nPrepared IPA in ${join(outDir, "export")}; no upload or publication performed.` : "\nUploaded to App Store Connect; the build shows up in TestFlight after processing.");
} else {
  const android = join(root, "android");
  run("./gradlew", [
    "bundleRelease",
    "assembleRelease",
    "--console=plain",
    // Release lint needs more than the template's JVM limits (Metaspace runs out).
    "-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1536m",
    // Phones only (x86 is for emulators), and R8. Not resource shrinking: it
    // drops the brand colors the app looks up by name (PlatformColor).
    "-PreactNativeArchitectures=arm64-v8a,armeabi-v7a",
    "-Pandroid.enableMinifyInReleaseBuilds=true",
  ], android);
  const name = `LinkShell-${app.expo.version}`;
  copyFileSync(join(android, "app/build/outputs/bundle/release/app-release.aab"), join(outDir, `${name}.aab`));
  copyFileSync(join(android, "app/build/outputs/apk/release/app-release.apk"), join(outDir, `${name}.apk`));
  console.log(`\n${join(outDir, name)}.apk / .aab`);
}
