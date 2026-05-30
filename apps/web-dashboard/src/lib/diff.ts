// Pure unified-diff parsing for the diff-centric Codex-style UI. The agent's
// fileChange.diff is a unified-diff string; we split it into typed lines so the
// renderer can apply add/remove gutters without re-parsing on every render.

export type DiffLineKind = "add" | "remove" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function parseDiff(diff: string): DiffLine[] {
  const lines = diff.split("\n");
  const out: DiffLine[] = [];
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      out.push({ kind: "hunk", text: raw });
    } else if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ")
    ) {
      out.push({ kind: "meta", text: raw });
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "remove", text: raw.slice(1) });
    } else {
      out.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "remove") removed++;
  }
  return { added, removed };
}
