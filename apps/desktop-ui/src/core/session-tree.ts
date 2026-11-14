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
    (a === "developer" && b === "projects")
  );
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
  candidateRootCwd?: string;
  candidateRootKey?: string;
}

/**
 * Consolidates ephemeral run directories, numeric/dated shards, worktrees, and explicit repo
 * descendants into a single logical project root without mutating any `SessionSummary.cwd`.
 */
export function consolidateProjectRoot(
  cwd: string,
  explicitCandidateRoots?: ReadonlySet<string>,
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
  const { segments } = parsed;
  if (segments.length === 0) {
    const rootCwd = formatParsedPath(parsed, segments) || cwd;
    return {
      key: rootCwd,
      cwd: rootCwd,
      name: rootCwd,
      generated: false,
    };
  }

  const homeLen = detectHomeSegmentLength(parsed);
  let repoRootLen: number | undefined;
  let minNonAbsorbingLen: number | undefined;

  if (homeLen !== undefined) {
    if (segments.length > homeLen) {
      const s1 = segments[homeLen]!;
      const s2 = segments[homeLen + 1];
      const s3 = segments[homeLen + 2];
      if (
        parsed.kind === "win-drive" &&
        s1.toLowerCase() === "appdata" &&
        s2?.toLowerCase() === "local" &&
        s3?.toLowerCase() === "temp"
      ) {
        if (segments.length > homeLen + 3) {
          repoRootLen = homeLen + 4;
        }
      } else if (isTwoLevelHomeContainer(s1, s2)) {
        if (segments.length > homeLen + 2) {
          repoRootLen = homeLen + 3;
        }
      } else if (HOME_CONTAINER_DIRS.has(s1.toLowerCase())) {
        if (segments.length > homeLen + 1) {
          repoRootLen = homeLen + 2;
        }
      } else {
        repoRootLen = homeLen + 1;
      }
    }
  } else if (parsed.kind === "posix") {
    if (segments[0] === "tmp") {
      minNonAbsorbingLen = 2;
    } else if (segments[0] === "private" && segments[1] === "tmp") {
      minNonAbsorbingLen = 3;
    } else if (segments[0] === "var" && segments[1] === "folders") {
      minNonAbsorbingLen = 6;
    } else if (segments[0] === "Volumes") {
      minNonAbsorbingLen = 3;
    } else {
      minNonAbsorbingLen = 2;
    }
  } else if (parsed.kind === "win-drive") {
    const first = segments[0]?.toLowerCase();
    const second = segments[1]?.toLowerCase();
    if (first === "temp") {
      minNonAbsorbingLen = 2;
    } else if (first === "windows" && second === "temp") {
      minNonAbsorbingLen = 3;
    } else {
      minNonAbsorbingLen = 2;
    }
  }

  let resolvedSegments = segments;
  let candidateRootCwd: string | undefined;
  let candidateRootKey: string | undefined;

  if (repoRootLen !== undefined && segments.length >= repoRootLen) {
    const candidateSegs = segments.slice(0, repoRootLen);
    candidateRootCwd = formatParsedPath(parsed, candidateSegs);
    candidateRootKey = normalizeProjectPathKey(candidateRootCwd);

    if (segments.length > repoRootLen) {
      const leaf = segments[segments.length - 1]!;
      let matchesRuleA =
        isNumericShardSegment(leaf) || isShardOrDatedSegment(leaf);

      if (!matchesRuleA) {
        for (let idx = repoRootLen; idx < segments.length; idx++) {
          const seg = segments[idx]!;
          if (isEphemeralMarker(seg) || isShardOrDatedSegment(seg)) {
            matchesRuleA = true;
            break;
          }
        }
      }

      const matchesRuleB =
        !matchesRuleA &&
        explicitCandidateRoots !== undefined &&
        explicitCandidateRoots.size > 0 &&
        (explicitCandidateRoots.has(candidateRootKey) ||
          explicitCandidateRoots.has(candidateRootCwd));

      if (matchesRuleA || matchesRuleB) {
        resolvedSegments = candidateSegs;
      }
    }
  } else if (
    minNonAbsorbingLen !== undefined &&
    segments.length > minNonAbsorbingLen
  ) {
    let cutIndex = segments.length;
    for (let idx = minNonAbsorbingLen; idx < segments.length; idx++) {
      const seg = segments[idx]!;
      if (isEphemeralMarker(seg) || isShardOrDatedSegment(seg)) {
        cutIndex = idx;
        break;
      }
    }
    const next = segments.slice(0, cutIndex);
    while (next.length > minNonAbsorbingLen) {
      const tail = next[next.length - 1]!;
      if (
        isEphemeralMarker(tail) ||
        isShardOrDatedSegment(tail) ||
        isNumericShardSegment(tail)
      ) {
        next.pop();
      } else {
        break;
      }
    }
    resolvedSegments = next;
  }

  const resolvedCwd = formatParsedPath(parsed, resolvedSegments);
  const resolvedName =
    resolvedSegments[resolvedSegments.length - 1] || resolvedCwd;

  return {
    key: resolvedCwd,
    cwd: resolvedCwd,
    name: resolvedName,
    generated: false,
    candidateRootCwd,
    candidateRootKey,
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

  // Pass 1: Collect Candidate Repo Roots explicitly present in inputs or derived via Rule A.
  const explicitCandidateRoots = new Set<string>();
  const registerExplicitRoot = (rawCwd: string) => {
    const firstPass = consolidateProjectRoot(rawCwd);
    if (
      !firstPass.generated &&
      firstPass.candidateRootKey &&
      normalizeProjectPathKey(firstPass.cwd) === firstPass.candidateRootKey
    ) {
      explicitCandidateRoots.add(firstPass.candidateRootKey);
    }
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
