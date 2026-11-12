import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { SessionHub } from "../hub.js";
import { searchDirectories } from "../fs.js";
import { gitInfo } from "../worktrees.js";
import type { LsaCommandResult, LsaHostAdapter, LsaRepoStatus } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Normalizes SSH (`git@github.com:org/repo.git`) and HTTPS (`https://github.com/org/repo.git`)
 * remote URLs into a canonical `host/owner/repo` identifier for cross-machine matching.
 */
export function normalizeGitRemote(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const scpMatch = /^(?:[^@/\s]+@)?([a-zA-Z0-9.-]+):([^\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scpMatch && !trimmed.includes("://")) {
    const host = scpMatch[1]!.toLowerCase();
    const repoPath = scpMatch[2]!.replace(/^\/+|\/+$/g, "");
    return repoPath ? `${host}/${repoPath}` : undefined;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const repoPath = parsed.pathname
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "");
    if (!host || !repoPath) return undefined;
    return `${host}/${repoPath}`;
  } catch {
    return trimmed.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "") || undefined;
  }
}

async function readGitRemoteAndChanges(root: string): Promise<{
  remote?: string;
  changedFiles?: string[];
}> {
  const [remoteOut, porcelainOut] = await Promise.all([
    execFileAsync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      timeout: 5_000,
      windowsHide: true,
    })
      .then((r) => r.stdout.trim())
      .catch(() => ""),
    execFileAsync("git", ["-C", root, "status", "--porcelain"], {
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);
  const changedFiles = porcelainOut
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const remote = normalizeGitRemote(remoteOut);
  return {
    ...(remote ? { remote } : {}),
    changedFiles,
  };
}

export async function runShellCheckCommand(
  command: string,
  cwd: string,
  timeoutMs = 60_000,
): Promise<LsaCommandResult> {
  const isWin = process.platform === "win32";
  const file = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const exitCode = typeof err.code === "number" ? err.code : 1;
    const stdout = err.stdout !== undefined ? String(err.stdout) : "";
    const stderr =
      err.stderr !== undefined ? String(err.stderr) : (err.message ?? String(error));
    return { exitCode, stdout, stderr };
  }
}

export interface HubLsaAdapterOptions {
  machineId?: () => string;
  runCommand?: (command: string, cwd: string, timeoutMs?: number) => Promise<LsaCommandResult>;
}

/**
 * Production `LsaHostAdapter` backed by `SessionHub` and local filesystem/git helpers.
 */
export function createHubLsaAdapter(
  hub: SessionHub,
  options: HubLsaAdapterOptions = {},
): LsaHostAdapter {
  return {
    machineId: options.machineId,
    listProjects: (limit) => hub.listProjects(limit),
    listSessions: (opts) => hub.listSessions(opts ?? {}).sessions,
    getSession: (sessionId) => {
      try {
        return hub.getSession(sessionId);
      } catch {
        return undefined;
      }
    },
    isSessionHijacked: (sessionId) => {
      try {
        const session = hub.getSession(sessionId);
        return session.driver === "desktop";
      } catch {
        return false;
      }
    },
    readSessionEvents: (sessionId, afterSeq = 0) => {
      try {
        const summary = hub.getSession(sessionId);
        if (summary.lastSeq <= afterSeq) return [];
        const page = hub.history(sessionId, summary.lastSeq + 1);
        return page.events.filter((event) => event.seq > afterSeq);
      } catch {
        return [];
      }
    },
    createSession: (input) => hub.createSession(input),
    promptSession: (input) =>
      hub.prompt(input.sessionId, input.clientMessageId, input.content, input.whenBusy),
    cancelSession: (sessionId) => hub.cancel(sessionId),
    searchDirectories: async (query, limit = 40) => {
      const result = await searchDirectories({ query, limit });
      return result.entries;
    },
    gitInfo: async (cwd): Promise<LsaRepoStatus | undefined> => {
      const base = await gitInfo(cwd);
      if (!base) return undefined;
      const extra = await readGitRemoteAndChanges(base.root);
      return {
        root: base.root,
        branch: base.branch,
        head: base.head,
        dirty: base.dirty,
        ...(extra.remote ? { remote: extra.remote } : {}),
        ...(extra.changedFiles ? { changedFiles: extra.changedFiles } : {}),
      };
    },
    fileExists: (filePath) => existsSync(filePath),
    runCommand: options.runCommand ?? runShellCheckCommand,
  };
}
