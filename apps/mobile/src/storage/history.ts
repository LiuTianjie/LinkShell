import AsyncStorage from "@react-native-async-storage/async-storage";

export interface ConnectionRecord {
  serverUrl: string;
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

const STORAGE_KEY = "@linkshell/history";
const MAX_RECORDS = 20;

export async function loadHistory(): Promise<ConnectionRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ConnectionRecord[];
  } catch {
    return [];
  }
}

export async function addToHistory(
  record: Omit<ConnectionRecord, "connectedAt">,
): Promise<void> {
  const history = await loadHistory();
  const normalizedServerUrl = record.serverUrl.replace(/\/+$/, "");
  // Same machine reconnecting from a fresh CLI session gets a new sessionId every time.
  // Collapse those into a single row so the recents list doesn't grow unbounded.
  const filtered = history.filter((item) => {
    const sameServer = item.serverUrl.replace(/\/+$/, "") === normalizedServerUrl;
    if (!sameServer) return true;
    if (record.machineId && item.machineId && record.machineId === item.machineId) return false;
    if (item.sessionId === record.sessionId) return false;
    return true;
  });
  filtered.unshift({
    ...record,
    serverUrl: normalizedServerUrl,
    connectedAt: Date.now(),
  });
  if (filtered.length > MAX_RECORDS) filtered.length = MAX_RECORDS;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
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
  const filtered = history.filter((item) => item.sessionId !== sessionId);
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
  const record = history.find((r) => r.sessionId === sessionId);
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
  let next = history;
  if (record.machineId) {
    // Once we know the machineId, fold any older entries that pointed at the same
    // physical device on the same gateway into this single row.
    const normalizedServer = record.serverUrl.replace(/\/+$/, "");
    const deduped = history.filter((item) =>
      item === record ||
      item.machineId !== record.machineId ||
      item.serverUrl.replace(/\/+$/, "") !== normalizedServer,
    );
    if (deduped.length !== history.length) {
      next = deduped;
      changed = true;
    }
  }
  if (changed) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
}
