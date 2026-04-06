#!/usr/bin/env node

import { spawn } from "node:child_process";
import { platform as hostPlatform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const requestedPlatform =
  args[0] && !args[0].startsWith("-") ? args[0] : defaultPlatform();
const passthroughArgs = args[0] === requestedPlatform ? args.slice(1) : args;
const installOnly = passthroughArgs.includes("--install-only");
const runArgs = passthroughArgs.filter((arg) => arg !== "--install-only");

if (!["ios", "android"].includes(requestedPlatform)) {
  console.error(`Unsupported platform: ${requestedPlatform}`);
  printHelp();
  process.exit(1);
}

if (requestedPlatform === "ios" && hostPlatform() !== "darwin") {
  console.error("iOS local builds require macOS with Xcode installed.");
  process.exit(1);
}

await runStep("Generate terminal HTML", ["pnpm", ["prebuild-terminal"]]);
await runStep(`Prebuild native ${requestedPlatform} project`, [
  "pnpm",
  ["exec", "expo", "prebuild", "-p", requestedPlatform],
]);
await runStep(`Install ${requestedPlatform} development build`, [
  "pnpm",
  ["exec", "expo", `run:${requestedPlatform}`, "--no-bundler", ...runArgs],
]);

if (!installOnly) {
  await runStep("Start Metro for Expo dev client", ["pnpm", ["start"]]);
}

function defaultPlatform() {
  return hostPlatform() === "darwin" ? "ios" : "android";
}

function printHelp() {
  console.log(`Usage: node scripts/dev-build.mjs [ios|android] [...expo-run-args] [--install-only]

Examples:
  pnpm devbuild
  pnpm devbuild ios
  pnpm devbuild ios --device
  pnpm devbuild ios --install-only
  pnpm devbuild android
`);
}

async function runStep(label, [command, commandArgs]) {
  console.log(`\n==> ${label}`);

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, {
      cwd: appRoot,
      stdio: "inherit",
      shell: false,
      env: process.env,
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          signal
            ? `${label} terminated by signal ${signal}`
            : `${label} failed with exit code ${code ?? "unknown"}`,
        ),
      );
    });

    child.on("error", rejectPromise);
  });
}
