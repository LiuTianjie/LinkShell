#!/usr/bin/env node
// Puts the Electron window into LinkShell.app, one bundle with one identity
// (com.bd.linkshell.host and its Developer ID), and signs it:
//
//   Contents/MacOS/LinkShell            the Swift app (CFBundleExecutable): screen, input, setup;
//                                       opened by the user, it execs the window below
//   Contents/MacOS/LinkShell Desktop    Electron's main executable
//   Contents/Frameworks/                Electron Framework, the four LinkShell Helper apps,
//                                       LinkShellNative.node, WebRTC, Sparkle
//   Contents/Resources/app/             this package's compiled main and preload
//   Contents/Resources/Workspace/       the web workspace (from build-app.mjs)
//
//   node scripts/package.mjs [--app <LinkShell.app from apps/mac/build-app.mjs>] [--out <dir>] [--electron <Electron.app>]
//
// --electron: another architecture's Electron (scripts/electron-dist.mjs); the installed one by default.
//
// Run apps/mac's build first (pnpm --filter @linkshell/mac build). The input is copied, never changed.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mac = resolve(here, "../mac");
const option = (flag, fallback) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback);
const source = resolve(option("--app", join(mac, "build/LinkShell.app")));
const out = resolve(option("--out", join(here, "build")));
const app = join(out, "LinkShell.app");
const BUNDLE_ID = "com.bd.linkshell.host";
const NAME = "LinkShell";
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });
const capture = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const plist = (file) => ({
  set(key, type, value) {
    try { capture("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, file]); } catch { /* absent */ }
    run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, file]);
  },
  remove(key) { try { capture("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, file]); } catch { /* absent */ } },
});

if (process.platform !== "darwin") throw new Error("LinkShell.app is packaged on macOS");
if (!existsSync(join(source, "Contents/MacOS/LinkShell"))) throw new Error(`Build apps/mac first: ${source} is missing`);
// require("electron") is the path of Electron.app/Contents/MacOS/Electron.
const electron = resolve(option("--electron", dirname(dirname(dirname(createRequire(import.meta.url)("electron"))))));
if (!existsSync(electron)) throw new Error(`Electron is not installed: ${electron}`);

// The workspace is rebuilt here, so a change to apps/web needs no Swift rebuild.
const web = resolve(here, "../web");
const workspaceOut = join(here, "build/.workspace");
console.log("[package] building the workspace");
run("pnpm", ["exec", "tsc", "--noEmit"], { cwd: web });
rmSync(workspaceOut, { recursive: true, force: true });
run("pnpm", ["exec", "vite", "build", "--outDir", workspaceOut, "--emptyOutDir"], { cwd: web });
console.log("[package] compiling the window");
run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], { cwd: here });
console.log("[package] building LinkShellNative (release, universal)");
const scratch = join(mac, "build/swiftpm");
const nativeArgs = ["build", "-c", "release", "--arch", "arm64", "--arch", "x86_64", "--product", "LinkShellNative", "--package-path", mac, "--scratch-path", scratch];
run("/usr/bin/swift", nativeArgs);
const nativeBin = capture("/usr/bin/swift", [...nativeArgs, "--show-bin-path"]);

mkdirSync(out, { recursive: true });
const staged = join(out, `.LinkShell.app.${process.pid}`);
rmSync(staged, { recursive: true, force: true });
try {
  run("/usr/bin/ditto", [source, staged]);
  const contents = join(staged, "Contents");
  rmSync(join(contents, "Resources/Workspace"), { recursive: true, force: true });
  cpSync(workspaceOut, join(contents, "Resources/Workspace"), { recursive: true });

  // Electron's main executable beside the Swift one, its framework and helpers under our name.
  run("/usr/bin/ditto", [join(electron, "Contents/MacOS/Electron"), join(contents, "MacOS/LinkShell Desktop")]);
  for (const name of ["Electron Framework.framework", "Mantle.framework", "ReactiveObjC.framework", "Squirrel.framework"]) {
    run("/usr/bin/ditto", [join(electron, "Contents/Frameworks", name), join(contents, "Frameworks", name)]);
  }
  for (const suffix of ["", " (GPU)", " (Plugin)", " (Renderer)"]) {
    const from = join(electron, "Contents/Frameworks", `Electron Helper${suffix}.app`);
    const to = join(contents, "Frameworks", `${NAME} Helper${suffix}.app`);
    run("/usr/bin/ditto", [from, to]);
    renameSync(join(to, "Contents/MacOS", `Electron Helper${suffix}`), join(to, "Contents/MacOS", `${NAME} Helper${suffix}`));
    const info = plist(join(to, "Contents/Info.plist"));
    info.set("CFBundleExecutable", "string", `'${NAME} Helper${suffix}'`);
    info.set("CFBundleName", "string", `'${NAME} Helper${suffix}'`);
    info.set("CFBundleDisplayName", "string", `'${NAME} Helper${suffix}'`);
    info.set("CFBundleIdentifier", "string", `${BUNDLE_ID}.helper${suffix ? "." + suffix.slice(2, -1).toLowerCase() : ""}`);
  }
  // Electron's resources it reads by name; its default app is not ours.
  for (const entry of readdirSync(join(electron, "Contents/Resources"))) {
    if (entry.endsWith(".lproj") || entry === "default_app.asar" || entry === "electron.icns") continue;
    cpSync(join(electron, "Contents/Resources", entry), join(contents, "Resources", entry), { recursive: true });
  }
  for (const entry of readdirSync(join(electron, "Contents/Resources")).filter((name) => name.endsWith(".lproj"))) {
    // Chromium's strings for the system's languages; keep only those we ship UI in.
    if (!["en.lproj", "zh_CN.lproj", "zh_TW.lproj", "Base.lproj"].includes(entry)) continue;
    cpSync(join(electron, "Contents/Resources", entry), join(contents, "Resources", entry), { recursive: true });
  }

  // The window's code, as a plain folder (Electron loads Resources/app).
  const appDir = join(contents, "Resources/app");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  cpSync(join(here, "dist"), join(appDir, "dist"), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  const version = capture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(contents, "Info.plist")]);
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "linkshell", productName: NAME, version, type: pkg.type, main: pkg.main, private: true }, null, 2));
  if (existsSync(join(here, "assets"))) cpSync(join(here, "assets"), join(appDir, "assets"), { recursive: true });

  // The native module beside the frameworks it loads (@loader_path).
  cpSync(join(nativeBin, "libLinkShellNative.dylib"), join(contents, "Frameworks/LinkShellNative.node"));

  // One Info.plist: the Swift executable stays CFBundleExecutable; Electron's keys join it.
  const info = plist(join(contents, "Info.plist"));
  info.set("NSPrincipalClass", "string", "AtomApplication");
  info.set("NSRequiresAquaSystemAppearance", "bool", "false");
  info.set("NSSupportsAutomaticGraphicsSwitching", "bool", "true");
  info.set("NSQuitAlwaysKeepsWindows", "bool", "false");
  info.set("LSApplicationCategoryType", "string", "public.app-category.developer-tools");
  info.set("LSEnvironment", "dict", "");
  run("/usr/libexec/PlistBuddy", ["-c", "Add :LSEnvironment:MallocNanoZone string 0", join(contents, "Info.plist")]);
  // The window is in the Dock; the screen helper hides itself (setActivationPolicy) as before.
  info.remove("LSUIElement");

  // Signing: inside out, every Mach-O with the app's identity and hardened runtime.
  let identity = process.env.LINKSHELL_SIGN_IDENTITY;
  if (!identity) identity = /"(Developer ID Application: [^"]+)"/.exec(capture("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]))?.[1];
  if (!identity && process.env.LINKSHELL_REQUIRE_SIGNED === "1") throw new Error("No Developer ID Application identity");
  identity ??= "-";
  const entitlements = join(here, "config/entitlements.plist");
  const helperEntitlements = join(here, "config/helper-entitlements.plist");
  const sign = (path, extra = []) => run("/usr/bin/codesign", ["--force", "--sign", identity, "--timestamp", "--options", "runtime", ...extra, path]);
  const frameworks = join(contents, "Frameworks");
  const electronFramework = join(frameworks, "Electron Framework.framework");
  for (const lib of readdirSync(join(electronFramework, "Versions/A/Libraries"))) sign(join(electronFramework, "Versions/A/Libraries", lib));
  for (const helper of ["chrome_crashpad_handler", "app_shim_loader"]) {
    const path = join(electronFramework, "Versions/A/Helpers", helper);
    if (existsSync(path)) sign(path);
  }
  for (const name of ["Electron Framework.framework", "Mantle.framework", "ReactiveObjC.framework"]) sign(join(frameworks, name));
  const squirrel = join(frameworks, "Squirrel.framework");
  if (existsSync(join(squirrel, "Versions/A/Resources/ShipIt"))) sign(join(squirrel, "Versions/A/Resources/ShipIt"));
  sign(squirrel);
  for (const suffix of ["", " (GPU)", " (Plugin)", " (Renderer)"]) {
    sign(join(frameworks, `${NAME} Helper${suffix}.app`), ["--entitlements", helperEntitlements]);
  }
  sign(join(frameworks, "LinkShellNative.node"));
  // Sparkle and WebRTC were signed by build-app.mjs; the bundle seal changes, so sign the outer code again.
  // The window is this app after exec: the same identifier as the bundle.
  sign(join(contents, "MacOS/LinkShell Desktop"), ["--entitlements", entitlements, "--identifier", BUNDLE_ID]);
  for (const name of readdirSync(join(contents, "MacOS"))) {
    const path = join(contents, "MacOS", name);
    if (name === "LinkShell" || name === "LinkShell Desktop") continue;
    // The standalone runtime (node, linkshell-cli) keeps the entitlements its own build gave it.
    try { capture("/usr/bin/codesign", ["--verify", path]); } catch { sign(path); }
  }
  run("/usr/bin/codesign", ["--force", "--sign", identity, "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--identifier", BUNDLE_ID, staged]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", staged]);

  rmSync(app, { recursive: true, force: true });
  renameSync(staged, app);
  chmodSync(app, 0o755);
  console.log(`[package] ${app} (${identity === "-" ? "ad hoc" : identity})`);
} catch (error) {
  rmSync(staged, { recursive: true, force: true });
  throw error;
}
