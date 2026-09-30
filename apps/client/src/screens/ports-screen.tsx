import type { PortInfo } from "@linkshell/wire";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/icon";
import { openPreview, PortRow } from "@/components/port-row";
import { positionOf } from "@/components/session-row";
import { usePorts } from "@/lib/ports";
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
  const insets = useSafeAreaInsets();
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
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 22, paddingBottom: 6 }}>
        <Text style={[type.title, { flex: 1, color: colors.label }]}>预览</Text>
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
      <View style={{ flex: 1, overflow: "hidden" }}>
        <KeyboardAwareScrollView
          bottomOffset={24}
          keyboardShouldPersistTaps="handled"
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
                height: 52,
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: colors.sheetCard,
              }}
            >
              <Text style={{ fontFamily: mono, fontSize: 16, color: colors.secondaryLabel }}>localhost:</Text>
              <TextInput
                value={typed}
                onChangeText={(text) => setTyped(text.replace(/\D/g, "").slice(0, 5))}
                placeholder="3000"
                placeholderTextColor={colors.placeholder as string}
                keyboardType="number-pad"
                returnKeyType="go"
                onSubmitEditing={open}
                style={{ flex: 1, fontFamily: mono, fontSize: 16, color: colors.label, paddingVertical: 0 }}
              />
              <Pressable
                onPress={open}
                disabled={!valid}
                accessibilityRole="button"
                accessibilityLabel="打开"
                style={{
                  height: 40,
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
