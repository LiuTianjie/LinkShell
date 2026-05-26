import {
  clearAgentWorkspace,
  removeAgentConversationsByServerUrl,
  removeAgentConversationsBySessionId,
  removeAgentConversationsBySessionIdAndServerUrl,
} from "./agent-workspace";
import { clearHistory, removeByServerUrl, removeBySessionId, removeBySessionIdAndServerUrl } from "./history";
import {
  clearLastSession,
  clearLastSessionForServerUrl,
  clearLastSessionForSessionId,
  clearLastSessionForSessionIdAndServerUrl,
} from "./last-session";
import {
  clearProjects,
  removeProjectsByServerUrl,
  removeProjectsBySessionId,
  removeProjectsBySessionIdAndServerUrl,
} from "./projects";

export function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function removeLocalWorkspaceDataByServerUrl(
  serverUrl: string,
): Promise<void> {
  await Promise.all([
    removeByServerUrl(serverUrl),
    removeProjectsByServerUrl(serverUrl),
    removeAgentConversationsByServerUrl(serverUrl),
    clearLastSessionForServerUrl(serverUrl),
  ]);
}

export async function removeLocalWorkspaceDataByServerUrls(
  serverUrls: string[],
): Promise<void> {
  const normalized = [...new Set(serverUrls.map(normalizeServerUrl).filter(Boolean))];
  await Promise.all(normalized.map((url) => removeLocalWorkspaceDataByServerUrl(url)));
}

export async function removeLocalWorkspaceDataBySessionId(
  sessionId: string,
): Promise<void> {
  await Promise.all([
    removeBySessionId(sessionId),
    removeProjectsBySessionId(sessionId),
    removeAgentConversationsBySessionId(sessionId),
    clearLastSessionForSessionId(sessionId),
  ]);
}

export async function removeLocalWorkspaceDataBySession(
  sessionId: string,
  serverUrl: string,
): Promise<void> {
  await Promise.all([
    removeBySessionIdAndServerUrl(sessionId, serverUrl),
    removeProjectsBySessionIdAndServerUrl(sessionId, serverUrl),
    removeAgentConversationsBySessionIdAndServerUrl(sessionId, serverUrl),
    clearLastSessionForSessionIdAndServerUrl(sessionId, serverUrl),
  ]);
}

export async function clearLocalWorkspaceData(): Promise<void> {
  await Promise.all([
    clearHistory(),
    clearProjects(),
    clearAgentWorkspace(),
    clearLastSession(),
  ]);
}
