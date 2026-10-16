import { spawn } from "node:child_process";
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { linkshellDir } from "../utils/daemon.js";

export interface CliCommand {
  command: string;
  args: string[];
}

/** A host-owned terminal can disappear during restart; the updater must survive it. */
export async function runUpgradeWorker(cli: CliCommand, options: { home?: string; timeoutMs?: number } = {}): Promise<string> {
  const home = resolve(options.home ?? linkshellDir());
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = join(home, "upgrade.log");
  const fd = openSync(log, "w", 0o600);
  process.stderr.write(`  Updating the host; progress is saved in ${log}\n`);
  try {
    fchmodSync(fd, 0o600);
    const child = spawn(cli.command, [...cli.args, "host", "--_upgrade-host"], {
      detached: true,
      cwd: home,
      env: { ...process.env, LINKSHELL_HOME: home },
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    return await new Promise<string>((complete, fail) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        // Do not kill an updater between stopping and starting the host.
        fail(new Error(`The host update is still running. Check ${log} and linkshell host status.`));
      }, options.timeoutMs ?? 120_000);
      child.once("error", (error) => { settled = true; clearTimeout(timer); fail(error); });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          const output = readFileSync(log, "utf8");
          if (code === 0) complete(output);
          else fail(new Error(`Host update exited with ${signal ?? code}.\n${output.trim()}\nSee ${log}`));
        } catch (error) { fail(error); }
      });
    });
  } finally {
    closeSync(fd);
  }
}
