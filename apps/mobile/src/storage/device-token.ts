import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@linkshell/device_token";

let cached: string | null = null;

export async function getDeviceToken(): Promise<string | null> {
  if (cached) return cached;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) cached = raw;
    return raw;
  } catch {
    return null;
  }
}

export async function setDeviceToken(token: string): Promise<void> {
  cached = token;
  await AsyncStorage.setItem(STORAGE_KEY, token);
}

export async function ensureDeviceToken(): Promise<string> {
  const existing = await getDeviceToken();
  if (existing) return existing;
  const token = generateToken();
  await setDeviceToken(token);
  return token;
}

function generateToken(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
