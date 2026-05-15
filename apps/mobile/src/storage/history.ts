import AsyncStorage from "@react-native-async-storage/async-storage";

export interface ConnectionRecord {
  serverUrl: string;
  hostDeviceId?: string;
  sessionId: string;
  pairingCode?: string;
  provider?: string;
  machineId?: string;
  hostname?: string;
  platform?: string;
  projectName?: string;
  cwd?: string;
  connectedAt: number;
}

const STORAGE_KEY = "@linkshell/device-history:v2";
const LEGACY_STORAGE_KEY = "@linkshell/history";
const MAX_RECORDS = 20;

function normalizeRecord(record: ConnectionRecord): ConnectionRecord {
  const hostDeviceId = record.hostDeviceId ?? record.sessionId;
  return {
    ...record,
    hostDeviceId,
    sessionId: hostDeviceId,
    serverUrl: record.serverUrl.replace(/\/+$/, ""),
  };
}

export async function loadHistory(): Promise<ConnectionRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY) ?? await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ConnectionRecord[];
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed.map(normalizeRecord);
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalized.slice(0, MAX_RECORDS)));
    }
    return normalized;
  } catch {
    return [];
  }
}

export async function addToHistory(
  record: Omit<ConnectionRecord, "connectedAt">,
): Promise<void> {
  const history = await loadHistory();
  history.unshift(normalizeRecord({ ...record, connectedAt: Date.now() }));
  if (history.length > MAX_RECORDS) history.length = MAX_RECORDS;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export async function removeFromHistory(
  target: ConnectionRecord,
): Promise<void> {
  const history = await loadHistory();
  const filtered = history.filter(
    (item) =>
      !(
        item.serverUrl === target.serverUrl &&
        item.sessionId === target.sessionId &&
        item.connectedAt === target.connectedAt
      ),
  );
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export async function removeBySessionId(sessionId: string): Promise<void> {
  const history = await loadHistory();
  const filtered = history.filter((item) => item.sessionId !== sessionId && item.hostDeviceId !== sessionId);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export async function removeByServerUrl(serverUrl: string): Promise<void> {
  const normalized = serverUrl.replace(/\/+$/, "");
  const history = await loadHistory();
  const filtered = history.filter(
    (item) => item.serverUrl.replace(/\/+$/, "") !== normalized,
  );
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export async function getLastSession(): Promise<ConnectionRecord | undefined> {
  const history = await loadHistory();
  return history[0];
}

/** Update the most recent history entry for a session with metadata from the gateway API. */
export async function enrichHistory(
  sessionId: string,
  meta: { hostname?: string; machineId?: string; provider?: string; platform?: string; projectName?: string; cwd?: string },
): Promise<void> {
  const history = await loadHistory();
  const record = history.find((r) => r.sessionId === sessionId || r.hostDeviceId === sessionId);
  if (!record) return;
  let changed = false;
  if (meta.hostname && !record.hostname) {
    record.hostname = meta.hostname;
    changed = true;
  }
  if (meta.machineId && !record.machineId) {
    record.machineId = meta.machineId;
    changed = true;
  }
  if (meta.provider && !record.provider) {
    record.provider = meta.provider;
    changed = true;
  }
  if (meta.platform && !record.platform) {
    record.platform = meta.platform;
    changed = true;
  }
  if (meta.projectName && !record.projectName) {
    record.projectName = meta.projectName;
    changed = true;
  }
  if (meta.cwd && !record.cwd) {
    record.cwd = meta.cwd;
    changed = true;
  }
  if (changed) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }
}
