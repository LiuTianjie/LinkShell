import { baseName } from "./format";

export type FileNameValidationResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

export type RenameTargetResult =
  | { ok: true; path: string; name: string }
  | { ok: false; error: string };

/** Strips trailing slashes while preserving a bare `/` or `C:\` root. */
function trimTrailingSeparators(path: string): string {
  if (path === "/" || /^[A-Za-z]:[\\/]?$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "");
}

/** Validates a single directory or file entry name before sending `fs.rename`. */
export function validateFileName(raw: string, currentName?: string): FileNameValidationResult {
  const name = raw.trim();
  if (!name) return { ok: false, error: "名称不能为空" };
  if (name === "." || name === "..") return { ok: false, error: "不能使用 . 或 .. 作为名称" };
  if (/[\\/\0]/.test(name)) return { ok: false, error: "名称不能包含路径分隔符（/ 或 \\）" };
  if (name.length > 255) return { ok: false, error: "名称过长（最多 255 个字符）" };
  if (currentName !== undefined && name === currentName) {
    return { ok: false, error: "新名称与当前名称相同" };
  }
  return { ok: true, name };
}

/** Computes the sibling target path for `fs.rename` from `sourcePath` and `nextName`. */
export function renameTargetPath(sourcePath: string, nextName: string): RenameTargetResult {
  const cleanSource = trimTrailingSeparators(sourcePath);
  const currentName = baseName(cleanSource);
  const validation = validateFileName(nextName, currentName);
  if (!validation.ok) return validation;

  const sepIndex = Math.max(cleanSource.lastIndexOf("/"), cleanSource.lastIndexOf("\\"));
  if (sepIndex < 0) {
    return { ok: true, path: validation.name, name: validation.name };
  }
  const sep = cleanSource[sepIndex] ?? "/";
  const dir = cleanSource.slice(0, sepIndex);
  if (!dir) {
    return { ok: true, path: `${sep}${validation.name}`, name: validation.name };
  }
  return { ok: true, path: `${dir}${sep}${validation.name}`, name: validation.name };
}

/** Returns true when `candidate` equals `target` or lies nested underneath it. */
export function isSameOrChildPath(candidate: string | null | undefined, target: string): boolean {
  if (!candidate) return false;
  const normCandidate = trimTrailingSeparators(candidate);
  const normTarget = trimTrailingSeparators(target);
  if (normCandidate === normTarget) return true;
  return (
    normCandidate.startsWith(`${normTarget}/`) ||
    normCandidate.startsWith(`${normTarget}\\`)
  );
}

/** Updates a selected/open file path when an entry or ancestor folder is renamed. */
export function rewritePathPrefix(currentPath: string, oldPrefix: string, newPrefix: string): string {
  const normCurrent = trimTrailingSeparators(currentPath);
  const normOld = trimTrailingSeparators(oldPrefix);
  const normNew = trimTrailingSeparators(newPrefix);
  if (normCurrent === normOld) return normNew;
  if (normCurrent.startsWith(`${normOld}/`) || normCurrent.startsWith(`${normOld}\\`)) {
    return `${normNew}${normCurrent.slice(normOld.length)}`;
  }
  return currentPath;
}

export function deleteConfirmCopy(target: { name: string; isFile: boolean }): {
  title: string;
  message: string;
} {
  if (target.isFile) {
    return {
      title: "删除文件？",
      message: `将永久删除「${target.name}」，此操作无法撤销。`,
    };
  }
  return {
    title: "删除文件夹？",
    message: `将删除文件夹「${target.name}」及其中的全部内容，此操作无法撤销。`,
  };
}
