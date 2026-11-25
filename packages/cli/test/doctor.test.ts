import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  auditPermissions,
  detectProxyEnv,
  findExecutableInPath,
  inspectHostLog,
  inspectLocalState,
  inspectLogindKillUserProcesses,
} from "../src/commands/doctor.js";

describe("linkshell doctor", () => {
  it("loads the installed native module, runs PTY/SQLite probes, and sets exit code 1 when checks fail", () => {
    const cwd = mkdtempSync(join(tmpdir(), "linkshell doctor cwd "));
    const isolatedHome = mkdtempSync(join(tmpdir(), "linkshell-doctor-home-"));
    const doctorUrl = new URL("../src/commands/doctor.ts", import.meta.url).href;
    const loader = createRequire(import.meta.url).resolve("tsx");

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import", loader,
          "--input-type=module",
          "--eval",
          `const { runDoctor } = await import(${JSON.stringify(doctorUrl)}); ` +
            // Explicit local invalid port avoids contacting any saved user gateway.
            `await runDoctor("0.0.0-test", "http://127.0.0.1:1/ws");`,
        ],
        { cwd, encoding: "utf8", timeout: 15_000, env: { ...process.env, LINKSHELL_HOME: isolatedHome, NO_COLOR: "1" } },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("node-pty: loaded");
      expect(result.stdout).toContain("node:sqlite: in-memory probe ok");
      expect(result.stdout).not.toContain("native module not built");
      expect(result.stdout).not.toContain("\x1b[");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("outputs valid JSON with --json and sets exit code 1 when checks fail", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "linkshell-doctor-json-"));
    const doctorUrl = new URL("../src/commands/doctor.ts", import.meta.url).href;
    const loader = createRequire(import.meta.url).resolve("tsx");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import", loader,
          "--input-type=module",
          "--eval",
          `const { runDoctor } = await import(${JSON.stringify(doctorUrl)}); ` +
            `await runDoctor("0.0.0-test", "http://127.0.0.1:1/ws", { json: true });`,
        ],
        { encoding: "utf8", timeout: 15_000, env: { ...process.env, LINKSHELL_HOME: isolatedHome } },
      );
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; version: string; checks: { name: string; ok: boolean }[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.version).toBe("0.0.0-test");
      expect(parsed.checks.some((c) => c.name === "Node.js" && c.ok)).toBe(true);
      expect(parsed.checks.some((c) => c.name === "node:sqlite" && c.ok)).toBe(true);
      expect(parsed.checks.some((c) => c.name === "Permissions")).toBe(true);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it("reports state.db size, WAL bloat, and stale PID/socket/lock diagnostics", () => {
    const home = mkdtempSync(join(tmpdir(), "lsh-doc-state-"));
    const runDir = join(home, "run");
    mkdirSync(runDir, { recursive: true });
    try {
      writeFileSync(join(home, "state.db"), Buffer.alloc(4096));
      writeFileSync(join(home, "state.db-wal"), "");
      truncateSync(join(home, "state.db-wal"), 2 * 1024 * 1024);
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

  it("finds executable binaries on PATH in pure Node without shelling out to `which`", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-path-"));
    try {
      const bin = join(dir, "my-agent");
      writeFileSync(bin, "#!/bin/sh\necho hi\n", { mode: 0o755 });
      const nonExec = join(dir, "not-exec");
      writeFileSync(nonExec, "data", { mode: 0o644 });

      expect(findExecutableInPath("my-agent", { PATH: dir }, "linux")).toBe(bin);
      if (process.platform !== "win32") {
        expect(findExecutableInPath("not-exec", { PATH: dir }, "linux")).toBeUndefined();
      }
      expect(findExecutableInPath("missing-bin", { PATH: dir }, "linux")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("audits 0700 directory and 0600 file permissions for multi-user Linux safety", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-perm-"));
    try {
      chmodSync(dir, 0o755);
      const authFile = join(dir, "auth.json");
      writeFileSync(authFile, "{}\n", { mode: 0o644 });
      chmodSync(authFile, 0o644);

      const bad = auditPermissions(dir, "linux");
      expect(bad.ok).toBe(false);
      expect(bad.detail).toContain("chmod 700");
      expect(bad.detail).toContain("auth.json");
      expect(bad.detail).toContain("chmod 600");

      chmodSync(dir, 0o700);
      chmodSync(authFile, 0o600);
      const good = auditPermissions(dir, "linux");
      expect(good.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inspects host.log size, recent fatal errors, proxy env vars, and logind KillUserProcesses", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-logdoc-"));
    try {
      const log = join(dir, "host.log");
      writeFileSync(log, "2026-01-01 info started\n2026-01-01 [host] uncaught: EADDRINUSE port 7878\n");
      const smallWithErr = inspectHostLog(log, 1024 * 1024);
      expect(smallWithErr?.ok).toBe(true);
      expect(smallWithErr?.detail).toContain("EADDRINUSE");

      const tooBig = inspectHostLog(log, 10);
      expect(tooBig?.ok).toBe(false);
      expect(tooBig?.detail).toContain("exceeds");

      expect(detectProxyEnv({ HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "localhost" })).toEqual(["HTTPS_PROXY"]);
      expect(detectProxyEnv({})).toEqual([]);

      const conf1 = join(dir, "logind.conf");
      const conf2 = join(dir, "override.conf");
      writeFileSync(conf1, "[Login]\n#KillUserProcesses=no\nKillUserProcesses=yes\n");
      expect(inspectLogindKillUserProcesses([conf1])).toBe(true);
      writeFileSync(conf2, "[Login]\nKillUserProcesses=no\n");
      expect(inspectLogindKillUserProcesses([conf1, conf2])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
