import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { inspectLocalState } from "../src/commands/doctor.js";

it("loads the installed native module when doctor runs outside a Node project", () => {
  const cwd = mkdtempSync(join(tmpdir(), "linkshell doctor cwd "));
  const doctorUrl = new URL("../src/commands/doctor.ts", import.meta.url).href;
  const loader = createRequire(import.meta.url).resolve("tsx");

  try {
    const output = execFileSync(process.execPath, [
      "--import", loader,
      "--input-type=module",
      "--eval",
      `const { runDoctor } = await import(${JSON.stringify(doctorUrl)}); ` +
        // Explicit local invalid port avoids contacting any saved user gateway.
        `await runDoctor("http://127.0.0.1:1/ws");`,
    ], { cwd, encoding: "utf8", timeout: 15_000 });

    expect(output).toContain("node-pty: loaded");
    expect(output).not.toContain("native module not built");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("reports state.db/lsa.db sizes, WAL bloat, and stale PID/socket/lock diagnostics", () => {
  const home = mkdtempSync(join(tmpdir(), "lsh-doc-state-"));
  const runDir = join(home, "run");
  mkdirSync(runDir, { recursive: true });
  try {
    writeFileSync(join(home, "state.db"), Buffer.alloc(4096));
    writeFileSync(join(home, "state.db-wal"), "");
    truncateSync(join(home, "state.db-wal"), 2 * 1024 * 1024);
    writeFileSync(join(home, "lsa.db"), Buffer.alloc(2048));
    writeFileSync(join(home, "host.pid"), "999999992\n");
    writeFileSync(join(runDir, "host.sock"), "");
    writeFileSync(join(runDir, "host.lock"), '{"pid":999999992}\n');

    const failed = inspectLocalState({
      home,
      runDir,
      hostSocket: join(runDir, "host.sock"),
      hostRunning: false,
      walWarnBytes: 1024 * 1024,
    });
    const storage = failed.find((r) => r.name === "Storage");
    expect(storage?.ok).toBe(false);
    expect(storage?.detail).toContain("WAL bloat");
    expect(storage?.detail).toContain("state.db");
    expect(storage?.detail).toContain("lsa.db");

    const hostState = failed.find((r) => r.name === "Host state");
    expect(hostState?.ok).toBe(false);
    expect(hostState?.detail).toContain("stale host.pid");
    expect(hostState?.detail).toContain("stale socket");
    expect(hostState?.detail).toContain("stale lock");

    const healthy = inspectLocalState({
      home,
      runDir,
      hostSocket: join(runDir, "host.sock"),
      hostRunning: true,
      walWarnBytes: 64 * 1024 * 1024,
    });
    expect(healthy.find((r) => r.name === "Storage")?.ok).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
