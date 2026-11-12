import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { listProjectFiles } from "../src/fs.js";
import { MdnsAdvertiser, buildMdnsCommand, hostFingerprint } from "../src/mdns.js";
import { readClipboard, writeClipboard } from "../src/clipboard.js";
import { LiveActivityRelay } from "../src/live-activities.js";
import { startHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";
import type { SessionSummary, WakeupNotice } from "@linkshell/wire";

const dirs: string[] = [];
function tempDir(prefix = "ls-features-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fs.projectFiles fast @file discovery & fuzzy ranking", () => {
  it("lists tracked + untracked files via git ls-files (ignoring gitignored files) and ranks fuzzy @file queries", async () => {
    const repo = tempDir("ls-proj-git-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "packages/host/src/drivers/codex"), { recursive: true });
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    writeFileSync(join(repo, "packages/host/src/drivers/codex/driver.ts"), "export {};\n");
    writeFileSync(join(repo, "packages/host/src/store.ts"), "export {};\n");
    writeFileSync(join(repo, "dist/ignored.js"), "ignored\n");
    execFileSync("git", ["add", ".gitignore", "packages/host/src/store.ts"], { cwd: repo });

    const all = await listProjectFiles({ cwd: repo });
    expect(all.truncated).toBe(false);
    expect(all.files.map((f) => f.relativePath)).toContain("packages/host/src/store.ts");
    expect(all.files.map((f) => f.relativePath)).toContain("packages/host/src/drivers/codex/driver.ts");
    expect(all.files.map((f) => f.relativePath)).not.toContain("dist/ignored.js");

    const queried = await listProjectFiles({ cwd: repo, query: "codex/driver" });
    expect(queried.files[0]?.relativePath).toBe("packages/host/src/drivers/codex/driver.ts");
  });

  it("falls back to bounded directory walk outside git repositories", async () => {
    const folder = tempDir("ls-proj-walk-");
    mkdirSync(join(folder, "src/components"), { recursive: true });
    mkdirSync(join(folder, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(folder, "src/components/Composer.tsx"), "export {};\n");
    writeFileSync(join(folder, "node_modules/pkg/index.js"), "module.exports = {};\n");

    const res = await listProjectFiles({ cwd: folder, query: "composer" });
    expect(res.files.map((f) => f.relativePath)).toEqual(["src/components/Composer.tsx"]);
  });
});

describe("LAN mDNS / Bonjour _linkshell._tcp discovery", () => {
  it("builds privacy-preserving TXT records (never exposing username or paths) and tears down child cleanly", async () => {
    const home = tempDir("ls-mdns-");
    const fp = hostFingerprint(home, "machine-abc-123");
    const darwinSpec = buildMdnsCommand({
      port: 7878,
      machineId: "machine-abc-123",
      fingerprint: fp,
      protocolVersion: 4,
      platform: "darwin",
    });
    expect(darwinSpec?.command).toBe("/usr/bin/dns-sd");
    expect(darwinSpec?.args).toEqual([
      "-R",
      `linkshell-${fp.slice(0, 8)}`,
      "_linkshell._tcp",
      "local",
      "7878",
      "v=4",
      "mid=machine-abc-123",
      `fp=${fp}`,
    ]);
    const joined = darwinSpec!.args.join(" ");
    expect(joined).not.toContain(homedir());
    expect(joined).not.toContain(userInfo().username);

    const linuxSpec = buildMdnsCommand({
      port: 7878,
      machineId: "machine-abc-123",
      fingerprint: fp,
      protocolVersion: 4,
      platform: "linux",
    });
    expect(linuxSpec?.command).toBe("avahi-publish-service");

    let killedWith: string | undefined;
    const fakeChild = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      unref: () => {},
      kill(signal?: string) {
        killedWith = signal;
        this.killed = true;
        this.exitCode = 0;
        this.emit("exit", 0);
        return true;
      },
    }) as unknown as ChildProcess;

    const advertiser = new MdnsAdvertiser({
      port: 7878,
      machineId: "machine-abc-123",
      fingerprint: fp,
      protocolVersion: 4,
      platform: "darwin",
      spawnProcess: () => fakeChild,
    });
    expect(advertiser.start()).toBe(true);
    expect(advertiser.active).toBe(true);
    await advertiser.stop();
    expect(killedWith).toBe("SIGTERM");
    expect(advertiser.active).toBe(false);
  });
});

describe("Clipboard, Screen Privacy, LSA RPC wiring & Push-to-Start Zero-Plaintext Wakeup", () => {
  it("handles clipboard read/write with injected runner across platforms", async () => {
    let clipboardBuf = "initial";
    const run = vi.fn(async (_cmd: string, _args: string[], stdinText?: string) => {
      if (stdinText !== undefined) {
        clipboardBuf = stdinText;
        return { stdout: "" };
      }
      return { stdout: clipboardBuf };
    });

    await expect(writeClipboard("OTP-654321", { platform: "darwin", runCommand: run })).resolves.toEqual({ ok: true });
    await expect(readClipboard({ platform: "darwin", runCommand: run })).resolves.toEqual({ text: "OTP-654321" });
    await expect(writeClipboard("linux-clip", { platform: "linux", runCommand: run })).resolves.toEqual({ ok: true });
    await expect(writeClipboard("win-clip", { platform: "win32", runCommand: run })).resolves.toEqual({ ok: true });
  });

  it("wires screen.privacy, fs.projectFiles, and lsa.status through HostRpcServer", async () => {
    const home = tempDir("ls-rpc-all-");
    writeFileSync(join(home, "hello.ts"), "export const x = 1;\n");
    const host = await startHost({ home, version: "test", drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
    const client = await connectHost(host.paths.hostSocket);
    try {
      const privacy0 = await client.call("screen.privacy", {});
      expect(privacy0).toEqual({ curtain: false, lockOnDisconnect: false, supported: true });

      const privacy1 = await client.call("screen.privacy", { curtain: true, lockOnDisconnect: true });
      expect(privacy1).toEqual({ curtain: true, lockOnDisconnect: true, supported: true });

      const proj = await client.call("fs.projectFiles", { cwd: home, query: "hello" });
      expect(proj.files.some((f) => f.relativePath === "hello.ts")).toBe(true);

      const lsaStatus = await client.call("lsa.status", {});
      expect(lsaStatus.enabled).toBe(true);
      expect(lsaStatus.requiresYearlyTier).toBe(true);
    } finally {
      client.close();
      await host.stop();
    }
  });

  it("delivers zero-plaintext ActivityKit push-to-start & wakeup notices only when no foreground activityId exists", async () => {
    const dir = tempDir("ls-pts-");
    const livePath = join(dir, "live-activities.json");
    let summaryListener: ((s: SessionSummary) => void) | undefined;
    const sessions: SessionSummary[] = [];
    const wakeups: WakeupNotice[] = [];
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    const relay = new LiveActivityRelay({
      path: livePath,
      hub: {
        listSessions: () => ({ sessions }),
        subscribe: async () => ({ session: sessions[0]!, startSeq: 0 }),
        unsubscribe: () => {},
        onSummary: (fn) => {
          summaryListener = fn;
          return () => {};
        },
        onRemoved: () => () => {},
      },
      terminals: { list: () => [], onChange: () => () => {} },
      computerName: () => "MacBook Pro",
      machineId: () => "machine-xyz",
      onWakeup: (notice) => wakeups.push(notice),
      serviceUrl: "https://push.itool.tech",
      request: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      log: () => {},
    });

    relay.start();
    try {
      const grant = "a".repeat(64);
      expect(
        relay.registerPushToStart({
          deviceId: "iphone-16",
          pushToStartToken: "apns-pts-token-123",
          platform: "ios",
          serviceUrl: "https://push.itool.tech",
          grant,
          expiresAt: Date.now() + 3_600_000,
          computerKey: "comp-1",
        }),
      ).toEqual({ ok: true });

      const secretCwd = "/Users/secretuser/super-private-repo";
      const waitingSession: SessionSummary = {
        id: "codex:sess-42",
        agent: "codex",
        nativeId: "sess-42",
        title: "Fix ultra secret auth token leak",
        preview: "const SECRET_KEY = 'sk-live-123';",
        cwd: secretCwd,
        state: "waiting",
        pendingPermissions: 1,
        permission: {
          requestId: "perm-1",
          title: "Run rm -rf /Users/secretuser",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        createdAt: 1000,
        updatedAt: 2000,
        lastSeq: 5,
        archived: false,
      };
      sessions.push(waitingSession);
      summaryListener?.(waitingSession);
      await relay.flush();

      // Wakeup notice and /v1/activities/start payload contain ZERO plaintext paths, titles, or code!
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]).toMatchObject({
        machineId: "machine-xyz",
        sessionId: "codex:sess-42",
        eventType: "approval",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://push.itool.tech/v1/activities/start");
      const rawPayload = JSON.stringify(requests[0]?.body);
      expect(rawPayload).not.toContain("secretuser");
      expect(rawPayload).not.toContain("super-private-repo");
      expect(rawPayload).not.toContain("SECRET_KEY");
      expect(rawPayload).not.toContain("ultra secret");
      expect(requests[0]?.body.wakeup).toMatchObject({
        machineId: "machine-xyz",
        sessionId: "codex:sess-42",
        eventType: "approval",
      });

      // Once a foreground activityId is subscribed for comp-1, push-to-start is suppressed.
      relay.subscribe({
        activityId: "act-foreground-1",
        serviceUrl: "https://push.itool.tech",
        grant,
        expiresAt: Date.now() + 3_600_000,
        computerKey: "comp-1",
      });
      // Foreground live-activities.json stays a pure array of foreground subscriptions.
      expect(Array.isArray(JSON.parse(readFileSync(livePath, "utf8")))).toBe(true);

      requests.length = 0;
      const erroredSession: SessionSummary = {
        ...waitingSession,
        state: "error",
        pendingPermissions: 0,
        permission: undefined,
        updatedAt: 3000,
      };
      sessions[0] = erroredSession;
      summaryListener?.(erroredSession);
      await relay.flush();

      expect(requests.some((r) => r.url.endsWith("/v1/activities/start"))).toBe(false);
      expect(requests.some((r) => r.url.endsWith("/v1/activities/act-foreground-1/events"))).toBe(true);
    } finally {
      relay.stop();
    }
  });
});
