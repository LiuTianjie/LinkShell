import AsyncStorage from "@react-native-async-storage/async-storage";

export interface ConnectionRecord {
  serverUrl: string;
  sessionId: string;
  pairingCode?: string;
  provider?: string;
  hostname?: string;
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
  history.unshift({ ...record, connectedAt: Date.now() });
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

export async function getLastSession(): Promise<ConnectionRecord | undefined> {
  const history = await loadHistory();
  return history[0];
}
