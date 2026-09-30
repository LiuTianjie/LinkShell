import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pairByCode, pairByLink } from "@linkshell/client-core";
import { decodePairingLink, type PairingLink } from "@linkshell/wire";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { DEFAULT_GATEWAY, relayFor, useComputers } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { deviceIdentity } from "@/lib/identity";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^ws/, "http")).host;
  } catch {
    return url;
  }
}

function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  if (code === "pairing_expired") return "配对码不对或已过期，请在电脑上重新运行 linkshell pair";
  if (code === "pairing_refused") return "电脑拒绝了这次配对，请确认二维码或配对码是最新的";
  if (code === "machine_offline") return "电脑现在不在线";
  if (code === "rate_limited") return "尝试太频繁了，请稍等一分钟";
  if (code === "offline" || code === "timeout") return "连不上网关，请检查网络";
  return message;
}

/**
 * Add a computer: scan the QR from `linkshell pair` (or open its link from
 * the system camera), or type the code it shows.
 */
export function PairScreen() {
  const params = useLocalSearchParams<{ g?: string; k?: string; s?: string; c?: string }>();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState("");
  const [gateway, setGateway] = useState(DEFAULT_GATEWAY);
  const [editingGateway, setEditingGateway] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const finish = useCallback((gatewayUrl: string, machine: Parameters<ReturnType<typeof useComputers.getState>["addPaired"]>[1]) => {
    const computers = useComputers.getState();
    computers.select(computers.addPaired(gatewayUrl, machine));
    haptics.success();
    router.dismissAll();
    router.navigate("/");
  }, []);

  const runLink = useCallback(
    async (link: PairingLink) => {
      if (handled.current) return;
      handled.current = true;
      setError(null);
      setBusy(`正在连接 ${hostOf(link.gateway)}…`);
      try {
        const machine = await pairByLink(relayFor(link.gateway), deviceIdentity(), link);
        finish(link.gateway, machine);
      } catch (reason) {
        haptics.error();
        setError(friendly(reason));
        setBusy(null);
        // Let the camera try again after a moment.
        setTimeout(() => (handled.current = false), 1500);
      }
    },
    [finish],
  );

  // Opened from a link (system camera, or another app): pair straight away.
  useEffect(() => {
    if (params.g && params.k && params.s && params.c) {
      void runLink({ gateway: params.g, signKey: params.k, secret: params.s, code: params.c });
    }
  }, [params.g, params.k, params.s, params.c, runLink]);

  const runCode = async (digits: string) => {
    if (digits.length !== 6 || busy) return;
    setError(null);
    setBusy("正在配对…");
    try {
      const machine = await pairByCode(relayFor(gateway), deviceIdentity(), digits);
      finish(gateway, machine);
    } catch (reason) {
      haptics.error();
      setError(friendly(reason));
      setBusy(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.sheet }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 22, paddingBottom: 6 }}>
        <Text style={[type.title, { flex: 1, color: colors.label }]}>添加电脑</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="关闭"
          hitSlop={10}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="xmark" md="close" size={13} color={colors.secondaryLabel} weight="bold" />
        </Pressable>
      </View>

      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: insets.bottom + 24, gap: 18 }}
      >
        <Text style={[type.subhead, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
          在电脑的终端里运行 <Text style={{ fontFamily: mono, color: colors.label }}>linkshell pair</Text>，扫描出现的二维码。
        </Text>

        {/* A live viewfinder when the camera is ours; otherwise a quiet card, not a black void. */}
        <View
          style={{
            aspectRatio: permission?.granted ? 1 : undefined,
            borderRadius: permission?.granted ? 28 : 20,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: permission?.granted ? "#000000" : colors.sheetCard,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {permission?.granted ? (
            <>
              <CameraView
                style={{ position: "absolute", inset: 0 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={
                  busy
                    ? undefined
                    : ({ data }) => {
                        const link = decodePairingLink(data);
                        if (link) void runLink(link);
                      }
                }
              />
              {/* Viewfinder corners */}
              <View pointerEvents="none" style={{ width: "62%", aspectRatio: 1 }}>
                {(["tl", "tr", "bl", "br"] as const).map((corner) => (
                  <View
                    key={corner}
                    style={{
                      position: "absolute",
                      width: 34,
                      height: 34,
                      borderColor: "#ffffff",
                      borderTopWidth: corner[0] === "t" ? 4 : 0,
                      borderBottomWidth: corner[0] === "b" ? 4 : 0,
                      borderLeftWidth: corner[1] === "l" ? 4 : 0,
                      borderRightWidth: corner[1] === "r" ? 4 : 0,
                      borderTopLeftRadius: corner === "tl" ? 14 : 0,
                      borderTopRightRadius: corner === "tr" ? 14 : 0,
                      borderBottomLeftRadius: corner === "bl" ? 14 : 0,
                      borderBottomRightRadius: corner === "br" ? 14 : 0,
                      top: corner[0] === "t" ? 0 : undefined,
                      bottom: corner[0] === "b" ? 0 : undefined,
                      left: corner[1] === "l" ? 0 : undefined,
                      right: corner[1] === "r" ? 0 : undefined,
                    }}
                  />
                ))}
              </View>
            </>
          ) : (
            <View style={{ alignItems: "center", gap: 12, paddingHorizontal: 24, paddingVertical: 28 }}>
              <Icon sf="qrcode.viewfinder" md="qr_code_scanner" size={36} color={colors.accent} />
              <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
                {permission && !permission.canAskAgain ? "相机权限被关闭了，请在系统设置里打开" : "扫码需要使用相机"}
              </Text>
              {permission?.canAskAgain !== false ? (
                <Button title="允许使用相机" variant="primary" onPress={() => void requestPermission()} />
              ) : (
                <Button title="打开设置" variant="tonal" onPress={() => void Linking.openSettings()} />
              )}
            </View>
          )}
          {busy ? (
            <View style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", gap: 12 }}>
              <ActivityIndicator color="#ffffff" />
              <Text style={[type.subhead, { color: "#ffffff" }]}>{busy}</Text>
            </View>
          ) : null}
        </View>

        {error ? (
          <View style={{ flexDirection: "row", gap: 8, padding: 12, borderRadius: 14, backgroundColor: colors.dangerSoft }}>
            <Icon sf="exclamationmark.triangle.fill" md="warning" size={15} color={colors.danger} />
            <Text style={[type.subhead, { flex: 1, color: colors.label }]}>{error}</Text>
          </View>
        ) : null}

        <View style={{ gap: 10 }}>
          <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 4 }]}>或输入配对码</Text>
          <TextInput
            value={code}
            onChangeText={(text) => {
              const digits = text.replace(/\D/g, "").slice(0, 6);
              setCode(digits);
              if (digits.length === 6) void runCode(digits);
            }}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="000 000"
            placeholderTextColor={colors.placeholder as string}
            editable={!busy}
            style={{
              fontFamily: mono,
              fontSize: 28,
              letterSpacing: 10,
              textAlign: "center",
              color: colors.label,
              backgroundColor: colors.sheetCard,
              borderRadius: 18,
              borderCurve: "continuous",
              paddingVertical: 14,
            }}
          />
          {editingGateway ? (
            <TextInput
              value={gateway}
              onChangeText={setGateway}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="wss://gateway.example.com"
              placeholderTextColor={colors.placeholder as string}
              style={[type.subhead, { fontFamily: mono, color: colors.label, backgroundColor: colors.sheetCard, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 }]}
            />
          ) : (
            <Pressable onPress={() => setEditingGateway(true)} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
              <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>网关 {hostOf(gateway)}</Text>
              <Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>更改</Text>
            </Pressable>
          )}
        </View>

        <Pressable
          onPress={() => router.push("/connect")}
          hitSlop={6}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 6 }}
        >
          <Icon sf="wifi" md="wifi" size={13} color={colors.secondaryLabel} />
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>在同一个局域网里？直接连接</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}
