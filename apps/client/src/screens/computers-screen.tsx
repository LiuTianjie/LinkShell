import { router } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { usePageInsets } from "@/components/adaptive-page";
import { ComputerAction, ComputerSheetHeading } from "@/components/computer-controls";
import { ComputerList } from "@/components/computer-list";
import { useComputers } from "@/lib/computers";
import { useLocale } from "@/lib/locale";
import { sheetBottom } from "@/lib/sheet-bottom";
import { colors } from "@/theme/colors";

export function ComputersScreen() {
  const { pick } = useLocale();
  const insets = usePageInsets();
  const [adding, setAdding] = useState(false);
  const leaving = useRef(false);
  const select = (key: string) => {
    if (leaving.current) return;
    leaving.current = true;
    useComputers.getState().select(key);
    router.back();
  };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.sheet }}
      onAccessibilityEscape={() => router.back()}
      contentInsetAdjustmentBehavior="never"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingLeft: Math.max(16, insets.left + 16),
        paddingRight: Math.max(16, insets.right + 16),
        paddingBottom: sheetBottom(insets.bottom, { floating: true }),
      }}
    >
      <View collapsable={false}>
        <ComputerSheetHeading title={pick({ zh: "切换电脑", en: "Switch computer", ja: "コンピュータを切り替え" })} />
        <ComputerList onSelect={select} />
        <View
          style={{
            marginTop: 8,
            paddingHorizontal: 4,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: colors.separator,
          }}
        >
          <ComputerAction
            icon={{ sf: "plus.circle", md: "add_circle_outline" }}
            label={pick({ zh: "连接其他电脑", en: "Connect another computer", ja: "別のコンピュータを接続" })}
            expanded={adding}
            onPress={() => setAdding(!adding)}
          />
          {adding && (
            <>
              <ComputerAction
                label={pick({ zh: "局域网发现与直连", en: "Discover on LAN", ja: "LAN で検出・直接接続" })}
                icon={{ sf: "wifi", md: "wifi" }}
                onPress={() => router.replace("/connect")}
              />
              <ComputerAction
                label={pick({
                  zh: "扫码或输入配对码",
                  en: "Scan or enter a pairing code",
                  ja: "スキャンまたはコードでペアリング",
                })}
                icon={{ sf: "qrcode", md: "qr_code" }}
                onPress={() => router.replace("/pair")}
              />
            </>
          )}
        </View>
      </View>
    </ScrollView>
  );
}
