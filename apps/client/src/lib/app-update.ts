import Constants from "expo-constants";
import { Linking, Platform } from "react-native";

export interface AppUpdateCheckResult {
  supported: boolean;
  currentVersion: string;
  latestVersion?: string;
  upToDate: boolean;
  downloadUrl?: string;
  releaseUrl?: string;
  notes?: string;
}

interface GithubAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
}

const GITHUB_RELEASES_API = "https://api.github.com/repos/liutianjie/LinkShell/releases?per_page=12";

export function parseSemverTuple(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(cleaned);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
  const va = parseSemverTuple(a);
  const vb = parseSemverTuple(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i]! !== vb[i]!) return va[i]! > vb[i]! ? 1 : -1;
  }
  return 0;
}

export function selectLatestMobileRelease(
  releases: readonly GithubRelease[],
  currentVersion: string,
): Omit<AppUpdateCheckResult, "supported"> {
  const candidates = releases.filter((rel) => {
    if (!rel || rel.draft || rel.prerelease) return false;
    const tag = rel.tag_name?.trim() ?? "";
    // Mobile releases use bare vX.Y.Z tags (skip gateway-v*, desktop-v*, cli-v*).
    return /^v?\d+\.\d+\.\d+$/.test(tag);
  });

  let best: { version: string; release: GithubRelease } | undefined;
  for (const rel of candidates) {
    const version = rel.tag_name!.trim().replace(/^v/i, "");
    if (!parseSemverTuple(version)) continue;
    if (!best || compareSemver(version, best.version) > 0) {
      best = { version, release: rel };
    }
  }

  if (!best) {
    return { currentVersion, upToDate: true };
  }

  const hasNewer = compareSemver(best.version, currentVersion) > 0;
  const apkAsset = best.release.assets?.find(
    (asset) => typeof asset.name === "string" && asset.name.toLowerCase().endsWith(".apk") && asset.browser_download_url,
  );
  const releaseUrl = best.release.html_url || "https://github.com/liutianjie/LinkShell/releases";
  return {
    currentVersion,
    latestVersion: best.version,
    upToDate: !hasNewer,
    downloadUrl: apkAsset?.browser_download_url ?? releaseUrl,
    releaseUrl,
    notes: best.release.body?.slice(0, 400),
  };
}

export function currentAppVersion(): string {
  return Constants.expoConfig?.version ?? "1.0.0";
}

/**
 * Queries GitHub Releases (`liutianjie/LinkShell`) for a newer mobile APK release.
 * STRICT PLATFORM RULE: Android ONLY — never runs or exposes external update links on iOS.
 */
export async function checkForAndroidAppUpdate(
  options?: {
    platformOs?: string;
    currentVersion?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<AppUpdateCheckResult> {
  const os = options?.platformOs ?? Platform.OS;
  const currentVersion = options?.currentVersion ?? currentAppVersion();
  if (os !== "android") {
    return { supported: false, currentVersion, upToDate: true };
  }
  const fetchFn = options?.fetchImpl ?? fetch;
  const response = await fetchFn(GITHUB_RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  const releases = Array.isArray(data) ? (data as GithubRelease[]) : data && typeof data === "object" ? [data as GithubRelease] : [];
  return {
    supported: true,
    ...selectLatestMobileRelease(releases, currentVersion),
  };
}

export async function openAndroidUpdateUrl(url: string): Promise<void> {
  if (Platform.OS !== "android" || !url.startsWith("https://")) return;
  await Linking.openURL(url);
}
