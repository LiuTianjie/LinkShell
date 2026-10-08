import type { PortInfo } from "@linkshell/wire";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { usePageInsets } from "@/components/adaptive-page";
import { Icon } from "@/components/icon";
import { openPreview, PortRow } from "@/components/port-row";
import { positionOf } from "@/components/session-row";
import { usePorts } from "@/lib/ports";
import { SheetHeader } from "@/components/sheet-header";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 7 }}>
      <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 16 }]}>{title}</Text>
      <View>{children}</View>
    </View>
  );
}

/** The computer's servers to preview; `cwd` (from a session) puts that project's first. */
export function PortsScreen() {
  const { cwd } = useLocalSearchParams<{ cwd?: string }>();
  const insets = usePageInsets();
  const { ports, error } = usePorts();
  const [typed, setTyped] = useState("");
  const typedPort = Number(typed);
  const valid = Number.isInteger(typedPort) && typedPort > 0 && typedPort < 65536;

  const web = useMemo(() => {
    const ours = (entry: PortInfo) => (cwd && entry.cwd && (entry.cwd === cwd || entry.cwd.startsWith(`${cwd}/`)) ? 0 : 1);
    return [...(ports ?? [])].sort((a, b) => ours(a) - ours(b));
  }, [ports, cwd]);

  const open = () => {
    if (!valid) return;
    router.back();
    openPreview(typedPort);
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title="预览" />
      <View style={{ flex: 1, overflow: "hidden" }}>
        <KeyboardAwareScrollView
        contentInsetAdjustmentBehavior="never"
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 24 }}
        >
          <Text style={[type.subhead, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
            电脑上正在运行的网页，经加密通道在手机上打开，热更新照常工作。
          </Text>

          {ports === null ? (
            error ? (
              <Text style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text>
            ) : (
              <ActivityIndicator color={colors.secondaryLabel} />
            )
          ) : web.length ? (
            <Section title="网页服务">
              {web.map((entry, index) => (
                <PortRow key={entry.port} entry={entry} position={positionOf(index, web.length)} />
              ))}
            </Section>
          ) : (
            <View style={{ alignItems: "center", gap: 6, paddingVertical: 12 }}>
              <Icon sf="globe" md="language" size={28} color={colors.tertiaryLabel} />
              <Text style={[type.subhead, { color: colors.secondaryLabel }]}>没有发现正在运行的网页</Text>
              <Text style={[type.footnote, { color: colors.tertiaryLabel, textAlign: "center" }]}>
                在电脑上运行 npm run dev 之类的命令，就会出现在这里
              </Text>
            </View>
          )}

          <Section title="输入端口">
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingLeft: 16,
                paddingRight: 6,
                minHeight: 52,
                paddingVertical: 4,
                flexWrap: "wrap",
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: colors.sheetCard,
              }}
            >
              <Text style={{ flexShrink: 1, fontFamily: mono, fontSize: 16, color: colors.secondaryLabel }}>localhost:</Text>
              <TextInput
                value={typed}
                onChangeText={(text) => setTyped(text.replace(/\D/g, "").slice(0, 5))}
                placeholder="3000"
                placeholderTextColor={colors.placeholder as string}
                keyboardType="number-pad"
                returnKeyType="go"
                onSubmitEditing={open}
                style={{ flex: 1, minWidth: 72, minHeight: 44, fontFamily: mono, fontSize: 16, color: colors.label, paddingVertical: 10 }}
              />
              <Pressable
                onPress={open}
                disabled={!valid}
                accessibilityRole="button"
                accessibilityLabel="打开"
                style={{
                  minHeight: 44,
                  paddingVertical: 10,
                  paddingHorizontal: 16,
                  borderRadius: 14,
                  backgroundColor: colors.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: valid ? 1 : 0.4,
                }}
              >
                <Text style={[type.subhead, { color: colors.onAccent, fontWeight: "600" }]}>打开</Text>
              </Pressable>
            </View>
          </Section>

        </KeyboardAwareScrollView>
      </View>
    </View>
  );
}
