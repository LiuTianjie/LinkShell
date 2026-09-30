import { createIdentity, type Identity } from "@linkshell/wire";
import { readSecret, writeSecret } from "./secure";

const KEY = "linkshell.device.identity.v2";
let cached: Identity | undefined;

/** This install's keys: made once, kept in the Keychain, never leave the phone. */
export function deviceIdentity(): Identity {
  if (cached) return cached;
  cached = readSecret<Identity>(KEY);
  if (!cached) {
    cached = createIdentity();
    writeSecret(KEY, cached);
  }
  return cached;
}
