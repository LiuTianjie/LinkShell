#!/usr/bin/env node
// Builds LinkShell.app — the signed app that holds this Mac's permissions, sends its screen and
// posts a viewer's pointer and key events (see ../README.md and ../Sources/LinkShell) — into
// ../build:
//
//   LinkShell.app           the app
//   LinkShell.app.tar.gz    the app as it is shipped: one file, unpacked on the user's computer
//                           with /usr/bin/tar -xzf. A package manager can't carry the app itself:
//                           npm leaves out the framework's symbolic links, and pnpm the
//                           executable's permission to run.
//
//   node scripts/build-app.mjs [--out <directory>]
//
// For Apple silicon only: Intel Macs are not supported.
//
// It needs macOS and Xcode's Swift. The system gives the Screen Recording and Accessibility
// permissions to a signing identity and a bundle id, so a build that users get has to carry the
// same two every time: the "Developer ID Application" identity in the keychain (or the one
// LINKSHELL_SIGN_IDENTITY names). Where there is none (another developer's Mac, CI) the app is
// signed ad hoc: it runs, but the system takes it for another app than the released one, and
// whatever it is allowed is asked for again. LINKSHELL_REQUIRE_SIGNED=1, which a release sets,
// makes a missing identity fatal.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ID = "com.bd.linkshell.host";
const MINIMUM_SYSTEM = "13.0";
const ARCH = "arm64";
const RPATH = "@executable_path/../Frameworks";
const AD_HOC = "-";
const option = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
const out = option("--out") ? resolve(option("--out")) : join(root, "build");
// SwiftPM's own work, and the framework it downloads: kept in one place whatever --out says.
const scratch = join(root, "build", "swiftpm");
const app = join(out, "LinkShell.app");
const archive = join(out, "LinkShell.app.tar.gz");

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const fail = (reason) => {
  console.error(`[build-app] ${reason}`);
  process.exit(1);
};
/** What a command said (codesign and spctl say it on stderr), whether or not it liked what it saw. */
const report = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { ok: result.status === 0, said: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

if (process.platform !== "darwin") fail("LinkShell.app is built on macOS");

let identity = process.env.LINKSHELL_SIGN_IDENTITY;
if (!identity) {
  const identities = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  identity = /"(Developer ID Application: [^"]+)"/.exec(identities)?.[1];
}
const adHoc = !identity || identity === AD_HOC;
if (adHoc && process.env.LINKSHELL_REQUIRE_SIGNED === "1") fail("no Developer ID Application signing identity in the keychain, and LINKSHELL_REQUIRE_SIGNED=1");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

console.log(`[build-app] swift build (${ARCH})`);
const built = spawnSync("/usr/bin/swift", ["build", "-c", "release", "--arch", ARCH, "--package-path", root, "--scratch-path", scratch], { encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
const said = `${built.stdout ?? ""}${built.stderr ?? ""}`;
if (built.status !== 0) fail(`swift build failed:\n${said}`);
// A build that passes says nothing else: the compiler's warnings are worth reading.
const warnings = said.split("\n").filter((line) => line.includes("warning:"));
if (warnings.length) console.log(`[build-app] the compiler warns:\n${warnings.join("\n")}`);
const program = join(scratch, `${ARCH}-apple-macosx`, "release", "LinkShell");
// SwiftPM leaves the build's own search paths in the binary (this Mac's Xcode among them).
// In the app there is one place to look: Contents/Frameworks.
for (const [, path] of run("/usr/bin/otool", ["-l", program]).matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+) \(offset \d+\)/g)) {
  if (path !== RPATH && path !== "/usr/lib/swift") run("/usr/bin/install_name_tool", ["-delete_rpath", path, program]);
}

// The framework as SwiftPM unpacked it: the macOS slice of the xcframework.
const artifacts = join(scratch, "artifacts");
const xcframework = readdirSync(artifacts)
  .map((name) => join(artifacts, name, "WebRTC", "WebRTC.xcframework"))
  .find((path) => existsSync(path));
