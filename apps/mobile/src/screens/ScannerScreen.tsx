import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import { parsePairingLink } from "../utils/pairing-link";

interface ScannerScreenProps {
  onClose: () => void;
  onScan: (payload: { code: string; gateway?: string }) => void;
}

export function ScannerScreen({ onClose, onScan }: ScannerScreenProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);

  const permissionState = useMemo(() => {
    if (!permission) return "loading" as const;
    if (permission.granted) return "granted" as const;
    return "denied" as const;
  }, [permission]);

  const handleBarcodeScanned = useCallback((result: BarcodeScanningResult) => {
    if (scanned) return;

    const parsed = parsePairingLink(result.data);
    if (!parsed) {
      setScanned(true);
      setError("当前二维码不是 LinkShell 配对二维码。请在 CLI 中重新生成。");
      return;
    }

    setScanned(true);
    setError(null);
    onScan(parsed);
  }, [onScan, scanned]);

  const handleTryAgain = useCallback(() => {
    setError(null);
    setScanned(false);
  }, []);

  if (permissionState === "loading") {
    return (
      <SafeAreaView style={styles.centeredScreen}>
        <ActivityIndicator size="small" color="#93c5fd" />
        <Text style={styles.helperText}>正在准备摄像头...</Text>
      </SafeAreaView>
    );
  }

  if (permissionState === "denied") {
    return (
      <SafeAreaView style={styles.centeredScreen}>
        <View style={styles.permissionCard}>
          <Text style={styles.permissionTitle}>需要摄像头权限</Text>
          <Text style={styles.permissionText}>用于扫描终端展示的配对二维码。</Text>
          <Pressable style={styles.primaryButton} onPress={requestPermission}>
            <Text style={styles.primaryButtonText}>授权摄像头</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={onClose}>
            <Text style={styles.secondaryButtonText}>稍后再说</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.cameraLayer}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={handleBarcodeScanned}
        />

        <View style={styles.topOverlay}>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeText}>关闭</Text>
          </Pressable>
          <Text style={styles.title}>扫码连接</Text>
          <View style={styles.closeBtnPlaceholder} />
        </View>

        <View style={styles.frameWrap} pointerEvents="none">
          <View style={styles.frameCard}>
            <View style={styles.scanFrame} />
            <Text style={styles.frameHint}>将终端中显示的配对二维码放入框内</Text>
          </View>
        </View>

        <View style={styles.bottomOverlay}>
          <Text style={styles.tipTitle}>将二维码置于取景框内</Text>
          <Text style={styles.tipText}>扫描成功后会自动填入配对码和网关地址。</Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {scanned ? (
            <Pressable style={styles.primaryButton} onPress={handleTryAgain}>
              <Text style={styles.primaryButtonText}>重新扫描</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#000000",
  },
  cameraLayer: {
    flex: 1,
  },
  centeredScreen: {
    flex: 1,
    backgroundColor: "#0b1220",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 10,
  },
  helperText: {
    color: "#e5e7eb",
    fontSize: 15,
  },
  permissionCard: {
    width: "100%",
    borderRadius: 18,
    padding: 20,
    backgroundColor: "#111827",
    gap: 12,
  },
  permissionTitle: {
    color: "#f9fafb",
    fontSize: 21,
    fontWeight: "700",
  },
  permissionText: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 20,
  },
  topOverlay: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  closeBtn: {
    minHeight: 34,
    minWidth: 54,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  closeText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  closeBtnPlaceholder: {
    minWidth: 54,
  },
  title: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "700",
  },
  frameWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  frameCard: {
    width: "100%",
    alignItems: "center",
    gap: 14,
  },
  scanFrame: {
    width: 250,
    height: 250,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.95)",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  frameHint: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    fontWeight: "600",
  },
  bottomOverlay: {
    backgroundColor: "rgba(0,0,0,0.56)",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    gap: 8,
  },
  tipTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
  tipText: {
    color: "#d1d5db",
    fontSize: 14,
    lineHeight: 19,
  },
  errorText: {
    color: "#fecaca",
    fontSize: 13,
    lineHeight: 18,
  },
  primaryButton: {
    marginTop: 4,
    minHeight: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2563eb",
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  secondaryButtonText: {
    color: "#e5e7eb",
    fontSize: 15,
    fontWeight: "600",
  },
});