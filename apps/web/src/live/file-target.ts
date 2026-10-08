export interface FileTarget {
  path: string;
  line?: number;
}
export function fileTarget(url: string, base?: string): FileTarget | undefined {
  let target = url.trim();
  if (!target || target.startsWith("#")) return;
  target = target.replace(/^file:\/\//, "");
  try {
    target = decodeURI(target);
  } catch {
    /* Preserve an undecodable file name. */
  }
  let line: number | undefined;
  const location = /(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/.exec(target);
  if (location) {
    line = Number(location[1] ?? location[2]);
    target = target.slice(0, location.index);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return;
  if (!target.startsWith("/") && !target.startsWith("~")) {
    if (!base) return;
    target = `${base.replace(/\/$/, "")}/${target.replace(/^\.\//, "")}`;
  }
  return target
    ? { path: target, ...(line && line > 0 ? { line } : {}) }
    : undefined;
}