if (!xcframework) fail(`WebRTC.xcframework is not under ${artifacts}`);
const plist = (file, key) => run("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, file]).trim();
let framework;
for (let index = 0; ; index += 1) {
  let platform;
  try {
    platform = plist(join(xcframework, "Info.plist"), `:AvailableLibraries:${index}:SupportedPlatform`);
  } catch {
    break;
  }
  let variant = "";
  try {
    variant = plist(join(xcframework, "Info.plist"), `:AvailableLibraries:${index}:SupportedPlatformVariant`);
  } catch {
    // The plain macOS slice has none.
  }
  if (platform === "macos" && !variant) {
    framework = join(xcframework, plist(join(xcframework, "Info.plist"), `:AvailableLibraries:${index}:LibraryIdentifier`), "WebRTC.framework");
    break;
  }
}
if (!framework || !existsSync(framework)) fail(`no macOS slice of WebRTC.xcframework under ${xcframework}`);

const work = mkdtempSync(join(tmpdir(), "linkshell-app-"));
// Put together beside where it goes, and moved there whole: whoever is running the app in
// build/ never sees half of one.
const staged = join(out, `.LinkShell.app.${process.pid}`);
try {
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(join(staged, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(staged, "Contents/Resources"), { recursive: true });
  mkdirSync(join(staged, "Contents/Frameworks"), { recursive: true });
  cpSync(program, join(staged, "Contents/MacOS/LinkShell"));

  // The framework, with its links kept, without what only a compiler reads, and without the
  // half of it that is for Intel.
  const embedded = join(staged, "Contents/Frameworks/WebRTC.framework");
  run("/usr/bin/ditto", [framework, embedded]);
  for (const name of ["Headers", "Modules"]) {
    rmSync(join(embedded, name), { recursive: true, force: true });
    rmSync(join(embedded, "Versions/A", name), { recursive: true, force: true });
  }
  const library = join(embedded, "Versions/A/WebRTC");
  if (run("/usr/bin/lipo", ["-archs", library]).trim() !== ARCH) run("/usr/bin/lipo", [library, "-thin", ARCH, "-output", library]);

  // The app's face in System Settings: the same icon as the phone app.
  const icon = join(root, "../client/assets/icon.png");
  let hasIcon = false;
  if (existsSync(icon)) {
    const iconset = join(work, "AppIcon.iconset");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      run("/usr/bin/sips", ["-z", String(size), String(size), icon, "--out", join(iconset, `icon_${size}x${size}.png`)]);
      run("/usr/bin/sips", ["-z", String(size * 2), String(size * 2), icon, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
    }
    run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(staged, "Contents/Resources/AppIcon.icns")]);
    hasIcon = true;
  }

  writeFileSync(
    join(staged, "Contents/Info.plist"),
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
  <key>LSMinimumSystemVersion</key><string>${MINIMUM_SYSTEM}</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
  );

  // Signed from the inside out: the framework, then the app around it. The identity and the
  // identifier are what the system's permission is given to: the same ones every build.
  // An ad hoc signature names no team, and a hardened program loads only frameworks of its own
  // team (or Apple's): ad hoc, the app is left unhardened so that it can load its framework.
  const sign = adHoc ? ["--force", "--sign", AD_HOC] : ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
  if (adHoc) {
    console.log("[build-app] NO Developer ID Application identity to sign with: signing ad hoc.");
    console.log("[build-app] This app runs here, but is not the released LinkShell to the system: its permissions are its own, and asked for again. Not for release.");
  } else console.log(`[build-app] signing as ${identity}`);
  run("/usr/bin/codesign", [...sign, embedded]);
  run("/usr/bin/codesign", [...sign, "--identifier", BUNDLE_ID, staged]);

  rmSync(app, { recursive: true, force: true });
  renameSync(staged, app);
} catch (error) {
  rmSync(staged, { recursive: true, force: true });
  fail(error.stderr?.toString().trim() || error.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// What the system makes of it. Not notarized yet, so Gatekeeper's verdict is a report, not a failure.
const verify = (path) => report("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", path]);
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const verified = verify(app);
console.log(`[build-app] codesign --verify --deep --strict: ${verified.ok ? "ok" : "FAILED"}\n${verified.said}`);
if (!verified.ok) process.exit(1);
if (!adHoc) {
  const assessed = report("/usr/sbin/spctl", ["-a", "-vv", app]);
  console.log(`[build-app] spctl -a -vv: ${assessed.ok ? "accepted" : "rejected"}\n${assessed.said}`);
}
const archs = (path) => run("/usr/bin/lipo", ["-archs", join(app, path)]).trim();
console.log(`[build-app] architectures: the program ${archs("Contents/MacOS/LinkShell")}, the framework ${archs("Contents/Frameworks/WebRTC.framework/Versions/A/WebRTC")}`);
console.log(`[build-app] ${app}: ${megabytes(Number(run("/usr/bin/du", ["-sk", app]).split("\t")[0]) * 1024)}, version ${version}${adHoc ? ", signed ad hoc" : ""}`);

// The archive: links and permissions as they are, and none of the Mac's own extras (extended
// attributes, "._" files), which would only be different on every Mac that builds it.
const packing = `${archive}.${process.pid}`;
const unpacked = mkdtempSync(join(tmpdir(), "linkshell-unpacked-"));
try {
  run("/usr/bin/tar", ["--no-xattrs", "--no-mac-metadata", "-czf", packing, "-C", out, "LinkShell.app"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  // Unpacked somewhere else, as it will be on a user's computer, it has to be the same app.
  run("/usr/bin/tar", ["-xzf", packing, "-C", unpacked]);
  const copy = join(unpacked, "LinkShell.app");
  const problems = [];
  if (!lstatSync(join(copy, "Contents/Frameworks/WebRTC.framework/WebRTC")).isSymbolicLink()) problems.push("the framework's links did not survive");
  if (!(statSync(join(copy, "Contents/MacOS/LinkShell")).mode & 0o111)) problems.push("the program lost its permission to run");
  const intact = verify(copy);
  if (!intact.ok) problems.push(`the signature does not verify:\n${intact.said}`);
  if (problems.length) fail(`LinkShell.app.tar.gz does not unpack into the app it was made from: ${problems.join("; ")}`);
  renameSync(packing, archive);
  console.log("[build-app] unpacked with /usr/bin/tar -xzf: links kept, runnable, codesign --verify --deep --strict ok");
} catch (error) {
  rmSync(packing, { force: true });
  fail(error.stderr?.toString().trim() || error.message);
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
console.log(`[build-app] ${archive}: ${megabytes(statSync(archive).size)}`);
console.log(`[build-app] sha256 ${createHash("sha256").update(readFileSync(archive)).digest("hex")}`);
