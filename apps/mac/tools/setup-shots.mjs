#!/usr/bin/env node
// Draws LinkShell.app's setup window (`--setup`) in every state, in light and dark, in Chinese and
// English, into PNG files — without showing a window, asking the system anything or opening
// System Settings: the states are pretended (`--pretend`), and the app draws its own window into
// the file (`--snapshot`). For looking at the window after changing it.
//
//   node tools/setup-shots.mjs [directory]      default: build/setup-shots
//
// The files: <state>-<light|dark>-<zh|en>.png, a state being none, recording, control or both,
// and `-pressed` where the first missing row's button has been pressed (it then says what to do
// in System Settings).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP } from "./app.mjs";

const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../build/setup-shots"));
if (!existsSync(APP)) throw new Error(`${APP} is not built: node scripts/build-app.mjs`);
mkdirSync(directory, { recursive: true });

const STATES = ["none", "none-pressed", "recording", "recording-pressed", "control", "both"];
let missing = 0;
for (const [language, system] of [["zh", "(zh-Hans)"], ["en", "(en)"]]) {
  for (const look of ["light", "dark"]) {
    for (const state of STATES) {
      const file = join(directory, `${state}-${look}-${language}.png`);
      const [granted, pressed] = state.split("-");
      // In the background (-g): nothing comes to the front. -W: until the file is written.
      execFileSync("/usr/bin/open", ["-W", "-n", "-g", "-a", APP, "--args", "--setup", "--pretend", granted, ...(pressed ? ["--pressed"] : []), "--appearance", look, "--snapshot", file, "-AppleLanguages", system]);
      if (!existsSync(file)) missing += 1;
      console.log(`${existsSync(file) ? "  " : "NO"} ${file}`);
    }
  }
}
if (missing) {
  console.error(`[setup-shots] FAILED: ${missing} pictures were not drawn`);
  process.exit(1);
}
