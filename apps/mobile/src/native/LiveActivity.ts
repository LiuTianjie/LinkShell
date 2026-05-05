import { NativeModules, Platform } from "react-native";

const { LiveActivityModule } = NativeModules;

// ── Activity state (matches Swift ContentState) ──

export type AgentActivityStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "error";

export interface ActivityState {
  conversationId: string;
  sessionId: string;
  provider: string;
  project: string;
  status: AgentActivityStatus;
  phaseLabel: string;
  summary: string;
  hasPermission: boolean;
  permissionCount: number;
  updatedAt: number;
}

// ── Extended data (single object, written to UserDefaults for widget) ──

export interface ExtendedActivityData {
  conversationId: string;
  permissionRequestId: string;
  permissionTitle: string;
  permissionContext: string;
  permissionOptions: AgentPermissionOption[];
  currentToolName: string;
  currentToolInput: string;
  deepLink: string;
}

export interface AgentPermissionOption {
  id: string;
  label: string;
  kind?: "allow" | "deny" | "other";
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
