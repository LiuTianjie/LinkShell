import { createHmac, randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** scrypt cost: ~50 ms per guess here, on top of the per-device throttle. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const DEFAULT_MAX_CONCURRENT_SCRYPT = 4;
const DEFAULT_MAX_QUEUED_SCRYPT = 8;

let globalActiveScrypt = 0;
const globalScryptQueue: Array<() => void> = [];

function deriveScryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, SCRYPT, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function acquireScryptSlot(maxConcurrent: number, maxQueued: number): Promise<(() => void) | undefined> {
  if (globalActiveScrypt < maxConcurrent) {
    globalActiveScrypt++;
    return releaseScryptSlot;
  }
  if (globalScryptQueue.length >= maxQueued) {
    return undefined;
  }
  await new Promise<void>((resolve) => {
    globalScryptQueue.push(resolve);
  });
  return releaseScryptSlot;
}

function releaseScryptSlot(): void {
  const next = globalScryptQueue.shift();
  if (next) {
    next();
  } else {
    globalActiveScrypt = Math.max(0, globalActiveScrypt - 1);
  }
}

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

export interface AccessControlOptions {
  maxConcurrentScrypt?: number;
  maxQueuedScrypt?: number;
}

/** The computer's optional access password. Remote connections must unlock before anything else. */
export class AccessControl {
  private file: AccessFile | undefined;
  private readonly failures = new Map<string, { since: number; count: number }>();
  private readonly maxConcurrentScrypt: number;
  private readonly maxQueuedScrypt: number;

  constructor(private readonly home: string, options?: AccessControlOptions) {
    this.file = readAccessFile(home);
    this.maxConcurrentScrypt = options?.maxConcurrentScrypt ?? DEFAULT_MAX_CONCURRENT_SCRYPT;
    this.maxQueuedScrypt = options?.maxQueuedScrypt ?? DEFAULT_MAX_QUEUED_SCRYPT;
  }

  get enabled(): boolean {
    return this.file !== undefined;
  }

  set(password: string | undefined): void {
    writeAccessPassword(this.home, password);
    this.file = readAccessFile(this.home);
    this.failures.clear();
  }

  async unlock(deviceId: string, input: { password?: string; token?: string }, now = Date.now()): Promise<UnlockResult> {
    const file = this.file;
    if (!file) return { ok: true, ...this.issue(deviceId, now) };
    if (input.token !== undefined && input.password === undefined) {
      return this.verifyToken(file, deviceId, input.token, now) ? { ok: true, ...this.issue(deviceId, now) } : { ok: false, reason: "invalid_token" };
    }
    const failure = this.failures.get(deviceId);
    if (failure && now - failure.since < FAILURE_WINDOW_MS && failure.count >= MAX_FAILURES) return { ok: false, reason: "throttled" };
    const release = await acquireScryptSlot(this.maxConcurrentScrypt, this.maxQueuedScrypt);
    if (!release) return { ok: false, reason: "throttled" };
    let matched: boolean;
    try {
      matched = await this.matches(file, input.password ?? "");
    } finally {
      release();
    }
    // Re-check in case the password was changed or removed while scrypt ran.
    if (this.file !== file) return { ok: false, reason: "wrong" };
    if (matched) {
      this.failures.delete(deviceId);
      return { ok: true, ...this.issue(deviceId, now) };
    }
    const currentFailure = this.failures.get(deviceId);
    if (!currentFailure || now - currentFailure.since >= FAILURE_WINDOW_MS) this.failures.set(deviceId, { since: now, count: 1 });
    else currentFailure.count++;
    return { ok: false, reason: "wrong" };
  }

  private async matches(file: AccessFile, password: string): Promise<boolean> {
    if (!file.hash) return false;
    const expected = Buffer.from(file.hash, "base64");
    const actual = await deriveScryptAsync(password, Buffer.from(file.salt, "base64"), expected.length);
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
