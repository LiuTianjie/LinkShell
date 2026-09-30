import { getRandomValues } from "expo-crypto";

// Hermes has no Web Crypto; the end-to-end encryption needs a secure random source.
const target = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof target.crypto?.getRandomValues !== "function") {
  target.crypto = { ...(target.crypto ?? {}), getRandomValues } as typeof target.crypto;
}
