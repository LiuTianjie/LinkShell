import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The Claude desktop app keeps one record per Code-tab session in
// <userData>/claude-code-sessions/<account>/<profile>/local_<id>.json. Only
// there does it say a session was started by another (start_session, a
// hand-off) or forked from one, or that it is archived; Claude Code itself
// has neither. Read only: the app owns these files and rewrites them as it likes.

/** Where a session came from, as Claude Code session ids (most recent first: an app session changes id when cleared). */
export interface ClaudeLineage {
  /** The session that started this one. */
  parent?: string[];
  /** The session this one was forked from. */
  forkedFrom?: string[];
}

/** Whether the app has the session archived; `at`: when its record last changed, the latest that can have happened. */
export interface ClaudeAppArchive {
  archived: boolean;
  at: number;
}

/** Both builds of the desktop app: "Claude", and "Claude-3p" (third-party providers). Electron's userData under each OS's app data. */
export function claudeAppSessionRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const base = platform === "darwin" ? join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming")
    : env.XDG_CONFIG_HOME || join(home, ".config");
  return ["Claude", "Claude-3p"].map((name) => join(base, name, "claude-code-sessions"));
}

interface AppSession {
  /** The app's own id (`local_…`). */
  id: string;
  /** Its Claude Code session ids: the current one, then earlier ones, newest first. */
  cli: string[];
  archived: boolean;
  relation?: { kind: "parent" | "forkedFrom"; of: string };
}

const string = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The app's own rule for what nests where (its sidebar): a session the user
 * moved to the top level nests nowhere; one a session started (not a fork the
 * user made from it) nests under that session; a fork under its origin.
 */
export function parseAppSession(raw: unknown): AppSession | undefined {
  const data = record(raw);
  const id = string(data?.sessionId);
  const current = string(data?.cliSessionId);
  if (!data || !id || !current) return undefined;
  const prior = Array.isArray(data.priorCliSessionIds) ? data.priorCliSessionIds.map(string).filter((entry): entry is string => !!entry).reverse() : [];
  const session: AppSession = { id, cli: [current, ...prior.filter((entry) => entry !== current)], archived: data.isArchived === true };
  if (data.lineageDetached === true) return session;
  const spawned = record(data.spawnedFrom);
  const spawner = string(spawned?.sessionId) === id ? undefined : string(spawned?.sessionId);
  const forked = string(data.forkedFromSessionId) === id ? undefined : string(data.forkedFromSessionId);
  // A parent deleted in the app hands its children to its own parent and keeps its id here.
  const deletedParent = string(record(spawned?.deletedParent)?.sessionId);
  if (spawner && spawned?.sideSession === true && spawned.userFork !== true && (!forked || forked === spawner || forked === deletedParent)) {
    session.relation = { kind: "parent", of: spawner };
  } else if (forked) {
    session.relation = { kind: "forkedFrom", of: forked };
  } else if (spawner) {
    session.relation = { kind: spawned?.userFork === true ? "forkedFrom" : "parent", of: spawner };
  }
  return session;
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

interface Known {
  lineage?: ClaudeLineage;
  appId: string;
  archive: ClaudeAppArchive;
}

/**
 * The desktop app's sessions, where each came from and whether it is
 * archived, kept in memory: asking never touches the disk, it only starts
 * another look in the background when the last one is older than
 * `minIntervalMs`. Files are read again only when they change; `onChange`
 * hears which Claude Code sessions' lineage or archive state did.
 */
export class ClaudeAppSessions {
  private readonly files = new Map<string, { stamp: string; at: number; session?: AppSession }>();
  private known = new Map<string, Known>();
  private scannedAt = 0;
  private scanning?: Promise<void>;

  constructor(
    private readonly roots: string[],
    private readonly onChange: (cliSessionIds: string[]) => void = () => {},
    private readonly minIntervalMs = 5000,
  ) {}

  lineage(cliSessionId: string): ClaudeLineage | undefined {
    void this.refresh();
    return this.known.get(cliSessionId)?.lineage;
  }

  /** The app's own id (`local_…`) for a Claude Code session it has. */
  appId(cliSessionId: string): string | undefined {
    void this.refresh();
    return this.known.get(cliSessionId)?.appId;
  }

  /** Undefined until the app's records were read, and for a session the app doesn't have. */
  archive(cliSessionId: string): ClaudeAppArchive | undefined {
    void this.refresh();
    return this.known.get(cliSessionId)?.archive;
  }

  refresh(force = false): Promise<void> {
    if (this.scanning) return this.scanning;
    if (!force && Date.now() - this.scannedAt < this.minIntervalMs) return Promise.resolve();
    this.scannedAt = Date.now();
    this.scanning = this.scan().catch(() => {}).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    const deleted = new Set<string>();
    const reads: Promise<void>[] = [];
    for (const root of this.roots) {
      for (const account of await directories(root)) {
        for (const profile of await directories(join(root, account))) {
          const dir = join(root, account, profile);
          let names: string[];
          try { names = await readdir(dir); } catch { continue; }
          for (const name of names) {
            // A tombstone the app leaves for a session it deleted.
            if (name.startsWith("deleted_")) deleted.add(`local_${name.slice("deleted_".length).replace(/\.json$/, "")}`);
            if (!/^local_[\w-]+\.json$/.test(name)) continue;
            const path = join(dir, name);
            seen.add(path);
            reads.push(this.read(path));
          }
        }
      }
    }
    await Promise.all(reads);
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    this.publish(deleted);
  }

  private async read(path: string): Promise<void> {
    try {
      const info = await stat(path);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (this.files.get(path)?.stamp === stamp) return;
      let session: AppSession | undefined;
      try { session = parseAppSession(JSON.parse(await readFile(path, "utf8"))); } catch { /* Half written, or not the app's: skipped until it changes. */ }
      this.files.set(path, { stamp, at: info.mtimeMs, session });
    } catch {
      this.files.delete(path);
    }
  }

  private publish(deleted: Set<string>): void {
    const sessions = new Map<string, AppSession>();
    const changedAt = new Map<string, number>();
    for (const { session, at } of this.files.values()) {
      if (!session || deleted.has(session.id)) continue;
      sessions.set(session.id, session);
      changedAt.set(session.id, at);
    }
    // A Claude Code id belongs to the app session whose current id it is, over one that only used it before.
    const owners = new Map<string, AppSession>();
    for (const pass of [0, 1]) {
      for (const session of sessions.values()) {
        for (const id of pass === 0 ? session.cli.slice(0, 1) : session.cli.slice(1)) if (!owners.has(id)) owners.set(id, session);
      }
    }
    const next = new Map<string, Known>();
    for (const [id, session] of owners) {
      const target = session.relation && sessions.get(session.relation.of);
      const lineage = target && target.id !== session.id ? { [session.relation!.kind]: target.cli } : undefined;
      next.set(id, { ...(lineage ? { lineage } : {}), appId: session.id, archive: { archived: session.archived, at: changedAt.get(session.id) ?? 0 } });
    }
    // A record rewritten for anything else (the app saves often) is no news, nor one first seen that isn't archived or from anywhere.
    const news = (entry?: Known) => JSON.stringify({ lineage: entry?.lineage, archived: entry?.archive.archived === true });
    const changed: string[] = [];
    for (const id of new Set([...this.known.keys(), ...next.keys()])) {
      if (news(this.known.get(id)) !== news(next.get(id))) changed.push(id);
    }
    this.known = next;
    if (changed.length) this.onChange(changed);
  }
}
