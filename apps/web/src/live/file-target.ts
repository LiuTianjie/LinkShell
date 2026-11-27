import { parseFileLink } from "@linkshell/client-core";

export interface FileTarget {
  path: string;
  line?: number;
}
export function fileTarget(url: string, base?: string): FileTarget | undefined {
  const parsed = parseFileLink(url, base);
  if (!parsed) return undefined;
  return parsed.line !== undefined ? { path: parsed.path, line: parsed.line } : { path: parsed.path };
}
