import { createStore } from "zustand/vanilla";
import { projectLocation, userMessageText, type ProjectGroup } from "@linkshell/client-core";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { getDesktopLocale, translateDesktop, type Locale } from "./i18n";
import { DESKTOP_LOCAL, STORAGE_KEYS, readLocal, saveLocal, subscribeStorageReady } from "./storage";

export type ProjectScope = "computer" | "all";

export function sessionNeedsAttention(session: SessionSummary): boolean {
  return (
    session.state === "waiting" ||
    Boolean(session.permission?.questions?.length) ||
    Boolean(session.asyncQuestions?.length)
  );
}

export function waitingLabel(session: SessionSummary, locale: Locale = getDesktopLocale()): string {
  if (session.permission?.questions?.length || session.asyncQuestions?.length) {
    return translateDesktop(locale, "desktop.timeline.waitingAnswer");
  }
  return session.permission
    ? translateDesktop(locale, "desktop.timeline.waitingConfirm")
    : translateDesktop(locale, "desktop.timeline.waitingAction");
}

export function sessionGroup(session: SessionSummary): "waiting" | "running" | "recent" {
  if (sessionNeedsAttention(session)) return "waiting";
  return session.state === "running" ? "running" : "recent";
}

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[\w+-]*/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)?/g, "$1")
    .replace(/!?\[([^\]]*)$/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/`([^`]*)`?/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?/g, " ")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function previewText(raw: string): string {
  let text = userMessageText([{ type: "text", text: raw }]);
  if (/^#\s*Files mentioned by the user:/i.test(text)) {
    text = /##\s*My request:\s*([\s\S]*)$/i.exec(text)?.[1] ?? "";
  }
  return stripMarkdownNoise(text);
}

export function sessionPreview(session: Pick<SessionSummary, "preview" | "activity">): string {
  const activity = session.activity?.title?.trim();
  if (activity) return stripMarkdownNoise(activity);
  return previewText(session.preview ?? "");
}

export function sessionTitle(session: Pick<SessionSummary, "title" | "preview" | "activity">): string {
  const explicit = session.title?.trim();
  if (explicit) return explicit;
  const preview = previewText(session.preview ?? "");
  return preview ? preview.slice(0, 80) : "新会话";
}

const RUNNING_SORT_BUCKET_MS = 60_000;
const ACTIVE_RECENT_WINDOW_MS = 6 * 3_600_000;
const DEFAULT_ACTIVE_RECENT_LIMIT = 6;

export function sessionSortTimestamp(session: SessionSummary): number {
  const raw = session.updatedAt ?? session.createdAt;
  return session.state === "running"
    ? Math.floor(raw / RUNNING_SORT_BUCKET_MS) * RUNNING_SORT_BUCKET_MS
    : raw;
}

export function byRecencyDesc(a: SessionSummary, b: SessionSummary): number {
  return (
    sessionSortTimestamp(b) - sessionSortTimestamp(a) ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id)
  );
}

export function selectActiveSidebarSessions(
  sessions: readonly SessionSummary[],
  now: number = Date.now(),
  recentLimit: number = DEFAULT_ACTIVE_RECENT_LIMIT,
): SessionSummary[] {
  const live = sessions.filter((session) => !session.archived);
  const liveIds = new Set(live.map((session) => session.id));
  const topLevel = live.filter(
    (session) => !(session.parentId && liveIds.has(session.parentId)),
  );
  const waitingTier = topLevel
    .filter((session) => sessionGroup(session) === "waiting")
    .sort(byRecencyDesc);
  const runningTier = topLevel
    .filter((session) => sessionGroup(session) === "running")
    .sort(byRecencyDesc);
  const cutoff = now - ACTIVE_RECENT_WINDOW_MS;
  const recentTier = topLevel
    .filter(
      (session) =>
        sessionGroup(session) === "recent" &&
        (session.updatedAt ?? session.createdAt) >= cutoff,
    )
    .sort(byRecencyDesc)
    .slice(0, Math.max(0, recentLimit));
  return [...waitingTier, ...runningTier, ...recentTier];
}

/** Workspace container folders directly under `$HOME` that never absorb sibling child repos. */
const HOME_CONTAINER_DIRS = new Set([
  "projects",
  "project",
  "code",
  "repos",
  "repositories",
  "dev",
  "developer",
  "work",
  "workspace",
  "workspaces",
  "src",
  "source",
  "github",
  "gitlab",
  "bitbucket",
  "documents",
  "desktop",
  "downloads",
  "sites",
  "www",
]);

/** Ephemeral / sub-run / worktree directory markers that roll up to their enclosing project root. */
const EPHEMERAL_DIR_MARKERS = new Set([
  "runs",
  "run",
  ".worktrees",
  "worktrees",
  ".claude",
  ".codex",
  ".agents",
  "output",
  "outputs",
  "artifacts",
  "evals",
  "benchmarks",
  "logs",
  "tmp",
  "temp",
]);

interface ParsedOsPath {
  kind: "posix" | "win-drive" | "win-unc" | "relative";
  prefix: string;
  sep: "/" | "\\";
  caseInsensitive: boolean;
  segments: string[];
}

function parseOsPath(raw: string): ParsedOsPath {
  const trimmed = raw.trim();
  const winDrive = /^([A-Za-z]:)(?:[\\/]+(.*))?$/.exec(trimmed);
  if (winDrive) {
    const sep: "/" | "\\" = trimmed.includes("\\") ? "\\" : "/";
    const segments = (winDrive[2] ?? "").split(/[\\/]+/).filter(Boolean);
    return {
      kind: "win-drive",
      prefix: winDrive[1]!,
      sep,
      caseInsensitive: true,
      segments,
    };
  }
  const winUnc = /^(\\\\[^\\/]+[\\/][^\\/]+)(?:[\\/]+(.*))?$/.exec(trimmed);
  if (winUnc) {
    const prefix = winUnc[1]!.replace(/[\\/]/g, "\\");
    const segments = (winUnc[2] ?? "").split(/[\\/]+/).filter(Boolean);
    return {
      kind: "win-unc",
      prefix,
      sep: "\\",
      caseInsensitive: true,
      segments,
    };
  }
  if (trimmed.startsWith("/")) {
    return {
      kind: "posix",
      prefix: "",
      sep: "/",
      caseInsensitive: false,
      segments: trimmed.split(/\/+/).filter(Boolean),
    };
  }
  const sep: "/" | "\\" = trimmed.includes("\\") ? "\\" : "/";
  return {
    kind: "relative",
    prefix: "",
    sep,
    caseInsensitive: false,
    segments: trimmed.split(/[\\/]+/).filter(Boolean),
  };
}

function formatParsedPath(parsed: ParsedOsPath, segments: readonly string[]): string {
  if (parsed.kind === "win-drive") {
    return segments.length === 0
      ? `${parsed.prefix}${parsed.sep}`
      : `${parsed.prefix}${parsed.sep}${segments.join(parsed.sep)}`;
  }
  if (parsed.kind === "win-unc") {
    return segments.length === 0
      ? parsed.prefix
      : `${parsed.prefix}\\${segments.join("\\")}`;
  }
  if (parsed.kind === "posix") {
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
  }
  return segments.join(parsed.sep);
}

export function normalizeProjectPathKey(cwd: string): string {
  const parsed = parseOsPath(cwd);
  const canonical = formatParsedPath(parsed, parsed.segments).replace(/\\/g, "/");
  return parsed.caseInsensitive ? canonical.toLowerCase() : canonical;
}

function detectHomeSegmentLength(parsed: ParsedOsPath): number | undefined {
  const { kind, segments } = parsed;
  if (kind === "posix") {
    if ((segments[0] === "Users" || segments[0] === "home") && segments.length >= 2) {
      return 2;
    }
    if (segments[0] === "root") {
      return 1;
    }
    return undefined;
  }
  if (kind === "win-drive") {
    if (segments[0]?.toLowerCase() === "users" && segments.length >= 2) {
      return 2;
    }
  }
  return undefined;
}

function isTwoLevelHomeContainer(first: string, second: string | undefined): boolean {
  if (!second) return false;
  const a = first.toLowerCase();
  const b = second.toLowerCase();
  return (
    (a === "documents" && (b === "github" || b === "projects")) ||
    (a === "developer" && b === "projects") ||
    // Visual Studio's default: %USERPROFILE%\source\repos\<solution>.
    (a === "source" && b === "repos")
  );
}

/** OneDrive moves Desktop and Documents under itself ("OneDrive", "OneDrive - Company"). */
function isCloudHomeSegment(segment: string | undefined): boolean {
  return segment !== undefined && /^onedrive(?:\s*-\s*.+)?$/i.test(segment);
}

/**
 * How many leading segments a project's root has at least: a path is never cut shorter than this,
 * and a directory shorter than this (the home directory, Desktop, a drive's top-level `code`,
 * `/tmp`) never takes the projects below it as its own, even with a session opened in it.
 */
function minimumProjectDepth(parsed: ParsedOsPath): number {
  const { segments } = parsed;
  const homeLen = detectHomeSegmentLength(parsed);
  if (homeLen !== undefined) {
    let at = homeLen;
    if (parsed.kind === "win-drive" && isCloudHomeSegment(segments[at])) at += 1;
    const s1 = segments[at];
    const s2 = segments[at + 1];
    const s3 = segments[at + 2];
    if (s1 === undefined) return at + 1;
    if (parsed.kind === "win-drive" && s1.toLowerCase() === "appdata" && s2?.toLowerCase() === "local" && s3?.toLowerCase() === "temp") return at + 4;
    if (isTwoLevelHomeContainer(s1, s2)) return at + 3;
    if (HOME_CONTAINER_DIRS.has(s1.toLowerCase())) return at + 2;
    return at + 1;
  }
  if (parsed.kind === "posix") {
    if (segments[0] === "tmp") return 2;
    if (segments[0] === "private" && segments[1] === "tmp") return 3;
    if (segments[0] === "var" && segments[1] === "folders") return 6;
    if (segments[0] === "Volumes") return 3;
    return 2;
  }
  if (parsed.kind === "win-drive") {
    const first = segments[0]?.toLowerCase();
    const second = segments[1]?.toLowerCase();
    if (first === "windows" && second === "temp") return 3;
    // D:\code\shop: a top-level folder named like a place for projects is one, not a project.
    if (first !== undefined && (first === "temp" || first === "tmp" || HOME_CONTAINER_DIRS.has(first))) return 2;
    return 1;
  }
  return 1;
}

/**
 * A working directory without what is only a run of the project in it: cut at the first
 * `runs` / `output` / `.claude` / `.worktrees` / dated or numbered folder, to the folder that
 * holds it. (Not to a folder a fixed number of levels below the home directory: that made
 * `OneDrive`, or Visual Studio's `source\repos`, the project of everything inside it.)
 */
function projectBaseSegments(parsed: ParsedOsPath): string[] {
  const { segments } = parsed;
  const floor = minimumProjectDepth(parsed);
  if (segments.length <= floor) return segments;
  let cut = segments.length;
  for (let idx = floor; idx < segments.length; idx++) {
    const seg = segments[idx]!;
    if (isEphemeralMarker(seg) || isShardOrDatedSegment(seg)) { cut = idx; break; }
  }
  const base = segments.slice(0, cut);
  while (base.length > floor) {
    const tail = base[base.length - 1]!;
    if (isEphemeralMarker(tail) || isShardOrDatedSegment(tail) || isNumericShardSegment(tail)) base.pop();
    else break;
  }
  return base;
}

function isEphemeralMarker(segment: string): boolean {
  return EPHEMERAL_DIR_MARKERS.has(segment.toLowerCase());
}

function isShardOrDatedSegment(segment: string): boolean {
  return (
    /^\d{8}[-_]/.test(segment) ||
    /^(?:run|step|shard|batch|task|attempt|trial)[-_]?\d+$/i.test(segment)
  );
}

function isNumericShardSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

export interface ConsolidatedProjectRoot {
  key: string;
  cwd: string;
  name: string;
  generated: boolean;
  /** The directory without its run folders, before any ancestor took it in. */
  candidateRootCwd?: string;
  candidateRootKey?: string;
}

/**
 * The project a working directory is shown under, without mutating any `SessionSummary.cwd`.
 *
 * Two steps, the same on every system and wherever the directory is:
 * 1. Run folders are cut off (`projectBaseSegments`): `shop/runs/20261112-x/03` is `shop`.
 * 2. With `explicitRoots` (every project's and live session's directory after step 1), it goes
 *    to the topmost of its ancestors that is one of them and is deep enough to be a project
 *    (`minimumProjectDepth`): a session in `shop/web` is in `shop` once `shop` has one of its own.
 *
 * Nothing is guessed about where a repository's root is. The host knows that (git) and the
 * summaries do not carry it yet; until they do, a subfolder with no session at its root stays
 * a project of its own.
 */
export function consolidateProjectRoot(
  cwd: string,
  explicitRoots?: ReadonlySet<string>,
): ConsolidatedProjectRoot {
  const location = projectLocation(cwd);
  if (location.generated) {
    return {
      key: `codex-chats:${location.key}`,
      cwd: location.key,
      name: location.name ?? "Codex Chats",
      generated: true,
    };
  }

  const parsed = parseOsPath(cwd);
  if (parsed.segments.length === 0) {
    const rootCwd = formatParsedPath(parsed, parsed.segments) || cwd;
    return { key: rootCwd, cwd: rootCwd, name: rootCwd, generated: false };
  }

  const base = projectBaseSegments(parsed);
  const baseCwd = formatParsedPath(parsed, base);
  let resolved = base;
  if (explicitRoots !== undefined && explicitRoots.size > 0) {
    const floor = minimumProjectDepth(parsed);
    for (let length = Math.max(1, floor); length < base.length; length++) {
      const ancestor = base.slice(0, length);
      if (explicitRoots.has(normalizeProjectPathKey(formatParsedPath(parsed, ancestor)))) { resolved = ancestor; break; }
    }
  }

  const resolvedCwd = formatParsedPath(parsed, resolved);
  return {
    key: resolvedCwd,
    cwd: resolvedCwd,
    name: resolved[resolved.length - 1] || resolvedCwd,
    generated: false,
    candidateRootCwd: baseCwd,
    candidateRootKey: normalizeProjectPathKey(baseCwd),
  };
}

export interface DesktopProjectGroup extends ProjectGroup {
  running: number;
}

export interface DesktopSessionTree {
  active: SessionSummary[];
  groups: DesktopProjectGroup[];
}

export interface DesktopSessionTreeOptions {
  now?: number;
  recentLimit?: number;
}

/**
 * Builds the sidebar's active working set and consolidated project tree.
 * Projects and sessions sort by most recent activity descending (`lastActiveAt` / `updatedAt`),
 * with 1-minute bucketing for streaming `running` sessions so rows never swap mid-turn,
 * and archived session counts subtracted so all-archived projects disappear cleanly.
 */
export function desktopSessionTree(
  projects: ProjectSummary[],
  sessions: SessionSummary[],
  options?: DesktopSessionTreeOptions,
): DesktopSessionTree {
  const live = sessions.filter((session) => !session.archived);

  // Pass 1: every project's and live session's directory, without its run folders. A directory
  // goes to the topmost of these above it (`consolidateProjectRoot`).
  const explicitCandidateRoots = new Set<string>();
  const registerExplicitRoot = (rawCwd: string) => {
    const firstPass = consolidateProjectRoot(rawCwd);
    if (!firstPass.generated && firstPass.candidateRootKey) explicitCandidateRoots.add(firstPass.candidateRootKey);
  };
  for (const project of projects) {
    registerExplicitRoot(project.cwd);
  }
  for (const session of live) {
    registerExplicitRoot(session.worktree?.source ?? session.cwd);
  }

  const archivedCountByGroup = new Map<string, number>();
  for (const session of sessions) {
    if (!session.archived) continue;
    const archivedCwd = session.worktree?.source ?? session.cwd;
    const root = consolidateProjectRoot(archivedCwd, explicitCandidateRoots);
    const mapKey = root.generated ? root.key : normalizeProjectPathKey(root.cwd);
    archivedCountByGroup.set(mapKey, (archivedCountByGroup.get(mapKey) ?? 0) + 1);
  }

  // Pass 2: Consolidate projects and live sessions into unified groups without mutating `session.cwd`.
  interface MutableGroup {
    group: DesktopProjectGroup;
    seenPaths: Set<string>;
    accumulatedProjectSessionCount: number;
    hasExactRootBranch: boolean;
    maxProjectCreatedAt?: number;
    maxProjectLastActiveAt: number;
    maxLiveCreatedAt?: number;
    maxLiveLastActiveAt?: number;
    maxLiveSortTimestamp?: number;
  }

  const byGroupKey = new Map<string, MutableGroup>();

  const ensureGroup = (
    rawCwd: string,
    seed: {
      explicitName?: string;
      branch?: string;
      createdAt?: number;
      lastActiveAt: number;
    },
  ): MutableGroup => {
    const root = consolidateProjectRoot(rawCwd, explicitCandidateRoots);
    const mapKey = root.generated ? root.key : normalizeProjectPathKey(root.cwd);
    const isExactRoot =
      !root.generated &&
      normalizeProjectPathKey(rawCwd) === normalizeProjectPathKey(root.cwd);

    let entry = byGroupKey.get(mapKey);
    if (!entry) {
      const preferredName = root.generated
        ? root.name
        : isExactRoot && seed.explicitName?.trim()
          ? seed.explicitName.trim()
          : root.name;
      entry = {
        group: {
          key: root.key,
          cwd: root.cwd,
          name: preferredName,
          generated: root.generated,
          branch: root.generated ? undefined : seed.branch,
          createdAt: seed.createdAt,
          lastActiveAt: seed.lastActiveAt,
          sessionCount: 0,
          paths: [],
          sessions: [],
          running: 0,
        },
        seenPaths: new Set<string>(),
        accumulatedProjectSessionCount: 0,
        hasExactRootBranch: Boolean(!root.generated && isExactRoot && seed.branch),
        maxProjectLastActiveAt: 0,
      };
      byGroupKey.set(mapKey, entry);
    } else {
      if (isExactRoot && seed.explicitName?.trim()) {
        entry.group.name = seed.explicitName.trim();
      }
      if (!root.generated && seed.branch) {
        if (isExactRoot && !entry.hasExactRootBranch) {
          entry.group.branch = seed.branch;
          entry.hasExactRootBranch = true;
        } else if (!entry.group.branch) {
          entry.group.branch = seed.branch;
        }
      }
      if (seed.createdAt !== undefined) {
        entry.group.createdAt =
          entry.group.createdAt === undefined
            ? seed.createdAt
            : Math.max(entry.group.createdAt, seed.createdAt);
      }
      entry.group.lastActiveAt = Math.max(
        entry.group.lastActiveAt,
        seed.lastActiveAt,
      );
    }
    return entry;
  };

  for (const project of projects) {
    const fallbackUpdated = (project as { updatedAt?: number }).updatedAt;
    const projectLastActive =
      typeof project.lastActiveAt === "number" && Number.isFinite(project.lastActiveAt)
        ? project.lastActiveAt
        : typeof fallbackUpdated === "number" && Number.isFinite(fallbackUpdated)
          ? fallbackUpdated
          : (project.createdAt ?? 0);
    const entry = ensureGroup(project.cwd, {
      explicitName: project.name,
      branch: project.branch,
      createdAt: project.createdAt,
      lastActiveAt: projectLastActive,
    });
    if (project.createdAt !== undefined) {
      entry.maxProjectCreatedAt =
        entry.maxProjectCreatedAt === undefined
          ? project.createdAt
          : Math.max(entry.maxProjectCreatedAt, project.createdAt);
    }
    entry.maxProjectLastActiveAt = Math.max(entry.maxProjectLastActiveAt, projectLastActive);
    const normPath = normalizeProjectPathKey(project.cwd);
    if (!entry.seenPaths.has(normPath)) {
      entry.seenPaths.add(normPath);
      entry.group.paths.push(project.cwd);
      entry.accumulatedProjectSessionCount += Math.max(0, project.sessionCount ?? 0);
    }
  }

  for (const session of live) {
    const projectCwd = session.worktree?.source ?? session.cwd;
    const sessionActiveAt = session.updatedAt ?? session.createdAt;
    const entry = ensureGroup(projectCwd, {
      createdAt: session.createdAt,
      lastActiveAt: sessionActiveAt,
    });
    entry.maxLiveCreatedAt =
      entry.maxLiveCreatedAt === undefined
        ? session.createdAt
        : Math.max(entry.maxLiveCreatedAt, session.createdAt);
    entry.maxLiveLastActiveAt =
      entry.maxLiveLastActiveAt === undefined
        ? sessionActiveAt
        : Math.max(entry.maxLiveLastActiveAt, sessionActiveAt);
    const bucketedSortTs = sessionSortTimestamp(session);
    entry.maxLiveSortTimestamp =
      entry.maxLiveSortTimestamp === undefined
        ? bucketedSortTs
        : Math.max(entry.maxLiveSortTimestamp, bucketedSortTs);
    const normPath = normalizeProjectPathKey(projectCwd);
    if (!entry.seenPaths.has(normPath)) {
      entry.seenPaths.add(normPath);
      entry.group.paths.push(projectCwd);
    }
    entry.group.sessions.push(session);
  }

  const rankedGroups: Array<{ group: DesktopProjectGroup; sortTimestamp: number }> = [];
  for (const [mapKey, entry] of byGroupKey.entries()) {
    const ordered = [...entry.group.sessions].sort(byRecencyDesc);
    const archivedInGroup = archivedCountByGroup.get(mapKey) ?? 0;
    const effectiveProjectCount = Math.max(
      0,
      entry.accumulatedProjectSessionCount - archivedInGroup,
    );
    const totalCount =
      ordered.length > 0
        ? Math.max(effectiveProjectCount, ordered.length)
        : effectiveProjectCount;
    // Rule C: Drop zero-session and all-archived ghost directories.
    if (totalCount === 0 && ordered.length === 0) {
      continue;
    }
    const lastActiveAt =
      ordered.length > 0
        ? (entry.maxLiveLastActiveAt ?? entry.maxProjectLastActiveAt)
        : entry.maxProjectLastActiveAt;
    const createdAt = entry.maxLiveCreatedAt ?? entry.maxProjectCreatedAt;
    const sortTimestamp =
      ordered.length > 0
        ? (entry.maxLiveSortTimestamp ?? lastActiveAt)
        : lastActiveAt;
    rankedGroups.push({
      sortTimestamp,
      group: {
        ...entry.group,
        createdAt,
        lastActiveAt,
        sessions: ordered,
        sessionCount: totalCount,
        running: ordered.filter((session) => sessionGroup(session) === "running").length,
      },
    });
  }

  rankedGroups.sort(
    (a, b) =>
      b.sortTimestamp - a.sortTimestamp ||
      (b.group.createdAt ?? 0) - (a.group.createdAt ?? 0) ||
      a.group.key.localeCompare(b.group.key),
  );

  return {
    active: selectActiveSidebarSessions(live, options?.now, options?.recentLimit),
    groups: rankedGroups.map((item) => item.group),
  };
}

export interface SessionFamily {
  root: SessionSummary;
  children: SessionSummary[];
}

/** Nests forked and subagent child sessions (`parentId ?? forkedFrom`) under their oldest visible ancestor. */
export function sessionFamilies(sessions: SessionSummary[]): SessionFamily[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rootOf = (session: SessionSummary): SessionSummary => {
    const visited = new Set([session.id]);
    let current = session;
    for (;;) {
      const parentKey = current.parentId ?? current.forkedFrom;
      const parent = parentKey ? byId.get(parentKey) : undefined;
      if (!parent || visited.has(parent.id)) return current;
      visited.add(parent.id);
      current = parent;
    }
  };
  const byRoot = new Map<string, SessionFamily>();
  for (const session of sessions) {
    const root = rootOf(session);
    const family = byRoot.get(root.id) ?? { root, children: [] };
    if (session !== root) family.children.push(session);
    byRoot.set(root.id, family);
  }
  for (const family of byRoot.values()) {
    family.children.sort(byRecencyDesc);
  }
  return [...byRoot.values()].sort((a, b) => byRecencyDesc(a.root, b.root));
}

export interface ProjectComputerInput {
  key: string;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
}

export interface CrossComputerProject {
  key: string;
  name: string;
  generated: boolean;
  createdAt: number;
  lastActiveAt: number;
  members: { computerKey: string; project: DesktopProjectGroup }[];
}

/** Groups matching project names across computers while preserving each computer's path and actions. */
export function crossComputerProjects(computers: ProjectComputerInput[]): CrossComputerProject[] {
  const grouped = new Map<string, CrossComputerProject>();
  for (const computer of [...computers].sort((a, b) => a.key.localeCompare(b.key))) {
    for (const project of desktopSessionTree(computer.projects, computer.sessions).groups) {
      const key = JSON.stringify([project.generated, project.name]);
      const group: CrossComputerProject = grouped.get(key) ?? {
        key,
        name: project.name,
        generated: project.generated,
        createdAt: project.createdAt ?? 0,
        lastActiveAt: project.lastActiveAt ?? 0,
        members: [],
      };
      group.createdAt = Math.max(group.createdAt, project.createdAt ?? 0);
      group.lastActiveAt = Math.max(group.lastActiveAt, project.lastActiveAt ?? 0);
      group.members.push({ computerKey: computer.key, project });
      grouped.set(key, group);
    }
  }
  for (const group of grouped.values()) {
    group.members.sort(
      (a, b) => a.computerKey.localeCompare(b.computerKey) || a.project.key.localeCompare(b.project.key),
    );
  }
  return [...grouped.values()].sort(
    (a, b) =>
      b.lastActiveAt - a.lastActiveAt ||
      b.createdAt - a.createdAt ||
      a.key.localeCompare(b.key),
  );
}

export interface ComputerSessionInput {
  key: string;
  isLocal?: boolean;
  online?: boolean;
  loaded?: boolean;
  orderLabel?: string;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
}

export interface ComputerWaitingSession {
  computerKey: string;
  session: SessionSummary;
}

export type ComputerActiveSession = ComputerWaitingSession;

export interface ComputerSessionTree {
  key: string;
  isLocal: boolean;
  online: boolean;
  loaded: boolean;
  syncing: boolean;
  orderLabel?: string;
  tree: DesktopSessionTree;
  groups: DesktopProjectGroup[];
  active: SessionSummary[];
  projectCount: number;
  sessionCount: number;
  runningCount: number;
}

export interface ComputerSessionTreesResult {
  computers: ComputerSessionTree[];
  waiting: ComputerWaitingSession[];
  activeEntries: ComputerActiveSession[];
  totalProjects: number;
  totalSessions: number;
}

/**
 * Builds the 3-level `电脑 → 项目 → 会话` hierarchy for `scope === "all"` (`所有电脑`).
 */
export function computerSessionTrees(
  inputs: readonly ComputerSessionInput[],
  options?: DesktopSessionTreeOptions,
): ComputerSessionTreesResult {
  const now = options?.now ?? Date.now();
  const recentLimit = options?.recentLimit ?? DEFAULT_ACTIVE_RECENT_LIMIT;
  const recentCutoff = now - ACTIVE_RECENT_WINDOW_MS;

  const computers: ComputerSessionTree[] = [];
  const waitingTier: ComputerActiveSession[] = [];
  const runningTier: ComputerActiveSession[] = [];
  const recentTier: ComputerActiveSession[] = [];

  for (const input of inputs) {
    const isLocal = input.isLocal ?? input.key === DESKTOP_LOCAL;
    const online = Boolean(input.online);
    const loaded = Boolean(input.loaded);
    const tree = desktopSessionTree(input.projects, input.sessions, { now, recentLimit });

    const liveSessions = input.sessions.filter((s) => !s.archived);
    const liveIds = new Set(liveSessions.map((s) => s.id));
    for (const session of liveSessions) {
      if (session.parentId && liveIds.has(session.parentId)) continue;
      const grp = sessionGroup(session);
      if (grp === "waiting") {
        waitingTier.push({ computerKey: input.key, session });
      } else if (grp === "running") {
        runningTier.push({ computerKey: input.key, session });
      } else if ((session.updatedAt ?? session.createdAt) >= recentCutoff) {
        recentTier.push({ computerKey: input.key, session });
      }
    }

    const syncing = online && !loaded && tree.groups.length === 0;
    if (tree.groups.length === 0 && !syncing) {
      continue;
    }

    let sessionCount = 0;
    let runningCount = 0;
    for (const group of tree.groups) {
      sessionCount += Math.max(group.sessionCount, group.sessions.length);
      runningCount += group.running;
    }

    computers.push({
      key: input.key,
      isLocal,
      online,
      loaded,
      syncing,
      orderLabel: input.orderLabel,
      tree,
      groups: tree.groups,
      active: tree.active,
      projectCount: tree.groups.length,
      sessionCount,
      runningCount,
    });
  }

  computers.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    const labelA = a.orderLabel ?? a.key;
    const labelB = b.orderLabel ?? b.key;
    return labelA.localeCompare(labelB) || a.key.localeCompare(b.key);
  });

  const compareCrossComputerActive = (a: ComputerActiveSession, b: ComputerActiveSession): number =>
    byRecencyDesc(a.session, b.session) || a.computerKey.localeCompare(b.computerKey);

  waitingTier.sort(compareCrossComputerActive);
  runningTier.sort(compareCrossComputerActive);
  recentTier.sort(compareCrossComputerActive);

  const activeEntries: ComputerActiveSession[] = [
    ...waitingTier,
    ...runningTier,
    ...recentTier.slice(0, Math.max(0, recentLimit)),
  ];

  let totalProjects = 0;
  let totalSessions = 0;
  for (const comp of computers) {
    totalProjects += comp.projectCount;
    totalSessions += comp.sessionCount;
  }

  return {
    computers,
    waiting: waitingTier,
    activeEntries,
    totalProjects,
    totalSessions,
  };
}

function normalizeScope(value: unknown): ProjectScope {
  if (value === "all") return "all";
  return "computer";
}

export const projectScopeStore = createStore<{ scope: ProjectScope }>(() => ({
  scope: normalizeScope(readLocal<string>(STORAGE_KEYS.projectScope, "computer")),
}));

subscribeStorageReady(() => {
  projectScopeStore.setState({
    scope: normalizeScope(readLocal<string>(STORAGE_KEYS.projectScope, "computer")),
  });
});

export function setProjectScope(scope: ProjectScope): void {
  saveLocal(STORAGE_KEYS.projectScope, scope);
  projectScopeStore.setState({ scope });
}
