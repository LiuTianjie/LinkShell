import { NativeModules, Platform } from "react-native";

const { LiveActivityModule } = NativeModules;

// ── Activity state (matches Swift ContentState) ──

export interface ActivityState {
  sid: string;
  tid: string;
  phase: string;
  project: string;
  provider: string;
  tool: string;
  elapsed: number;
  hasPermission: boolean;
  permCount: number;
  otherCount: number;
  totalPermCount: number;
}

// ── Extended data (single object, written to UserDefaults for widget) ──

export interface ExtendedActivityData {
  sid: string;
  tid: string;
  toolDescription: string;
  contextLines: string;
  permissionTool: string;
  permissionContext: string;
  permissionRequestId: string;
  quickActions: QuickAction[];
  secondaryTerminals: SecondaryTerminal[];
}

export interface SecondaryTerminal {
  sid: string;
  tid: string;
  provider: string;
  phase: string;
  hasPermission: boolean;
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
  state: ActivityState,
  extended: ExtendedActivityData,
): Promise<string | null> {
  if (!isIOS || !LiveActivityModule) return null;
  try {
    return await LiveActivityModule.startActivity(
      JSON.stringify(state),
      JSON.stringify(extended),
    );
  } catch (e) {
    console.warn("[LiveActivity] start failed:", e);
    return null;
  }
}

export async function updateLiveActivity(
  state: ActivityState,
  extended: ExtendedActivityData,
  alert?: boolean,
): Promise<boolean> {
  if (!isIOS || !LiveActivityModule) return false;
  try {
    await LiveActivityModule.updateActivity(
      JSON.stringify(state),
      JSON.stringify(extended),
      alert ?? false,
    );
    return true;
  } catch {
    return false;
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
