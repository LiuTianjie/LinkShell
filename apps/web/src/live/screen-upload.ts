import type { HostLink } from "@linkshell/client-core";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL } from "./attachments";
import { baseName, messageOf } from "./common";
import { fileBase64 } from "./Files";

export interface ScreenUploadProgress {
  done: number;
  total: number;
  name: string;
}

export interface ScreenUploadResult {
  dir: string;
  paths: string[];
}

export async function resolveScreenUploadDir(
  link: HostLink,
  preferredDir?: string,
): Promise<string> {
  const custom = preferredDir?.trim();
  if (custom) return custom;
  try {
    const desktop = await link.call("fs.list", {
      path: "~/Desktop",
      hidden: false,
      files: false,
    });
    if (desktop?.path) return desktop.path;
  } catch {
    // Desktop directory may not exist (e.g., headless Linux); fall back to user home.
  }
  const home = await link.call("fs.list", { hidden: false, files: false });
  return home.path || "~";
}

export async function uploadScreenFiles({
  link,
  files,
  preferredDir,
  onProgress,
}: {
  link: HostLink;
  files: File[];
  preferredDir?: string;
  onProgress?: (progress: ScreenUploadProgress) => void;
}): Promise<ScreenUploadResult> {
  if (!files.length) throw new Error("未选择可上传的文件");
  for (const candidate of files) {
    if (candidate.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${candidate.name} 超过 ${MAX_ATTACHMENT_LABEL}，尚未上传任何文件。`);
    }
  }
  const dir = await resolveScreenUploadDir(link, preferredDir);
  const paths: string[] = [];
  let done = 0;
  try {
    for (const candidate of files) {
      onProgress?.({ done, total: files.length, name: candidate.name });
      const data = await fileBase64(candidate);
      const saved = await link.call(
        "fs.upload",
        { dir, name: candidate.name, data },
        180_000,
      );
      paths.push(saved.path);
      done++;
    }
    return { dir, paths };
  } catch (error) {
    throw new Error(
      `${done ? `已上传 ${done} / ${files.length} 个文件。` : ""}${messageOf(error)}`,
      { cause: error },
    );
  }
}

export function formatScreenUploadSummary(result: ScreenUploadResult): string {
  const target = baseName(result.dir) || result.dir;
  if (result.paths.length === 1) {
    return `已上传到 ${target}：${baseName(result.paths[0]!)}`;
  }
  return `已上传 ${result.paths.length} 个文件到 ${target}`;
}
