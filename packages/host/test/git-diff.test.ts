import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff, gitRevertFile } from "../src/git-diff.js";
import { startHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

const dirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ls-git-diff-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function commitAll(repo: string, msg: string): void {
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=test@linkshell.dev", "-c", "user.name=LinkShell", "commit", "-q", "-m", msg], {
    cwd: repo,
    stdio: "ignore",
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Real git.diff and git.revertFile", { timeout: 15_000 }, () => {
  it("computes working-tree diffs for modified, added, deleted, renamed, untracked, and binary files", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/keep.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(repo, "src/remove.ts"), "goodbye\n");
    writeFileSync(join(repo, "src/old-name.ts"), "same line\n");
    commitAll(repo, "init");

    // Modify tracked file
    writeFileSync(join(repo, "src/keep.ts"), "export const a = 1;\nexport const b = 42;\nexport const c = 3;\n");
    // Delete tracked file
    rmSync(join(repo, "src/remove.ts"));
    // Rename tracked file in index
    execFileSync("git", ["mv", "src/old-name.ts", "src/new-name.ts"], { cwd: repo });
    // Stage a brand-new added file
    writeFileSync(join(repo, "src/added.ts"), "added content\n");
    execFileSync("git", ["add", "src/added.ts"], { cwd: repo });
    // Untracked text file + untracked binary file
    writeFileSync(join(repo, "src/untracked.ts"), "hello untracked\n");
    writeFileSync(join(repo, "src/logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

    const diff = await gitDiff({ cwd: repo });
    expect(diff.branch).toBe("main");
    expect(diff.truncated).toBe(false);

    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    expect(byPath.get("src/keep.ts")).toMatchObject({
      status: "modified",
      oldText: "export const a = 1;\nexport const b = 2;\n",
      newText: "export const a = 1;\nexport const b = 42;\nexport const c = 3;\n",
    });
    expect(byPath.get("src/remove.ts")).toMatchObject({
      status: "deleted",
      oldText: "goodbye\n",
      newText: "",
    });
    expect(byPath.get("src/new-name.ts")).toMatchObject({
      status: "renamed",
      oldPath: "src/old-name.ts",
    });
    expect(byPath.get("src/added.ts")).toMatchObject({
      status: "added",
      oldText: "",
      newText: "added content\n",
    });
    expect(byPath.get("src/untracked.ts")).toMatchObject({
      status: "untracked",
      oldText: "",
      newText: "hello untracked\n",
    });
    expect(byPath.get("src/logo.bin")).toMatchObject({
      status: "untracked",
      binary: true,
      oldText: "",
      newText: "",
    });

    const noUntracked = await gitDiff({ cwd: repo, includeUntracked: false });
    expect(noUntracked.files.some((f) => f.status === "untracked")).toBe(false);
  });

  it("supports base ref diffs and bounds payload size via maxBytes", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "alpha.txt"), "one\n");
    commitAll(repo, "c1");

    writeFileSync(join(repo, "alpha.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "beta.txt"), "x".repeat(4000) + "\n");
    commitAll(repo, "c2");

    const againstPrev = await gitDiff({ cwd: repo, base: "HEAD~1" });
    expect(againstPrev.files.map((f) => f.path)).toEqual(["alpha.txt", "beta.txt"]);

    const bounded = await gitDiff({ cwd: repo, base: "HEAD~1", maxBytes: 500 });
    expect(bounded.truncated).toBe(true);
  });

  it("reverts tracked, staged-new, and untracked files while blocking path traversal and symlink escapes", async () => {
    const repo = tempRepo();
    const outside = mkdtempSync(join(tmpdir(), "ls-git-outside-"));
    dirs.push(outside);
    const secretFile = join(outside, "secret.txt");
    writeFileSync(secretFile, "do not touch");

    writeFileSync(join(repo, "tracked.txt"), "clean\n");
    commitAll(repo, "init");

    writeFileSync(join(repo, "tracked.txt"), "dirty\n");
    writeFileSync(join(repo, "untracked.txt"), "temp\n");
    writeFileSync(join(repo, "staged-new.txt"), "staged\n");
    execFileSync("git", ["add", "staged-new.txt"], { cwd: repo });
    symlinkSync(outside, join(repo, "escape-link"));

    const home = mkdtempSync(join(tmpdir(), "ls-git-host-"));
    dirs.push(home);
    const host = await startHost({ home, version: "test", drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
    const client = await connectHost(host.paths.hostSocket);
    try {
      const rpcDiff = await client.call("git.diff", { cwd: repo });
      expect(rpcDiff.files.some((f) => f.path === "tracked.txt")).toBe(true);

      await expect(client.call("git.revertFile", { cwd: repo, path: "../outside/secret.txt" })).rejects.toThrow();
      await expect(client.call("git.revertFile", { cwd: repo, path: ".git/HEAD" })).rejects.toThrow();
      await expect(client.call("git.revertFile", { cwd: repo, path: "escape-link/secret.txt" })).rejects.toThrow();
      expect(readFileSync(secretFile, "utf8")).toBe("do not touch");

      expect(await client.call("git.revertFile", { cwd: repo, path: "tracked.txt" })).toEqual({ ok: true });
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("clean\n");

      expect(await client.call("git.revertFile", { cwd: repo, path: "untracked.txt" })).toEqual({ ok: true });
      expect(existsSync(join(repo, "untracked.txt"))).toBe(false);

      expect(await gitRevertFile({ cwd: repo, path: "staged-new.txt" })).toEqual({ ok: true });
      expect(existsSync(join(repo, "staged-new.txt"))).toBe(false);
    } finally {
      client.close();
      await host.stop();
    }
  });
});
