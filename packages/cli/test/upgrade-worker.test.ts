import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpgradeWorker } from "../src/commands/upgrade-worker.js";

const homes: string[] = [];
const temporaryHome = () => { const path = mkdtempSync(join(tmpdir(), "linkshell-upgrade-worker-")); homes.push(path); return path; };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const cli = (script: string) => ({ command: process.execPath, args: ["-e", script, "--"] });

describe("detached host updater", () => {
  it("uses the new command, preserves its home and keeps a protected log", async () => {
    const home = temporaryHome();
    const result = await runUpgradeWorker(cli("console.log(JSON.stringify({args:process.argv.slice(1),home:process.env.LINKSHELL_HOME,cwd:process.cwd()}))"), { home });
    expect(JSON.parse(result)).toEqual({ args: ["host", "--_upgrade-host"], home, cwd: realpathSync(home) });
    expect(statSync(join(home, "upgrade.log")).mode & 0o777).toBe(0o600);
  });

  it("reports a failed restart instead of silently succeeding", async () => {
    const home = temporaryHome();
    await expect(runUpgradeWorker(cli("console.error('host could not start'); process.exit(1)"), { home })).rejects.toThrow("host could not start");
    await expect(runUpgradeWorker({ command: join(home, "missing-cli"), args: [] }, { home })).rejects.toThrow("ENOENT");
  });

  it("does not kill a worker while it is bringing the host back", async () => {
    const home = temporaryHome();
    const finished = join(home, "finished");
    const script = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(finished)}, 'ready'), 250)`;
    await expect(runUpgradeWorker(cli(script), { home, timeoutMs: 100 })).rejects.toThrow("still running");
    await expect.poll(() => existsSync(finished), { timeout: 3000 }).toBe(true);
  });

  it.skipIf(process.platform === "win32")("survives termination of the launching terminal's process group", async () => {
    const home = temporaryHome();
    const started = join(home, "started"), finished = join(home, "finished");
    const worker = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(finished)}, 'ready'), 750);`;
    const parent = join(home, "parent.mts");
    writeFileSync(parent, `import { runUpgradeWorker } from ${JSON.stringify(new URL("../src/commands/upgrade-worker.ts", import.meta.url).href)}; await runUpgradeWorker(${JSON.stringify(cli(worker))}, { home: ${JSON.stringify(home)} });`);
    const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), parent], { detached: true, stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      await expect.poll(() => existsSync(started), { timeout: 5000 }).toBe(true);
      process.kill(-child.pid!, "SIGTERM");
      await exited;
      await expect.poll(() => existsSync(finished), { timeout: 5000 }).toBe(true);
      expect(readFileSync(finished, "utf8")).toBe("ready");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (existsSync(started) && !existsSync(finished)) {
        try { process.kill(Number(readFileSync(started, "utf8")), "SIGKILL"); } catch { /* Already stopped. */ }
      }
      await exited;
    }
  });
});
