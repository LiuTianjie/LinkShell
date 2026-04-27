import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadHistory } from "./history";

export interface ProjectRecord {
  id: string;
  serverUrl: string;
  sessionId: string;
  cwd: string;
  projectName?: string;
  hostname?: string;
  platform?: string;
  provider?: string;
  lastTerminalId?: string;
  lastOpenedAt: number;
  createdAt: number;
  schemaVersion: 1;
}

export type ProjectRecordInput = Omit<
  ProjectRecord,
  "id" | "lastOpenedAt" | "createdAt" | "schemaVersion"
> &
  Partial<Pick<ProjectRecord, "lastOpenedAt" | "createdAt">>;

const STORAGE_KEY = "@linkshell/projects:v1";
const MAX_RECORDS = 50;

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

function normalizeCwd(cwd: string): string {
  return cwd.trim();
}

export function makeProjectId(
  serverUrl: string,
  sessionId: string,
  cwd: string,
): string {
  return [
    normalizeServerUrl(serverUrl),
    sessionId,
    normalizeCwd(cwd),
  ]
    .map(encodeURIComponent)
    .join(":");
}

function sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

async function saveProjects(projects: ProjectRecord[]): Promise<void> {
  const sorted = sortProjects(projects).slice(0, MAX_RECORDS);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
}

async function migrateProjectsFromHistory(): Promise<ProjectRecord[]> {
  const history = await loadHistory();
  const projects = new Map<string, ProjectRecord>();

  for (const record of history) {
    const cwd = normalizeCwd(record.cwd ?? "");
    if (!cwd) continue;

    const serverUrl = normalizeServerUrl(record.serverUrl);
    const id = makeProjectId(serverUrl, record.sessionId, cwd);
    if (projects.has(id)) continue;

    projects.set(id, {
      id,
      serverUrl,
      sessionId: record.sessionId,
      cwd,
      projectName: record.projectName,
      hostname: record.hostname,
      platform: record.platform,
      provider: record.provider,
      lastOpenedAt: record.connectedAt,
      createdAt: record.connectedAt,
      schemaVersion: 1,
    });
  }

  const migrated = sortProjects([...projects.values()]).slice(0, MAX_RECORDS);
  await saveProjects(migrated);
  return migrated;
}

export async function loadProjects(): Promise<ProjectRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateProjectsFromHistory();
    const parsed = JSON.parse(raw) as ProjectRecord[];
    if (!Array.isArray(parsed)) return [];
    return sortProjects(
      parsed.filter((item) => item.serverUrl && item.sessionId && item.cwd),
    );
  } catch {
    return [];
  }
}

export async function upsertProject(
  input: ProjectRecordInput,
): Promise<ProjectRecord | null> {
  const cwd = normalizeCwd(input.cwd);
  if (!cwd) return null;

  const now = Date.now();
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const id = makeProjectId(serverUrl, input.sessionId, cwd);
  const projects = await loadProjects();
  const existingIndex = projects.findIndex((item) => item.id === id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : undefined;

  const next: ProjectRecord = {
    id,
    serverUrl,
    sessionId: input.sessionId,
    cwd,
    projectName: input.projectName ?? existing?.projectName,
    hostname: input.hostname ?? existing?.hostname,
    platform: input.platform ?? existing?.platform,
    provider: input.provider ?? existing?.provider,
    lastTerminalId: input.lastTerminalId ?? existing?.lastTerminalId,
    lastOpenedAt: input.lastOpenedAt ?? existing?.lastOpenedAt ?? now,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    schemaVersion: 1,
  };

  if (existingIndex >= 0) {
    projects[existingIndex] = next;
  } else {
    projects.unshift(next);
  }
  await saveProjects(projects);
  return next;
}

export async function touchProject(input: {
  serverUrl: string;
  sessionId: string;
  cwd: string;
  lastTerminalId?: string;
}): Promise<void> {
  await upsertProject({
    serverUrl: input.serverUrl,
    sessionId: input.sessionId,
    cwd: input.cwd,
    lastTerminalId: input.lastTerminalId,
    lastOpenedAt: Date.now(),
  });
}

export async function removeProjectsBySessionId(
  sessionId: string,
): Promise<void> {
  const projects = await loadProjects();
  await saveProjects(projects.filter((item) => item.sessionId !== sessionId));
}

export async function removeProjectsByServerUrl(
  serverUrl: string,
): Promise<void> {
  const normalized = normalizeServerUrl(serverUrl);
  const projects = await loadProjects();
  await saveProjects(
    projects.filter((item) => normalizeServerUrl(item.serverUrl) !== normalized),
  );
}

export async function clearProjects(): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([]));
}
