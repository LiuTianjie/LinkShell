import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RELEASES = "https://api.github.com/repos/LiuTianjie/LinkShell/releases?per_page=100";
const DOWNLOADS = "https://github.com/LiuTianjie/LinkShell/releases/download/";
const MAX_INSTALLER_BYTES = 2 * 1024 ** 3;

export interface WindowsRelease {
  version: string;
  name: string;
  url: string;
  checksumUrl: string;
  size: number;
}

export interface DownloadedInstaller {
  directory: string;
  path: string;
  sha256: string;
  version: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function versionParts(value: string): { numbers: number[]; prerelease: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return undefined;
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
}

/** GitHub sorts releases by publication time, which can put an older maintenance release first. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error("版本号无效");
  for (let index = 0; index < 3; index++) {
    const delta = left.numbers[index]! - right.numbers[index]!;
    if (delta) return delta;
  }
  if (!left.prerelease.length || !right.prerelease.length) return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const x = left.prerelease[index], y = right.prerelease[index];
    if (x === undefined || y === undefined) return Number(x !== undefined) - Number(y !== undefined);
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Only the matching installer and checksum on this project's official release may be executed. */
export function windowsRelease(releases: unknown, beta: boolean): WindowsRelease | undefined {
  if (!Array.isArray(releases)) throw new Error("GitHub 版本信息无效");
  const candidates: WindowsRelease[] = [];
  for (const raw of releases) {
    if (!raw || typeof raw !== "object") continue;
    const release = raw as Record<string, unknown>;
    if (release.draft || (!beta && release.prerelease) || typeof release.tag_name !== "string") continue;
    const tag = release.tag_name;
    if (!tag.startsWith("desktop-v")) continue;
    const version = tag.slice("desktop-v".length);
    const parsed = versionParts(version);
    if (!parsed || (!beta && parsed.prerelease.length) || !Array.isArray(release.assets)) continue;
    const name = `LinkShell-Setup-${version}-windows-x64.exe`;
    const asset = release.assets.find((entry: { name?: unknown }) => entry?.name === name);
    const checksum = release.assets.find((entry: { name?: unknown }) => entry?.name === name + ".sha256");
    const url = `${DOWNLOADS}${tag}/${name}`;
    if (asset?.browser_download_url !== url || checksum?.browser_download_url !== url + ".sha256") continue;
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) continue;
    candidates.push({ version, name, url, checksumUrl: checksum.browser_download_url, size: asset.size });
  }
  return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
}

export async function checkWindowsRelease(fetch: Fetch, beta: boolean): Promise<WindowsRelease | undefined> {
  const response = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return windowsRelease(await response.json(), beta);
}

export async function verifyInstaller(download: DownloadedInstaller): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(download.path)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== download.sha256) throw new Error("安装包 SHA-256 校验失败，请重新下载");
}

export async function downloadWindowsInstaller(
  release: WindowsRelease,
  cache: string,
  fetch: Fetch,
  progress: (downloaded: number, total: number) => void,
): Promise<DownloadedInstaller> {
  const checksum = await fetch(release.checksumUrl, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!checksum.ok) throw new Error(`无法读取安装包校验值（${checksum.status}）`);
  const text = await checksum.text();
  const expected = /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i.exec(text.trim());
  if (text.length > 1024 || !expected || expected[2] !== release.name) throw new Error("安装包校验信息无效");
  const sha256 = expected[1]!.toLowerCase();
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "download-"));
  try {
    await writeFile(join(directory, "owner"), String(process.pid), { flag: "wx", mode: 0o600 });
    const response = await fetch(release.url, { cache: "no-store", signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`安装包下载失败（${response.status}）`);
    const path = join(directory, release.name);
    const temporary = path + ".part";
    const file = await open(temporary, "wx", 0o600);
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0, lastProgress = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > release.size) throw new Error("下载大小与发布信息不一致");
        hash.update(value);
        await file.writeFile(value);
        if (Date.now() - lastProgress >= 200) { progress(received, release.size); lastProgress = Date.now(); }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      await file.close();
    }
    if (received !== release.size || hash.digest("hex") !== sha256) throw new Error("安装包 SHA-256 校验失败，请重试下载");
    await rename(temporary, path);
    progress(received, release.size);
    return { directory, path, sha256, version: release.version };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** A new app can clean its previous downloads after the installer exits; never touch an active installer. */
export async function cleanWindowsUpdateDownloads(cache: string): Promise<void> {
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^download-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    const directory = join(cache, entry.name);
    let active = false;
    for (const marker of ["owner", "ready"]) {
      const pid = Number(await readFile(join(directory, marker), "utf8").catch(() => ""));
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); active = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") active = true; }
    }
    if (active) continue;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
