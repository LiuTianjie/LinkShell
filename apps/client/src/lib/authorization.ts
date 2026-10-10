import * as WebBrowser from "expo-web-browser";
import { Alert } from "react-native";
import type { PendingPermissionSummary } from "@linkshell/wire";

/** Called only from the user's choice; merely receiving an elicitation never opens a URL. */
export function openAuthorization(request: PendingPermissionSummary, optionId: string): void {
  if (!request.url || optionId !== "accept") return;
  const url = new URL(request.url.url);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("授权链接无效");
  void WebBrowser.openBrowserAsync(url.href).catch((error: unknown) => Alert.alert("无法打开授权页面", error instanceof Error ? error.message : String(error)));
}
