import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

// Legacy plaintext AsyncStorage key (migrated out on first read).
const LEGACY_STORAGE_KEY = "@linkshell/device_token";
// SecureStore key (Keychain/Keystore) — only [A-Za-z0-9._-] allowed.
const SECURE_KEY = "linkshell_device_token";

let cached: string | null = null;

export async function getDeviceToken(): Promise<string | null> {
  if (cached) return cached;
  try {
    const secure = await SecureStore.getItemAsync(SECURE_KEY);
    if (secure) {
      cached = secure;
      return secure;
    }
    // One-time migration from legacy plaintext AsyncStorage.
    const legacy = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      cached = legacy;
      await SecureStore.setItemAsync(SECURE_KEY, legacy);
      await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setDeviceToken(token: string): Promise<void> {
  cached = token;
  await SecureStore.setItemAsync(SECURE_KEY, token);
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
