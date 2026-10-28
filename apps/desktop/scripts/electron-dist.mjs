#!/usr/bin/env node
// Prints where Electron is for a platform and architecture, the same Electron version as this
// package's: the installed one when it is that build, else the release zip, checked against the
// SHA-256 sums the electron package ships, unpacked once into build/electron-<version>-<arch>
// (darwin: the path of Electron.app) or build/electron-<version>-win32-<arch> (win32: the
// folder holding electron.exe).
//
//   node scripts/electron-dist.mjs <arm64|x64> [darwin|win32]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arch = process.argv[2];
const platform = process.argv[3] ?? "darwin";
if (arch !== "arm64" && arch !== "x64") throw new Error("usage: electron-dist.mjs <arm64|x64> [darwin|win32]");
if (platform !== "darwin" && platform !== "win32") throw new Error("usage: electron-dist.mjs <arm64|x64> [darwin|win32]");
const require = createRequire(import.meta.url);
const electronPackage = require.resolve("electron/package.json");
const { version } = require(electronPackage);
const installedDist = join(dirname(electronPackage), "dist");

/** Downloads and unpacks the release zip into `target` (once), with the system's own unzip. */
async function unpacked(target) {
  if (existsSync(target)) return;
  const { downloadArtifact } = createRequire(electronPackage)("@electron/get");
  const checksums = require(join(dirname(electronPackage), "checksums.json"));
  const zip = await downloadArtifact({ version, artifactName: "electron", platform, arch, checksums });
  const staged = `${target}.${process.pid}`;
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  // ditto keeps the framework symlinks and modes that a plain unzip may not; Windows' tar reads zips.
  if (process.platform === "darwin") execFileSync("/usr/bin/ditto", ["-x", "-k", zip, staged]);
  else execFileSync("tar.exe", ["-xf", zip, "-C", staged], { windowsHide: true });
  rmSync(target, { recursive: true, force: true });
  renameSync(staged, target);
}

if (platform === "darwin") {
  const installed = join(installedDist, "Electron.app");
  const lipoArch = arch === "x64" ? "x86_64" : "arm64";
  const archsOf = (app) => execFileSync("/usr/bin/lipo", ["-archs", join(app, "Contents/MacOS/Electron")], { encoding: "utf8" }).trim().split(/\s+/);
  if (process.platform === "darwin" && existsSync(installed) && archsOf(installed).includes(lipoArch)) {
    process.stdout.write(installed);
  } else {
    const target = join(here, "build", `electron-${version}-${arch}`);
    await unpacked(target);
    const app = join(target, "Electron.app");
    if (!archsOf(app).includes(lipoArch)) throw new Error(`${app} is not ${arch}`);
    process.stdout.write(app);
  }
} else {
  // The installed package is this machine's build: Windows on that architecture only.
  const installed = process.platform === "win32" && process.arch === arch && existsSync(join(installedDist, "electron.exe"))
    && readFileSync(join(installedDist, "version"), "utf8").trim() === version;
  const target = installed ? installedDist : join(here, "build", `electron-${version}-win32-${arch}`);
  if (!installed) await unpacked(target);
  if (!existsSync(join(target, "electron.exe"))) throw new Error(`${target} has no electron.exe`);
  process.stdout.write(target);
}
