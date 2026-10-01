import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { RpcError, type GitInfo } from "@linkshell/wire";

// Git worktrees for sessions: a session that shouldn't touch the project's
// working directory gets its own checkout on its own branch, made from the
// project's last commit and kept under the host's home, outside the project.

const run = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** What git says about a directory; undefined when it isn't in a repository (or git is missing). */
export async function gitInfo(path: string): Promise<GitInfo | undefined> {
  try {
    const root = await git(path, ["rev-parse", "--show-toplevel"]);
    const branch = await git(path, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
    const head = await git(path, ["rev-parse", "--short", "HEAD"]).catch(() => "");
    const status = await git(path, ["status", "--porcelain"]);
    return { root, branch: branch || undefined, head: head || undefined, dirty: status.length > 0 };
  } catch {
    return undefined;
  }
}

/**
 * The branch checked out in a directory (the abbreviated commit on a detached
 * HEAD); undefined outside a repository. Doesn't look at the working tree, so
 * it stays quick in a large repository.
 */
export async function gitBranch(path: string): Promise<string | undefined> {
  try {
    const branch = await git(path, ["symbolic-ref", "--short", "-q", "HEAD"], 3000).catch(() => "");
    return branch || (await git(path, ["rev-parse", "--short", "HEAD"], 3000)) || undefined;
  } catch {
    return undefined;
  }
}

export interface CreatedWorktree {
  /** The worktree's top directory. */
  path: string;
  /** Where a session started from `cwd` works: the same place inside the worktree. */
  cwd: string;
  branch: string;
  /** The repository it was made from. */
  source: string;
  /** The commit it started at. */
  base: string;
}

/** Letters, digits and dashes from a title, for a directory and branch name. */
function slug(label: string): string {
  const cleaned = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return cleaned || "session";
}

/**
 * Makes a worktree of the repository `cwd` is in, on a new branch at its
 * current commit. Uncommitted changes stay where they are.
 */
export async function createWorktree(cwd: string, home: string, label: string): Promise<CreatedWorktree> {
  const info = await gitInfo(cwd);
  if (!info) throw RpcError.app("not_a_repo", "这个目录不在 git 仓库里，不能创建 worktree");
  const base = await git(info.root, ["rev-parse", "HEAD"]).catch(() => {
    throw RpcError.app("not_a_repo", "这个仓库还没有提交，不能创建 worktree");
  });
  const name = `${slug(label)}-${randomBytes(3).toString("hex")}`;
  const parent = join(home, "worktrees", basename(info.root));
  mkdirSync(parent, { recursive: true });
  const path = join(parent, name);
  const branch = `linkshell/${name}`;
  try {
    await git(info.root, ["worktree", "add", "-b", branch, path, base]);
  } catch (error) {
    throw RpcError.app("git_failed", `创建 worktree 失败：${error instanceof Error ? error.message.split("\n").slice(-2).join(" ").trim() : String(error)}`);
  }
  return { path, cwd: join(path, relative(info.root, cwd)), branch, source: info.root, base };
}

/** Whether removing the worktree would lose work: uncommitted changes, and commits since it was made. */
export async function worktreeState(path: string, base: string): Promise<{ dirty: boolean; ahead: number }> {
  if (!existsSync(path)) return { dirty: false, ahead: 0 };
  const status = await git(path, ["status", "--porcelain"]).catch(() => "");
  const ahead = Number(await git(path, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "0"));
  return { dirty: status.length > 0, ahead: Number.isFinite(ahead) ? ahead : 0 };
}

/** Removes a worktree and the branch made for it. */
export async function removeWorktree(worktree: { path: string; branch: string; source: string }): Promise<void> {
  if (existsSync(worktree.path)) {
    await git(worktree.source, ["worktree", "remove", "--force", worktree.path]).catch(() => {
      // Not (or no longer) known to git: the directory is all that is left.
      rmSync(worktree.path, { recursive: true, force: true });
    });
  }
  await git(worktree.source, ["worktree", "prune"]).catch(() => {});
  await git(worktree.source, ["branch", "-D", worktree.branch]).catch(() => {});
}
