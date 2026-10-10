import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Codex moves archived rollouts out of sessions; absence from a paged thread/list is not evidence of archival. */
export async function archivedThreadIds(codexHome: string): Promise<string[]> {
  try {
    const entries = await readdir(join(codexHome, "archived_sessions"), { withFileTypes: true });
    return entries.flatMap((entry) => {
      const id = entry.isFile() ? /^rollout-.+-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name)?.[1] : undefined;
      return id ? [id] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
