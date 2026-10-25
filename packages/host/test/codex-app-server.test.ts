import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer, exitReason } from "../src/drivers/codex/app-server.js";

describe("Codex app-server exit reason", () => {
  it("drops colours and puts the error before warnings", () => {
    // What a user's phone showed, with the escape bytes as Codex writes them.
    const stderr =
      "\x1b[2m2026-10-24T22:15:24.376221Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2mcodex_app_server\x1b[0m\x1b[2m:\x1b[0m Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings. user (/Users/someone/.codex/config.toml): `disable_response_storage` is ignored.\n" +
      "Error: app-server control socket is already in use at /private/tmp/codex-daemon-501/5a0e807d\n";
    expect(exitReason(stderr)).toBe("Error: app-server control socket is already in use at /private/tmp/codex-daemon-501/5a0e807d");
  });

  it("falls back to the last line, and to nothing", () => {
    expect(exitReason("\x1b[33mwarming up\x1b[0m\nlistening failed\n")).toBe("listening failed");
    expect(exitReason("")).toBe("");
  });
});

const hasCodex = (() => {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasCodex || process.platform === "win32")("Codex app-server left from an earlier host", () => {
  let dir: string | undefined;
  let server: CodexAppServer | undefined;
  afterEach(async () => {
    await server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is stopped, so the new one can take the control socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "lsx-"));
    const socketPath = join(dir, "codex.sock");
    // An app-server on this host's socket that nobody stops: what a host killed outright leaves.
    const orphan = spawn("codex", ["app-server", "--listen", `unix://${socketPath}`], { stdio: "ignore", detached: true });
    orphan.unref();
    const deadline = Date.now() + 15_000;
    while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(socketPath)).toBe(true);

    const logs: string[] = [];
    server = new CodexAppServer({
      socketPath,
      clientVersion: "test",
      log: (message) => logs.push(message),
      onNotification: () => {},
      onRequest: () => undefined,
      onDown: () => {},
    });
    await server.start();
    expect(logs.some((line) => line.includes(`pid ${orphan.pid}`))).toBe(true);
    expect(orphan.exitCode !== null || orphan.signalCode !== null || !isAlive(orphan.pid!)).toBe(true);
    await expect(server.request("thread/loaded/list", {})).resolves.toBeDefined();
  }, 40_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
