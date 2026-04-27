import AsyncStorage from "@react-native-async-storage/async-storage";

export interface SavedServer {
  url: string;
  name: string;
  isDefault: boolean;
  addedAt: number;
  lastUsedAt?: number;
  isOfficial?: boolean;
}

const STORAGE_KEY = "@linkshell/servers";

export async function loadServers(): Promise<SavedServer[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedServer[];
  } catch {
    return [];
  }
}

export async function saveServers(servers: SavedServer[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

export async function addServer(
  url: string,
  name?: string,
): Promise<SavedServer[]> {
  const servers = await loadServers();
  const normalized = url.replace(/\/+$/, "");
  const existing = servers.find((s) => s.url === normalized);
  if (existing) {
    existing.lastUsedAt = Date.now();
    existing.name = name ?? existing.name;
  } else {
    servers.push({
      url: normalized,
      name: name ?? new URL(normalized).host,
      isDefault: servers.length === 0,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
  }
  await saveServers(servers);
  return servers;
}

export async function removeServer(url: string): Promise<SavedServer[]> {
  let servers = await loadServers();
  const wasDefault = servers.find((s) => s.url === url)?.isDefault;
  servers = servers.filter((s) => s.url !== url);
  if (wasDefault && servers.length > 0) {
    servers[0]!.isDefault = true;
  }
  await saveServers(servers);
  return servers;
}

/** Remove a server AND all history records associated with it. */
export async function removeServerWithHistory(
  url: string,
): Promise<SavedServer[]> {
  const { removeByServerUrl } = await import("./history");
  const { removeProjectsByServerUrl } = await import("./projects");
  await removeByServerUrl(url);
  await removeProjectsByServerUrl(url);
  return removeServer(url);
}

export async function setDefaultServer(url: string): Promise<SavedServer[]> {
  const servers = await loadServers();
  for (const s of servers) {
    s.isDefault = s.url === url;
  }
  await saveServers(servers);
  return servers;
}

export async function touchServer(url: string): Promise<void> {
  const servers = await loadServers();
  const server = servers.find((s) => s.url === url);
  if (server) {
    server.lastUsedAt = Date.now();
    await saveServers(servers);
  }
}

export async function getDefaultServer(): Promise<SavedServer | undefined> {
  const servers = await loadServers();
  return servers.find((s) => s.isDefault) ?? servers[0];
}
