import * as SecureStore from "expo-secure-store";

// Secrets (device keys, account tokens) live in the Keychain / Keystore, only on this device.

const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export function readSecret<T>(key: string): T | undefined {
  try {
    const raw = SecureStore.getItem(key, options);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeSecret(key: string, value: unknown): void {
  SecureStore.setItem(key, JSON.stringify(value), options);
}

export async function deleteSecret(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, options).catch(() => {});
}
