import React from "react";
import { useRouter } from "expo-router";
import { useAppContext } from "../contexts/AppContext";
import { GatewayListScreen } from "../screens/GatewayListScreen";

export default function GatewayListRoute() {
  const router = useRouter();
  const ctx = useAppContext();

  return (
    <GatewayListScreen
      onBack={() => {
        ctx.setSessionRefreshKey((k) => k + 1);
        router.back();
      }}
      onAddGateway={() => {
        ctx.setSessionRefreshKey((k) => k + 1);
        router.back();
        setTimeout(() => ctx.setConnectionSheetVisible(true), 350);
      }}
      onGatewayChange={ctx.setGatewayBaseUrl}
    />
  );
}
