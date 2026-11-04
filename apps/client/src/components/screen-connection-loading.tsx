import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { Text } from "./fixed-text";
import { Button } from "./button";
import brandColors from "@/theme/brand-colors.json";
import { radius, type } from "@/theme/type";

// The screen page is black in both appearances: the dark half of each pair.
const ACCENT = brandColors.accent[1];
const SECONDARY = brandColors.secondaryLabel[1];
const TERTIARY = brandColors.tertiaryLabel[1];

export function ScreenConnectionLoading({ preparing, onRetry, top, bottom }: {
  preparing: boolean;
  onRetry: () => void;
  top: number;
  bottom: number;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingTop: top + 28, paddingBottom: bottom + 48 }}>
      <View style={{ width: "100%", maxWidth: 340, alignItems: "center" }}>
        <View accessible={false} style={{ alignItems: "center", marginBottom: 28 }}>
          {/* Connecting is a spinner, as everywhere a link is being made. */}
          <View style={{ width: 96, height: 60, borderWidth: 1, borderColor: TERTIARY, borderRadius: radius.control, borderCurve: "continuous", alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={SECONDARY} />
          </View>
          <View style={{ width: 1, height: 9, backgroundColor: TERTIARY }} />
          <View style={{ width: 26, height: 1, backgroundColor: TERTIARY }} />
        </View>
        <View accessibilityLiveRegion="polite" style={{ alignItems: "center", gap: 10 }}>
          <Text style={[type.headline, { color: "#f4f4f7" }]}>{preparing ? "正在准备屏幕" : "正在连接电脑"}</Text>
          <Text style={[type.footnote, { color: SECONDARY, textAlign: "center" }]}>
            {slow ? "这次连接耗时较长。可以继续等待，或重新连接。" : preparing ? "电脑已响应，正在打开画面。" : "正在建立屏幕连接，画面会自动显示。"}
          </Text>
        </View>
        <View accessible={false} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 24 }}>
          <Text style={[type.caption, { color: preparing ? SECONDARY : ACCENT }]}>连接电脑</Text>
          <View style={{ width: 24, height: 1, backgroundColor: "rgba(255,255,255,0.12)" }} />
          <Text style={[type.caption, { color: preparing ? ACCENT : TERTIARY }]}>接收画面</Text>
          <View style={{ width: 24, height: 1, backgroundColor: "rgba(255,255,255,0.12)" }} />
          <Text style={[type.caption, { color: TERTIARY }]}>显示桌面</Text>
        </View>
        {slow ? <View style={{ marginTop: 22 }}><Button title="重新连接" variant="tonal" size="small" onPress={onRetry} /></View> : null}
      </View>
    </ScrollView>
  );
}
