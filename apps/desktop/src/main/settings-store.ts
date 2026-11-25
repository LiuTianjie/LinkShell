import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeKeepAwakeMode } from "./keep-awake.js";
import { WorkspacePolicy } from "./policy.js";

/**
 * Typed, atomically persisted desktop shell settings (`userData/desktop.json`).
 * Serializes concurrent writes onto one promise chain so rapid resize/toggle events
 * never corrupt or race on disk.
 */
export class SettingsStore {
  private readonly values = new Map<string, unknown>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly directory: () => string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.directory(), "desktop.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        this.values.set(key, value);
      }
    } catch {
      /* First run or missing file: defaults apply. */
    }
  }

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  appearance(): "light" | "dark" | "system" {
    const value = this.values.get("appearance");
    return WorkspacePolicy.validAppearance(value) ? value : "dark";
  }

  opaqueWindow(): boolean {
    return this.values.get("opaqueWindow") === true;
  }

  autoCheck(): boolean {
    return this.values.get("autoCheck") !== false;
  }

  updateChannel(): "stable" | "beta" {
    return this.values.get("updateChannel") === "beta" ? "beta" : "stable";
  }

  notifications(): boolean {
    return this.values.get("notifications") !== false;
  }

  snapshot() {
    return {
      opaqueWindow: this.opaqueWindow(),
      autoCheck: this.autoCheck(),
      updateChannel: this.updateChannel(),
      keepAwake: normalizeKeepAwakeMode(this.values.get("keepAwake")),
      notifications: this.notifications(),
    };
  }

  save(): Promise<void> {
    this.saving = this.saving
      .then(async () => {
        const dir = this.directory();
        await mkdir(dir, { recursive: true });
        const file = join(dir, "desktop.json");
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(Object.fromEntries(this.values), null, 2), { mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((error: unknown) => console.error("[settings]", error));
    return this.saving;
  }
}
