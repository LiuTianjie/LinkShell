import React from "react";
import { useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { SettingsScreen } from "../../screens/SettingsScreen";

export default function SettingsTab() {
  const ctx = useAppContext();
  const router = useRouter();

  return (
    <SettingsScreen
      gatewayBaseUrl={ctx.gatewayBaseUrl}
      onGatewayChange={ctx.setGatewayBaseUrl}
      onOpenGatewayList={() => router.push("/gateway-list")}
    />
  );
}
