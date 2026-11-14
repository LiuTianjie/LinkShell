#!/usr/bin/env node
// From a checkout: the workspace from apps/desktop-ui/dist and the CLI from packages/cli/dist, in an
// Electron window. Set LINKSHELL_HOME for a state directory of its own (recommended: the
// installed Host keeps ~/.linkshell).
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(here, "../..");
if (!process.env.LINKSHELL_WORKSPACE_ASSETS && !existsSync(resolve(here, "../desktop-ui/dist/index.html"))) {
  execFileSync("pnpm", ["--filter", "@linkshell/desktop-ui", "build"], { cwd: root, stdio: "inherit" });
}
if (!existsSync(join(here, "dist/main/main.js"))) {
  execFileSync("pnpm", ["--filter", "@linkshell/desktop", "exec", "tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
}
const electron = createRequire(import.meta.url)("electron");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const hasUserData = args.some((arg) => arg.startsWith("--user-data-dir"));
const defaultUserData = process.platform === "darwin"
  ? join(homedir(), "Library/Application Support/LinkShell Dev")
  : join(homedir(), ".linkshell-dev-window");
const electronFlags = hasUserData ? [] : [`--user-data-dir=${defaultUserData}`];
const child = spawn(electron, [...electronFlags, here, ...args], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
child.on("exit", (code) => process.exit(code ?? 0));
