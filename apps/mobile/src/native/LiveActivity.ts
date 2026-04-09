import { NativeModules, Platform } from "react-native";

const { LiveActivityModule } = NativeModules;

// ── Compact snapshot (matches Swift TerminalSnapshot) ──

export interface TerminalSnapshot {
  sid: string;
  tid: string;
  phase: string;
  project: string;
  provider: string;
  tool: string;
  elapsed: number;
  hasPermission: boolean;
  permCount: number;
}

// ── Extended data (written to UserDefaults for widget, keyed by sid:tid) ──

export interface ExtendedTerminalData {
  sid: string;
  tid: string;
  toolDescription: string;
  contextLines: string;
  permissionTool: string;
  permissionContext: string;
  permissionRequestId: string;
  quickActions: QuickAction[];
}

export interface QuickAction {
  label: string;
  input: string;
  needsInput: boolean;
  desc?: string;
}

// ── Native bridge ──

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
  terminals: TerminalSnapshot[],
  extendedData: ExtendedTerminalData[],
  focusedSid: string,
  focusedTid: string,
): Promise<string | null> {
  if (!isIOS || !LiveActivityModule) return null;
  try {
    return await LiveActivityModule.startActivity(
      JSON.stringify(terminals),
      JSON.stringify(extendedData),
      focusedSid,
      focusedTid,
    );
  } catch (e) {
    console.warn("[LiveActivity] start failed:", e);
    return null;
  }
}

export async function updateLiveActivity(
  terminals: TerminalSnapshot[],
  extendedData: ExtendedTerminalData[],
  focusedSid: string,
  focusedTid: string,
  alert?: boolean,
): Promise<void> {
  if (!isIOS || !LiveActivityModule) return;
  try {
    await LiveActivityModule.updateActivity(
      JSON.stringify(terminals),
      JSON.stringify(extendedData),
      focusedSid,
      focusedTid,
      alert ?? false,
    );
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

export async function confirmAction(requestId: string): Promise<void> {
  if (!isIOS || !LiveActivityModule) return;
  try {
    await LiveActivityModule.confirmAction(requestId);
  } catch {
    // Silently ignore
  }
}
