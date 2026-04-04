import { NativeModules, Platform } from "react-native";

const { LiveActivityModule } = NativeModules;

export interface SessionActivityState {
  sessionId: string;
  status: string;
  lastLine: string;
  projectName: string;
  provider: string;
  quickActions: QuickAction[];
  tokensUsed: number;
  elapsedSeconds: number;
}

export interface QuickAction {
  label: string;
  input: string;
}

const isIOS = Platform.OS === "ios";

export async function isLiveActivityAvailable(): Promise<boolean> {
  if (!isIOS || !LiveActivityModule) return false;
  try {
    return await LiveActivityModule.isAvailable();
  } catch {
    return false;
  }
}

export async function startLiveActivity(
  sessions: SessionActivityState[],
  activeSessionId: string,
): Promise<string | null> {
  if (!isIOS || !LiveActivityModule) return null;
  try {
    const json = JSON.stringify(sessions);
    return await LiveActivityModule.startActivity(json, activeSessionId);
  } catch (e) {
    console.warn("[LiveActivity] start failed:", e);
    return null;
  }
}

export async function updateLiveActivity(
  sessions: SessionActivityState[],
  activeSessionId: string,
): Promise<void> {
  if (!isIOS || !LiveActivityModule) return;
  try {
    const json = JSON.stringify(sessions);
    await LiveActivityModule.updateActivity(json, activeSessionId);
  } catch {
    // Silently ignore update failures
  }
}

export async function endLiveActivity(): Promise<void> {
  if (!isIOS || !LiveActivityModule) return;
  try {
    await LiveActivityModule.endActivity();
  } catch {
    // Silently ignore
  }
}
