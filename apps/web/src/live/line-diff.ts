/** One line of a unified diff: kept, added or removed, with its number on each side. */
export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  old?: number;
  new?: number;
}

/** A run of lines around changes; `skipped` kept lines before it are left out. */
export interface DiffHunk {
  skipped: number;
  lines: DiffLine[];
}

const LIMIT = 4000;

/**
 * Line diff of two texts (LCS on the lines between the common head and tail). Above LIMIT
 * changed lines on either side the middle is reported as removed-then-added: a file rewritten
 * wholesale reads the same either way, and the table stays small.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "same", text: a[i]!, old: i + 1, new: i + 1 });
  let oldLine = head, newLine = head;
  if (x.length > LIMIT || y.length > LIMIT || x.length * y.length > 4_000_000) {
    for (const text of x) out.push({ kind: "del", text, old: ++oldLine });
    for (const text of y) out.push({ kind: "add", text, new: ++newLine });
  } else {
    // Lengths of the longest common subsequence of every pair of suffixes.
    const width = y.length + 1;
    const table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { out.push({ kind: "same", text: x[i]!, old: ++oldLine, new: ++newLine }); i++; j++; }
      // On a tie the removal comes first, as diffs are read: what went, then what replaced it.
      else if (i < x.length && (j >= y.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { out.push({ kind: "del", text: x[i]!, old: ++oldLine }); i++; }
      else { out.push({ kind: "add", text: y[j]!, new: ++newLine }); j++; }
    }
  }
  for (let k = 0; k < tail; k++) {
    const text = a[a.length - tail + k]!;
    out.push({ kind: "same", text, old: ++oldLine, new: ++newLine });
  }
  return out;
}

/** The changed lines with `context` kept lines around each run, as a unified diff shows them. */
export function hunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = 1;
  });
  const out: DiffHunk[] = [];
  let skipped = 0;
  let current: DiffHunk | undefined;
  lines.forEach((line, index) => {
    if (!keep[index]) { skipped++; current = undefined; return; }
    if (!current) { current = { skipped, lines: [] }; out.push(current); skipped = 0; }
    current.lines.push(line);
  });
  return out;
}

/** Lines added and removed. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

/** A unified diff's text (as a patch carries it) as numbered lines. */
export function parsePatch(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0, newLine = 0;
  for (const text of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { oldLine = Number(header[1]) - 1; newLine = Number(header[2]) - 1; continue; }
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) continue;
    if (text.startsWith("+")) out.push({ kind: "add", text: text.slice(1), new: ++newLine });
    else if (text.startsWith("-")) out.push({ kind: "del", text: text.slice(1), old: ++oldLine });
    else if (text.startsWith(" ")) out.push({ kind: "same", text: text.slice(1), old: ++oldLine, new: ++newLine });
    else if (text === "\\ No newline at end of file") continue;
    else if (text) out.push({ kind: "same", text, old: ++oldLine, new: ++newLine });
  }
  return out;
}
