import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";

interface SettingsScreenProps {}

export function SettingsScreen(_props: SettingsScreenProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.bg }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.heroCard, { backgroundColor: theme.bgCard, borderColor: theme.border }]}> 
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>设置</Text>
        <Text style={[styles.heroTitle, { color: theme.text }]}>偏好与设备体验</Text>
        <Text style={[styles.heroBody, { color: theme.textSecondary }]}>这里管理外观模式、终端使用偏好和应用信息。</Text>
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgCard, borderColor: theme.border }]}> 
        <Text style={[styles.sectionTitle, { color: theme.text }]}>外观</Text>

        <View style={[styles.row, { borderBottomColor: theme.borderLight }]}> 
          <View style={styles.copyWrap}>
            <Text style={[styles.label, { color: theme.text }]}>主题模式</Text>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>在深色和浅色界面之间切换。</Text>
          </View>
          <Pressable
            style={[styles.toggleBtn, { backgroundColor: theme.bgInput, borderColor: theme.border }]}
            onPress={toggleTheme}
          >
            <Text style={[styles.toggleText, { color: theme.text }]}> 
              {theme.mode === "dark" ? "深色" : "浅色"}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgCard, borderColor: theme.border }]}> 
        <Text style={[styles.sectionTitle, { color: theme.text }]}>关于</Text>
        <View style={styles.infoGroup}>
          <Text style={[styles.label, { color: theme.text }]}>LinkShell v0.1.0</Text>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>面向 AI 编码代理的移动端远程终端应用。</Text>
          <Text style={[styles.subtle, { color: theme.textTertiary }]}>当前版本以 Expo 为基础，重点优化 iPhone 安全区、终端工作区和移动端操作流。</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, gap: 16 },
  heroCard: {
    borderRadius: 28,
    borderWidth: 1,
    padding: 22,
    gap: 10,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  heroTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800",
  },
  heroBody: { fontSize: 14, lineHeight: 20 },
  card: {
    borderRadius: 24, borderWidth: 1, padding: 18, gap: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: "700" },
  row: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12,
    paddingVertical: 6,
  },
  copyWrap: { flex: 1, gap: 4 },
  label: { fontSize: 15, fontWeight: "600" },
  hint: { fontSize: 13, lineHeight: 18 },
  subtle: { fontSize: 12, lineHeight: 18 },
  infoGroup: { gap: 6 },
  toggleBtn: {
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8,
  },
  toggleText: { fontSize: 13, fontWeight: "600" },
});
