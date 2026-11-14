export type FileExtTone =
  | "ts"
  | "tsx"
  | "js"
  | "css"
  | "json"
  | "md"
  | "html"
  | "py"
  | "rs"
  | "go"
  | "sh"
  | "default";

export interface FileExtInfo {
  label: string;
  tone: FileExtTone;
}

const EXT_MAP: Record<string, FileExtInfo> = {
  ts: { label: "TS", tone: "ts" },
  mts: { label: "TS", tone: "ts" },
  cts: { label: "TS", tone: "ts" },
  tsx: { label: "TSX", tone: "tsx" },
  js: { label: "JS", tone: "js" },
  mjs: { label: "JS", tone: "js" },
  cjs: { label: "JS", tone: "js" },
  jsx: { label: "JSX", tone: "js" },
  css: { label: "CSS", tone: "css" },
  scss: { label: "SCSS", tone: "css" },
  less: { label: "LESS", tone: "css" },
  json: { label: "JSON", tone: "json" },
  jsonc: { label: "JSON", tone: "json" },
  yaml: { label: "YML", tone: "json" },
  yml: { label: "YML", tone: "json" },
  toml: { label: "TOML", tone: "json" },
  md: { label: "MD", tone: "md" },
  mdx: { label: "MDX", tone: "md" },
  html: { label: "HTML", tone: "html" },
  htm: { label: "HTML", tone: "html" },
  svg: { label: "SVG", tone: "html" },
  vue: { label: "VUE", tone: "md" },
  svelte: { label: "SVL", tone: "html" },
  py: { label: "PY", tone: "py" },
  rs: { label: "RS", tone: "rs" },
  go: { label: "GO", tone: "go" },
  sh: { label: "SH", tone: "sh" },
  zsh: { label: "SH", tone: "sh" },
  bash: { label: "SH", tone: "sh" },
  sql: { label: "SQL", tone: "py" },
  swift: { label: "SWF", tone: "html" },
  kt: { label: "KT", tone: "css" },
};

export function resolveFileExtBadge(filePath: string): FileExtInfo {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return { label: "DKR", tone: "go" };
  if (lower === "makefile") return { label: "MK", tone: "sh" };
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === lower.length - 1) {
    return { label: "FILE", tone: "default" };
  }
  const ext = lower.slice(dotIdx + 1);
  return (
    EXT_MAP[ext] ?? {
      label: ext.slice(0, 4).toUpperCase(),
      tone: "default",
    }
  );
}

export function FileExtBadge({ path }: { path: string }) {
  const info = resolveFileExtBadge(path);
  return (
    <span
      aria-hidden="true"
      className="inspector-ext-badge"
      data-ext-tone={info.tone}
    >
      {info.label}
    </span>
  );
}

/** Formats large diff counts compactly like Paseo (`1920 -> "1.9k"`), keeping `< 1000` exact. */
export function formatCompactStat(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) {
    const rounded = Math.round(value / 100) / 10;
    return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}k`;
  }
  return `${Math.round(value / 1000)}k`;
}

export interface CompactTreeFolderNode<T> {
  kind: "folder";
  id: string;
  label: string;
  added: number;
  removed: number;
  children: Array<CompactTreeFolderNode<T> | CompactTreeFileNode<T>>;
}

export interface CompactTreeFileNode<T> {
  kind: "file";
  id: string;
  name: string;
  path: string;
  added: number;
  removed: number;
  item: T;
}

export type CompactTreeNode<T> =
  | CompactTreeFolderNode<T>
  | CompactTreeFileNode<T>;

interface MutableDir<T> {
  segment: string;
  fullPath: string;
  dirs: Map<string, MutableDir<T>>;
  files: Array<CompactTreeFileNode<T>>;
  added: number;
  removed: number;
}

/**
 * Builds Paseo's indented compact-folder hierarchy (collapsing single-child folder chains
 * like `packages/website/src` into one collapsible row with aggregated `+N -M` totals).
 */
export function buildCompactChangeTree<
  T extends { key: string; path: string; added: number; removed: number },
>(entries: readonly T[]): Array<CompactTreeNode<T>> {
  const root: MutableDir<T> = {
    segment: "",
    fullPath: "",
    dirs: new Map(),
    files: [],
    added: 0,
    removed: 0,
  };

  for (const entry of entries) {
    const normalized = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = normalized.split("/").filter(Boolean);
    const fileName = parts.pop() ?? entry.path;

    let cursor = root;
    cursor.added += entry.added;
    cursor.removed += entry.removed;

    let prefix = "";
    for (const seg of parts) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let child = cursor.dirs.get(seg);
      if (!child) {
        child = {
          segment: seg,
          fullPath: prefix,
          dirs: new Map(),
          files: [],
          added: 0,
          removed: 0,
        };
        cursor.dirs.set(seg, child);
      }
      child.added += entry.added;
      child.removed += entry.removed;
      cursor = child;
    }

    cursor.files.push({
      kind: "file",
      id: entry.key,
      name: fileName,
      path: entry.path,
      added: entry.added,
      removed: entry.removed,
      item: entry,
    });
  }

  const finalizeDir = (dir: MutableDir<T>): CompactTreeFolderNode<T> => {
    let cur = dir;
    const segments = [cur.segment];
    while (cur.dirs.size === 1 && cur.files.length === 0) {
      const onlyChild = cur.dirs.values().next().value!;
      segments.push(onlyChild.segment);
      cur = onlyChild;
    }

    const childFolders = [...cur.dirs.values()]
      .sort((a, b) => a.segment.localeCompare(b.segment))
      .map(finalizeDir);
    const childFiles = [...cur.files].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    return {
      kind: "folder",
      id: `dir:${cur.fullPath}`,
      label: segments.join("/"),
      added: dir.added,
      removed: dir.removed,
      children: [...childFolders, ...childFiles],
    };
  };

  const topFolders = [...root.dirs.values()]
    .sort((a, b) => a.segment.localeCompare(b.segment))
    .map(finalizeDir);
  const topFiles = [...root.files].sort((a, b) => a.name.localeCompare(b.name));

  return [...topFolders, ...topFiles];
}
