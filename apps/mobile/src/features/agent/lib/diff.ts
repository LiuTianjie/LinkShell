import type { Theme } from "../../../theme";
import { compactPath } from "./format";

export type FileDiffEntry = {
  path: string;
  added: number;
  removed: number;
};

export type HighlightToken = { text: string; color: string; fontWeight?: "400" | "700" };

export function looksLikeDiff(text: string | undefined): boolean {
  if (!text) return false;
  const value = text.trim();
  return (
    value.startsWith("diff --git ") ||
    value.startsWith("@@ ") ||
    value.includes("\n@@ ") ||
    (value.includes("\n--- ") && value.includes("\n+++ "))
  );
}

export function diffStats(diff: string, fallback?: string) {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match?.[2]) files.add(match[2]);
    } else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      files.add(line.replace(/^\+\+\+ b?\//, "").trim());
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  if (files.size === 0 && fallback) {
    fallback
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => files.add(line.replace(/^(modify|create|delete|update|add)\s+/i, "")));
  }
  return { files: [...files].slice(0, 4), added, removed };
}

export function diffEntries(diff: string, fallback?: string): FileDiffEntry[] {
  const entries: FileDiffEntry[] = [];
  let current: FileDiffEntry | null = null;

  const flush = () => {
    if (current && (current.path || current.added > 0 || current.removed > 0)) {
      const existing = entries.find((entry) => entry.path === current!.path);
      if (existing) {
        existing.added += current.added;
        existing.removed += current.removed;
      } else {
        entries.push(current);
      }
    }
    current = null;
  };

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      flush();
      const match = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match?.[2] || rawLine.replace(/^diff --git\s+/, ""), added: 0, removed: 0 };
      continue;
    }
    if (rawLine.startsWith("+++ ") && !rawLine.startsWith("+++ /dev/null")) {
      const path = rawLine.replace(/^\+\+\+ b?\//, "").trim();
      if (!current) current = { path, added: 0, removed: 0 };
      else current.path = path;
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      if (!current) current = { path: "工作区 diff", added: 0, removed: 0 };
      current.added += 1;
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      if (!current) current = { path: "工作区 diff", added: 0, removed: 0 };
      current.removed += 1;
    }
  }
  flush();

  if (entries.length > 0) return entries.slice(0, 12);

  const fallbackEntries = (fallback ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      path: line.replace(/^(modify|create|delete|update|add)\s+/i, ""),
      added: 0,
      removed: 0,
    }));
  return fallbackEntries.slice(0, 12);
}

export function diffLineColors(line: string, theme: Theme) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { color: theme.success, backgroundColor: "rgba(52, 199, 89, 0.12)" };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { color: theme.error, backgroundColor: "rgba(255, 59, 48, 0.12)" };
  }
  if (line.startsWith("@@")) {
    return { color: theme.accent, backgroundColor: theme.accentLight };
  }
  if (line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++")) {
    return { color: theme.textSecondary, backgroundColor: theme.bgInput };
  }
  return { color: theme.textSecondary, backgroundColor: "transparent" };
}

export function syntaxTokens(line: string, language: string, theme: Theme): HighlightToken[] {
  if (!line) return [{ text: " ", color: theme.textSecondary }];
  if (line.startsWith("+") && !line.startsWith("+++")) return [{ text: line, color: theme.success }];
  if (line.startsWith("-") && !line.startsWith("---")) return [{ text: line, color: theme.error }];
  if (line.startsWith("@@")) return [{ text: line, color: theme.accent, fontWeight: "700" }];

  const commentIndex = (() => {
    if (["python", "ruby", "shell", "yaml"].includes(language)) return line.indexOf("#");
    const slash = line.indexOf("//");
    return slash >= 0 ? slash : -1;
  })();
  const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : "";
  const keywordPattern = /\b(import|from|export|const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|extends|implements|async|await|try|catch|throw|new|true|false|null|undefined|def|self|struct|enum|public|private|protected|static|package)\b/g;
  const tokenPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b(import|from|export|const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|extends|implements|async|await|try|catch|throw|new|true|false|null|undefined|def|self|struct|enum|public|private|protected|static|package)\b)/g;
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(code))) {
    if (match.index > cursor) {
      tokens.push({ text: code.slice(cursor, match.index), color: theme.textSecondary });
    }
    const value = match[0];
    const isString = value.startsWith("\"") || value.startsWith("'") || value.startsWith("`");
    const isNumber = /^\d/.test(value);
    tokens.push({
      text: value,
      color: isString ? theme.success : isNumber ? theme.warning : keywordPattern.test(value) ? theme.accent : theme.text,
      fontWeight: isString || isNumber ? "400" : "700",
    });
    keywordPattern.lastIndex = 0;
    cursor = match.index + value.length;
  }
  if (cursor < code.length) tokens.push({ text: code.slice(cursor), color: theme.textSecondary });
  if (comment) tokens.push({ text: comment, color: theme.textTertiary });
  return tokens.length ? tokens : [{ text: line, color: theme.textSecondary }];
}

export function commandLanguage(toolName: string): string {
  return toolName.includes("命令") ? "shell" : "text";
}

export function unwrapShell(raw: string): string {
  let value = raw.trim();
  const lower = value.toLowerCase();
  const prefixes = [
    "/usr/bin/zsh -lc ",
    "/bin/zsh -lc ",
    "zsh -lc ",
    "/usr/bin/bash -lc ",
    "/usr/bin/bash -c ",
    "/bin/bash -lc ",
    "/bin/bash -c ",
    "bash -lc ",
    "bash -c ",
    "/bin/sh -c ",
    "sh -c ",
  ];

  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    value = value.slice(prefix.length).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const cdIndex = value.indexOf("&&");
    if (cdIndex >= 0) value = value.slice(cdIndex + 2).trim();
    break;
  }

  const pipeIndex = value.indexOf(" | ");
  if (pipeIndex >= 0) value = value.slice(0, pipeIndex).trim();
  return value;
}

export function lastCommandTarget(args: string, fallback: string): string {
  const tokens = args.split(/\s+/).filter(Boolean);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index].replace(/^["']|["']$/g, "");
    if (!token || token.startsWith("-")) continue;
    return compactPath(token);
  }
  return fallback;
}

export function humanizeCommand(raw: string, running: boolean): { verb: string; target: string } {
  const command = unwrapShell(raw);
  const [toolRaw, ...rest] = command.split(/\s+/);
  const tool = (toolRaw || command).split("/").pop()?.toLowerCase() || "";
  const args = rest.join(" ");
  switch (tool) {
    case "cat":
    case "nl":
    case "head":
    case "tail":
    case "sed":
    case "less":
    case "more":
      return { verb: running ? "正在读取" : "读取了", target: lastCommandTarget(args, "文件") };
    case "rg":
    case "grep":
    case "ag":
    case "ack":
      return { verb: running ? "正在搜索" : "搜索了", target: args ? args.slice(0, 80) : "工作区" };
    case "ls":
    case "find":
    case "fd":
      return { verb: running ? "正在列出" : "列出了", target: lastCommandTarget(args, "文件") };
    case "mkdir":
      return { verb: running ? "正在创建" : "创建了", target: lastCommandTarget(args, "目录") };
    case "rm":
      return { verb: running ? "正在删除" : "删除了", target: lastCommandTarget(args, "文件") };
    case "git":
      return { verb: running ? "正在运行 git" : "运行了 git", target: args || "命令" };
    default:
      return { verb: running ? "正在运行" : "运行了", target: command || raw };
  }
}
