#!/usr/bin/env node
// From a checkout: the workspace from apps/web/dist and the CLI from packages/cli/dist, in an
// Electron window. Set LINKSHELL_HOME for a state directory of its own (recommended: the
// installed Host keeps ~/.linkshell).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
child.on("exit", (code) => process.exit(code ?? 0));
