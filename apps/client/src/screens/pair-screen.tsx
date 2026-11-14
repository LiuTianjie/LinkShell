import { CameraView, useCameraPermissions } from "expo-camera";
import { gatewayAddress } from "@/lib/gateway-address";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { usePageInsets } from "@/components/adaptive-page";
import { pairByCode, pairByLink } from "@linkshell/client-core";
import { decodePairingLink, type PairingLink } from "@linkshell/wire";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { DEFAULT_GATEWAY, relayFor, useComputers, dropRelayIfUnused } from "@/lib/computers";
import { useContentWidth } from "@/lib/content-width";
import { haptics } from "@/lib/haptics";
import { deviceIdentity } from "@/lib/identity";
import { SheetHeader } from "@/components/sheet-header";
import { colors } from "@/theme/colors";
import { mono, type, radius } from "@/theme/type";

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
  if (code === "machine_offline") return "电脑现在不在线，请确认电脑上的 LinkShell 正在运行，再重新运行 linkshell pair";
  if (code === "rate_limited") return "尝试太频繁了，请稍等一分钟";
  if (code === "offline" || code === "timeout" || code === "closed") return "连不上网关，请检查网络后再试";
  // What is left without a word of Chinese is a decoding error ("invalid base64"): the link itself is damaged.
  if (!/[\u4e00-\u9fff]/.test(message)) return "二维码或链接的内容不完整，请在电脑上重新运行 linkshell pair";
  return message;
}

/** A failure the same code can get past by itself (the network), unlike a code that is wrong or used up. */
function transient(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "offline" || code === "timeout" || code === "closed" || code === "rate_limited" || code === "machine_offline";
}


/**
 * Add a computer: scan the QR from `linkshell pair` (or open its link from
 * the system camera), or type the code it shows.
 */
export function PairScreen() {
  const params = useLocalSearchParams<{ g?: string; k?: string; s?: string; c?: string }>();
  const insets = usePageInsets();
  const parentWidth = useContentWidth();
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  // A form sheet can be much shorter than the physical screen after rotation.
  const cameraSize = Math.max(1, Math.min((viewport?.width ?? parentWidth) - 32, 320, Math.max(150, (viewport?.height ?? 500) * 0.45)));
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

  // The QR code that just failed for good, and the last thing scanned that isn't a pairing code:
  // the camera sees the same picture many times a second, and each is answered once.
  const refused = useRef<string | null>(null);
  const notPairing = useRef<string | null>(null);
  const runLink = useCallback(
    async (link: PairingLink, scanned?: string) => {
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
        // A code that is wrong or used up stays so however often it is scanned (and each try
        // counts against the gateway's limit): wait for another one. The network may come back.
        if (scanned && !transient(reason)) refused.current = scanned;
        dropRelayIfUnused(link.gateway);
        setTimeout(() => (handled.current = false), transient(reason) ? 5000 : 1500);
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
    const address = gatewayAddress(gateway);
    if (!address) {
      haptics.error();
      setError("网关地址格式不对，例如 wss://gateway.example.com");
      return;
    }
    setError(null);
    setBusy("正在配对…");
    try {
      const machine = await pairByCode(relayFor(address), deviceIdentity(), digits);
      finish(address, machine);
    } catch (reason) {
      dropRelayIfUnused(address);
      haptics.error();
      setError(friendly(reason));
      setBusy(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.sheet }}>
      <SheetHeader title="添加电脑" />

      <KeyboardAwareScrollView
        contentInsetAdjustmentBehavior="never"
        onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setViewport({ width, height }); }}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: insets.bottom + 24, gap: 18 }}
      >
        <Text style={[type.subhead, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
          在电脑的终端里运行 <Text style={{ fontFamily: mono, color: colors.label }}>linkshell pair</Text>，扫描出现的二维码。
        </Text>

        {/* A live viewfinder when the camera is ours; otherwise a quiet card, not a black void. */}
        <View
          style={{
            width: permission?.granted ? cameraSize : "100%",
            height: permission?.granted ? cameraSize : undefined,
            alignSelf: "center",
            borderRadius: permission?.granted ? radius.panel : radius.card,
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
                        if (data === refused.current || data === notPairing.current) return;
                        const link = decodePairingLink(data);
                        if (link) void runLink(link, data);
                        else {
                          notPairing.current = data;
                          haptics.error();
                          setError("这不是 LinkShell 的配对二维码，请扫描电脑上 linkshell pair 显示的二维码");
                        }
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
          <View style={{ flexDirection: "row", gap: 8, padding: 12, borderRadius: radius.control, backgroundColor: colors.dangerSoft }}>
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
              borderRadius: radius.card,
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
              style={[type.subhead, { fontFamily: mono, color: colors.label, backgroundColor: colors.sheetCard, borderRadius: radius.control, paddingHorizontal: 12, paddingVertical: 10 }]}
            />
          ) : (
            <Pressable onPress={() => setEditingGateway(true)} accessibilityRole="button" accessibilityLabel="更改配对网关" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", minHeight: 44, gap: 6, paddingHorizontal: 4, paddingVertical: 10 }}>
              <Text style={[type.footnote, { flexShrink: 1, color: colors.tertiaryLabel }]}>网关 {hostOf(gateway)}</Text>
              <Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>更改</Text>
            </Pressable>
          )}
        </View>

        <Pressable
          onPress={() => router.push("/connect")}
          accessibilityRole="button"
          accessibilityLabel="通过局域网直接连接电脑"
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", minHeight: 44, gap: 6, paddingVertical: 10 }}
        >
          <Icon sf="wifi" md="wifi" size={13} color={colors.secondaryLabel} />
          <Text style={[type.footnote, { flexShrink: 1, color: colors.secondaryLabel, textAlign: "center" }]}>在同一个局域网里？直接连接</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}
