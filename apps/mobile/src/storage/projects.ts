import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadHistory } from "./history";

export interface ProjectRecord {
  id: string;
  serverUrl: string;
  hostDeviceId: string;
  sessionId: string;
  machineId?: string;
  cwd: string;
  projectName?: string;
  hostname?: string;
  platform?: string;
  provider?: string;
  lastTerminalId?: string;
  lastOpenedAt: number;
  createdAt: number;
  schemaVersion: 2;
}

export type ProjectRecordInput = Omit<
  ProjectRecord,
  "id" | "hostDeviceId" | "lastOpenedAt" | "createdAt" | "schemaVersion"
> & {
  hostDeviceId?: string;
} &
  Partial<Pick<ProjectRecord, "lastOpenedAt" | "createdAt">>;

const STORAGE_KEY = "@linkshell/projects:v2";
const LEGACY_STORAGE_KEY = "@linkshell/projects:v1";
const MAX_RECORDS = 50;

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

function normalizeCwd(cwd: string): string {
  return cwd.trim();
}

export function makeProjectId(
  serverUrl: string,
  machineIdOrSessionId: string,
  cwd: string,
): string {
  return [
    normalizeServerUrl(serverUrl),
    machineIdOrSessionId,
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
    const hostDeviceId = record.hostDeviceId ?? record.sessionId;
    const id = makeProjectId(serverUrl, hostDeviceId, cwd);
    if (projects.has(id)) continue;

    projects.set(id, {
      id,
      serverUrl,
      hostDeviceId,
      sessionId: hostDeviceId,
      machineId: record.machineId,
      cwd,
      projectName: record.projectName,
      hostname: record.hostname,
      platform: record.platform,
      provider: record.provider,
      lastOpenedAt: record.connectedAt,
      createdAt: record.connectedAt,
      schemaVersion: 2,
    });
  }

  const migrated = sortProjects([...projects.values()]).slice(0, MAX_RECORDS);
  await saveProjects(migrated);
  return migrated;
}

export async function loadProjects(): Promise<ProjectRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY) ?? await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return migrateProjectsFromHistory();
    const parsed = JSON.parse(raw) as (ProjectRecord & { hostDeviceId?: string; schemaVersion?: number })[];
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .filter((item) => item.serverUrl && (item.hostDeviceId || item.sessionId) && item.cwd)
      .map((item) => {
        const serverUrl = normalizeServerUrl(item.serverUrl);
        const hostDeviceId = item.hostDeviceId ?? item.sessionId;
        const id = makeProjectId(serverUrl, hostDeviceId, item.cwd);
        return {
          ...item,
          id,
          serverUrl,
          hostDeviceId,
          sessionId: hostDeviceId,
          schemaVersion: 2 as const,
        };
      });
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
      await saveProjects(normalized);
    }
    return sortProjects(normalized);
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
  const hostDeviceId = input.hostDeviceId ?? input.sessionId;
  const id = makeProjectId(serverUrl, hostDeviceId, cwd);
  const projects = await loadProjects();
  const existingIndex = projects.findIndex((item) =>
    item.id === id ||
    (
      normalizeServerUrl(item.serverUrl) === serverUrl &&
      item.cwd === cwd &&
      (
        item.hostDeviceId === hostDeviceId ||
        item.sessionId === input.sessionId ||
        (Boolean(input.machineId) && item.machineId === input.machineId) ||
        (Boolean(input.hostname) && item.hostname === input.hostname)
      )
    )
  );
  const existing = existingIndex >= 0 ? projects[existingIndex] : undefined;

  const next: ProjectRecord = {
    id,
    serverUrl,
    hostDeviceId,
    sessionId: hostDeviceId,
    machineId: input.machineId ?? existing?.machineId,
    cwd,
    projectName: input.projectName ?? existing?.projectName,
    hostname: input.hostname ?? existing?.hostname,
    platform: input.platform ?? existing?.platform,
    provider: input.provider ?? existing?.provider,
    lastTerminalId: input.lastTerminalId ?? existing?.lastTerminalId,
    lastOpenedAt: input.lastOpenedAt ?? existing?.lastOpenedAt ?? now,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    schemaVersion: 2,
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
  hostDeviceId?: string;
  sessionId: string;
  machineId?: string;
  cwd: string;
  lastTerminalId?: string;
}): Promise<void> {
  await upsertProject({
    serverUrl: input.serverUrl,
    hostDeviceId: input.hostDeviceId,
    sessionId: input.sessionId,
    machineId: input.machineId,
    cwd: input.cwd,
    lastTerminalId: input.lastTerminalId,
    lastOpenedAt: Date.now(),
  });
}

export async function removeProjectsBySessionId(
  sessionId: string,
): Promise<void> {
  const projects = await loadProjects();
  await saveProjects(projects.filter((item) => item.sessionId !== sessionId && item.hostDeviceId !== sessionId));
}

export async function removeProject(id: string): Promise<void> {
  const projects = await loadProjects();
  await saveProjects(projects.filter((item) => item.id !== id));
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
