import React from "react";
import { useRouter } from "expo-router";
import { useAppContext } from "../contexts/AppContext";
import { ScannerScreen } from "../screens/ScannerScreen";

export default function ScannerRoute() {
  const router = useRouter();
  const ctx = useAppContext();

  return (
    <ScannerScreen
      onClose={() => router.back()}
      onScan={(payload) => {
        router.back();
        ctx.handlePairingScanned(payload);
      }}
    />
  );
}
