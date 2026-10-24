import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** scrypt cost: ~50 ms per guess here, on top of the per-device throttle. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 5;

interface AccessFile {
  salt: string;
  hash: string;
  /** Signs unlock tokens; replaced with the password, so a new password voids every earlier unlock. */
  secret: string;
}

export function accessPath(home: string): string {
  return join(home, "access.json");
}

/** Writes or removes the password file directly (the CLI, when no host is running). */
export function writeAccessPassword(home: string, password: string | undefined): void {
  const path = accessPath(home);
  if (!password) {
    rmSync(path, { force: true });
    return;
  }
  const salt = randomBytes(16);
  const file: AccessFile = {
    salt: salt.toString("base64"),
    hash: scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("base64"),
    secret: randomBytes(32).toString("base64"),
  };
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function readAccessFile(home: string): AccessFile | undefined {
  const path = accessPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as Partial<AccessFile>;
    if (typeof file.salt === "string" && typeof file.hash === "string" && typeof file.secret === "string") return file as AccessFile;
  } catch { /* handled below */ }
  // A damaged file must not silently open the computer: keep it locked with no password that matches.
  return { salt: "", hash: "", secret: randomBytes(32).toString("base64") };
}

export type UnlockResult = { ok: true; token: string; expiresAt: number } | { ok: false; reason: "wrong" | "throttled" | "invalid_token" };

/** The computer's optional access password. Remote connections must unlock before anything else. */
export class AccessControl {
  private file: AccessFile | undefined;
  private readonly failures = new Map<string, { since: number; count: number }>();

  constructor(private readonly home: string) {
    this.file = readAccessFile(home);
  }

  get enabled(): boolean {
    return this.file !== undefined;
  }

  set(password: string | undefined): void {
    writeAccessPassword(this.home, password);
    this.file = readAccessFile(this.home);
    this.failures.clear();
  }

  unlock(deviceId: string, input: { password?: string; token?: string }, now = Date.now()): UnlockResult {
    const file = this.file;
    if (!file) return { ok: true, ...this.issue(deviceId, now) };
    if (input.token !== undefined && input.password === undefined) {
      return this.verifyToken(file, deviceId, input.token, now) ? { ok: true, ...this.issue(deviceId, now) } : { ok: false, reason: "invalid_token" };
    }
    const failure = this.failures.get(deviceId);
    if (failure && now - failure.since < FAILURE_WINDOW_MS && failure.count >= MAX_FAILURES) return { ok: false, reason: "throttled" };
    if (this.matches(file, input.password ?? "")) {
      this.failures.delete(deviceId);
      return { ok: true, ...this.issue(deviceId, now) };
    }
    if (!failure || now - failure.since >= FAILURE_WINDOW_MS) this.failures.set(deviceId, { since: now, count: 1 });
    else failure.count++;
    return { ok: false, reason: "wrong" };
  }

  private matches(file: AccessFile, password: string): boolean {
    if (!file.hash) return false;
    const expected = Buffer.from(file.hash, "base64");
    const actual = scryptSync(password, Buffer.from(file.salt, "base64"), expected.length, SCRYPT);
    return timingSafeEqual(actual, expected);
  }

  private issue(deviceId: string, now: number): { token: string; expiresAt: number } {
    const expiresAt = now + TOKEN_TTL_MS;
    if (!this.file) return { token: "", expiresAt };
    return { token: `${expiresAt}.${this.sign(this.file, deviceId, expiresAt)}`, expiresAt };
  }

  private verifyToken(file: AccessFile, deviceId: string, token: string, now: number): boolean {
    const [expires, signature] = token.split(".");
    const expiresAt = Number(expires);
    if (!signature || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
    const expected = Buffer.from(this.sign(file, deviceId, expiresAt));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private sign(file: AccessFile, deviceId: string, expiresAt: number): string {
    return createHmac("sha256", Buffer.from(file.secret, "base64")).update(`linkshell-access:${deviceId}:${expiresAt}`).digest("base64url");
  }
}
