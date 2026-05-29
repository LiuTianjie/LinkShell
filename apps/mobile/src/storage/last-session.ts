import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@linkshell/last_session";
const LAST_SESSION_VERSION = 1;

export interface LastSessionRecord {
  gateway: string;
  sessionId: string;
}

interface LastSessionEnvelope {
  version: number;
  record: LastSessionRecord;
}

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function loadLastSession(): Promise<LastSessionRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as
      | LastSessionEnvelope
      | Partial<LastSessionRecord>;
    // Versioned shape.
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      if ((parsed as LastSessionEnvelope).version !== LAST_SESSION_VERSION) {
        return null;
      }
      const record = (parsed as LastSessionEnvelope).record;
      if (!record?.gateway || !record?.sessionId) return null;
      return { gateway: record.gateway, sessionId: record.sessionId };
    }
    // Unversioned legacy shape: discard.
    return null;
  } catch {
    return null;
  }
}

export async function saveLastSession(record: LastSessionRecord): Promise<void> {
  const envelope: LastSessionEnvelope = {
    version: LAST_SESSION_VERSION,
    record,
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
}

export async function clearLastSession(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export async function clearLastSessionIf(
  predicate: (record: LastSessionRecord) => boolean,
): Promise<void> {
  const record = await loadLastSession();
  if (record && predicate(record)) await clearLastSession();
}

export async function clearLastSessionForServerUrl(serverUrl: string): Promise<void> {
  const normalized = normalizeServerUrl(serverUrl);
  await clearLastSessionIf((record) => normalizeServerUrl(record.gateway) === normalized);
}

export async function clearLastSessionForSessionId(sessionId: string): Promise<void> {
  await clearLastSessionIf((record) => record.sessionId === sessionId);
}

export async function clearLastSessionForSessionIdAndServerUrl(
  sessionId: string,
  serverUrl: string,
): Promise<void> {
  const normalized = normalizeServerUrl(serverUrl);
  await clearLastSessionIf((record) =>
    record.sessionId === sessionId &&
    normalizeServerUrl(record.gateway) === normalized
  );
}
