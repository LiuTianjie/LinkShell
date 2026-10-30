import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Separate from machine.json: a cosmetic edit must never replace this host's identity. */
export class MachineName {
  private readonly path: string;
  private customName?: string;
  private configured = false;

  constructor(home: string, readonly defaultName: string) {
    this.path = join(home, "machine-name.json");
    try {
      const saved: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (saved && typeof saved === "object" && "name" in saved && typeof saved.name === "string") {
        const name = saved.name.trim();
        if (name.length <= 40) {
          this.customName = name || undefined;
          this.configured = true;
        }
      }
    } catch { /* An absent or damaged display name does not affect the computer's identity. */ }
  }

  get value(): string { return this.customName ?? this.defaultName; }

  info(): { defaultName: string; customName?: string; configured: boolean } {
    return { defaultName: this.defaultName, configured: this.configured, ...(this.customName ? { customName: this.customName } : {}) };
  }

  set(value: string): void {
    const name = value.trim();
    if (name.length > 40) throw new Error("名称不能超过 40 个字符");
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ name })}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
      this.customName = name || undefined;
      this.configured = true;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
