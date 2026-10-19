import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createIdentity, idOf, sign, verifySignature, type Identity } from "@linkshell/wire";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_KEYS = 2048;

interface DesktopState {
  schema: 1;
  identity: Identity;
  storage: Record<string, unknown>;
}

export function validStorageKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= 1024 &&
    [...key].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
    !["__proto__", "prototype", "constructor"].includes(key);
}

function validIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Identity;
  if (![identity.id, identity.signKey, identity.boxKey, identity.signSecret, identity.boxSecret]
    .every((part) => typeof part === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(part))) return false;
  try {
    return idOf(identity.signKey) === identity.id &&
      verifySignature(identity.signKey, "linkshell-desktop-identity", sign(identity, "linkshell-desktop-identity"));
  } catch { return false; }
}

/** The browser origin changes on every launch; paired identity and drafts must not. */
export class DesktopClientState {
  private writes: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string, private value: DesktopState) {}

  static async open(home: string): Promise<DesktopClientState> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const file = join(home, "desktop-client.json");
    try {
      const initial: DesktopState = { schema: 1, identity: createIdentity(), storage: {} };
      await writeFile(file, JSON.stringify(initial), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if ((await stat(file)).size > MAX_STATE_BYTES) throw new Error("桌面偏好文件过大，请检查本地存储");
    const value = JSON.parse(await readFile(file, "utf8")) as DesktopState;
    if (value.schema !== 1 || !validIdentity(value.identity) || !value.storage || typeof value.storage !== "object" ||
        Array.isArray(value.storage) || Object.keys(value.storage).some((key) => !validStorageKey(key))) {
      // Replacing a damaged identity would silently lose every existing pairing.
      throw new Error("桌面设备身份文件无法读取，请保留此文件并检查本地存储");
    }
    await chmod(file, 0o600);
    return new DesktopClientState(file, value);
  }

  snapshot(): Pick<DesktopState, "identity" | "storage"> {
    return { identity: this.value.identity, storage: this.value.storage };
  }

  set(key: string, value: unknown): Promise<void> {
    if (!validStorageKey(key)) return Promise.reject(new Error("无效的偏好名称"));
    const write = this.writes.then(async () => {
      const storage = { ...this.value.storage };
      if (value === null) delete storage[key];
      else storage[key] = value;
      if (Object.keys(storage).length > MAX_KEYS) throw new Error("桌面偏好条目过多");
      const next: DesktopState = { ...this.value, storage };
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("桌面偏好存储空间已满");
      const temporary = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
        await rename(temporary, this.file);
        this.value = next;
      } finally {
        await rm(temporary, { force: true });
      }
    });
    // A rejected write must not prevent later, smaller preferences from saving.
    this.writes = write.catch(() => {});
    return write;
  }

  async flush(): Promise<void> { await this.writes; }
}
