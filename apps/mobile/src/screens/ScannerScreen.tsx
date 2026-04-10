import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { CameraView, useCameraPermissions, scanFromURLAsync } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { parsePairingLink } from "../utils/pairing-link";

interface ScannerScreenProps {
  onClose: () => void;
  onScan: (payload: { code: string; gateway?: string }) => void;
}

export function ScannerScreen({ onClose, onScan }: ScannerScreenProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const scannedRef = React.useRef(false);
  const insets = useSafeAreaInsets();

  const permissionState = useMemo(() => {
    if (!permission) return "loading" as const;
    if (permission.granted) return "granted" as const;
    return "denied" as const;
  }, [permission]);

  const handleBarcodeScanned = useCallback((result: BarcodeScanningResult) => {
    if (scannedRef.current) return;
    scannedRef.current = true;

    console.log('[LinkShell] Scanned raw:', result.data);
    const parsed = parsePairingLink(result.data);
    if (!parsed) {
      console.warn('[LinkShell] QR parse failed for:', result.data);
      setScanned(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError("当前二维码不是 LinkShell 配对二维码。请在 CLI 中重新生成。");
      return;
    }

    console.log('[LinkShell] Parsed QR:', JSON.stringify(parsed));
    setScanned(true);
    setError(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onScan(parsed);
  }, [onScan]);

  const handlePickImage = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const scannedResults = await scanFromURLAsync(result.assets[0].uri, ["qr"]);
      if (!scannedResults || scannedResults.length === 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError("未在图片中检测到二维码。");
        setScanned(true);
        return;
      }

      const data = scannedResults[0]!.data;
      const parsed = parsePairingLink(data);
      if (!parsed) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError("当前二维码不是 LinkShell 配对二维码。");
        setScanned(true);
        return;
      }

      setScanned(true);
      setError(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onScan(parsed);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError("读取图片失败，请重试。");
      setScanned(true);
    }
  }, [onScan]);

  const handleTryAgain = useCallback(() => {
    setError(null);
    setScanned(false);
    scannedRef.current = false;
  }, []);

  if (permissionState === "loading") {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", gap: 12 }}>
        <ActivityIndicator size="small" color="#ffffff" />
        <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 15 }}>正在准备摄像头…</Text>
      </View>
    );
  }

  if (permissionState === "denied") {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <View style={{
          width: "100%",
          borderRadius: 14,
          borderCurve: "continuous",
          padding: 24,
          backgroundColor: "#1c1c1e",
          alignItems: "center",
          gap: 12,
        }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,149,0,0.15)", alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
            <AppSymbol name="camera.fill" size={26} color="#ff9500" />
          </View>
          <Text style={{ color: "#ffffff", fontSize: 20, fontWeight: "600", textAlign: "center" }}>需要摄像头权限</Text>
          <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 15, lineHeight: 21, textAlign: "center" }}>用于扫描终端展示的配对二维码。</Text>
          <Pressable
            style={({ pressed }) => ({
              marginTop: 4,
              width: "100%",
              minHeight: 50,
              borderRadius: 12,
              borderCurve: "continuous" as const,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? "#0064d2" : "#007aff",
            })}
            onPress={requestPermission}
          >
            <Text style={{ color: "#ffffff", fontSize: 17, fontWeight: "600" }}>继续</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <View style={{ flex: 1 }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={handleBarcodeScanned}
        />

        {/* Top bar */}
        <View style={{
          paddingTop: insets.top + 8,
          paddingBottom: 12,
          paddingHorizontal: 16,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: "rgba(0,0,0,0.3)",
        }}>
          <Pressable
            style={({ pressed }) => ({
              width: 32, height: 32, borderRadius: 16,
              backgroundColor: pressed ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.18)",
              alignItems: "center", justifyContent: "center",
            })}
            onPress={onClose}
            hitSlop={8}
          >
            <AppSymbol name="xmark" size={12} color="#ffffff" />
          </Pressable>
          <Text style={{ color: "#ffffff", fontSize: 17, fontWeight: "600" }}>扫码连接</Text>
          <Pressable
            style={({ pressed }) => ({
              width: 32, height: 32, borderRadius: 16,
              backgroundColor: pressed ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.18)",
              alignItems: "center", justifyContent: "center",
            })}
            onPress={handlePickImage}
            hitSlop={8}
          >
            <AppSymbol name="photo" size={14} color="#ffffff" />
          </Pressable>
        </View>

        {/* Scan frame */}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }} pointerEvents="none">
          <View style={{
            width: 240, height: 240,
            borderRadius: 20,
            borderCurve: "continuous",
            borderWidth: 3,
            borderColor: "rgba(255,255,255,0.9)",
          }} />
          <Text style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, fontWeight: "500", marginTop: 16 }}>
            将配对二维码放入框内
          </Text>
        </View>

        {/* Bottom info */}
        <View style={{
          backgroundColor: "rgba(0,0,0,0.5)",
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 8,
          gap: 8,
        }}>
          {error ? (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <AppSymbol name="exclamationmark.triangle.fill" size={18} color="#ff453a" style={{ marginTop: 1 }} />
              <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, lineHeight: 20, flex: 1 }}>{error}</Text>
            </View>
          ) : (
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 20 }}>
              扫描成功后会自动填入配对码和网关地址。
            </Text>
          )}
          {scanned ? (
            <Pressable
              style={({ pressed }) => ({
                minHeight: 50,
                borderRadius: 12,
                borderCurve: "continuous" as const,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? "#0064d2" : "#007aff",
              })}
              onPress={handleTryAgain}
            >
              <Text style={{ color: "#ffffff", fontSize: 17, fontWeight: "600" }}>重新扫描</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}