import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Button } from "./button";
import { Icon } from "./icon";

const SETUP = "npm i -g linkshell-cli\nlinkshell host --daemon";

/**
 * A new install, no computer yet: what to run on the computer, then the two
 * ways in (a pairing code, or a Pro account).
 */
export function Welcome() {
  return (
    <View style={{ paddingTop: 28, gap: 18 }}>
      <View style={{ alignItems: "center", gap: 10, paddingHorizontal: 12 }}>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            borderCurve: "continuous",
            backgroundColor: colors.accentSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon sf="laptopcomputer" md="laptop_mac" size={26} color={colors.accent} />
        </View>
        <Text style={[type.title3, { color: colors.label, textAlign: "center" }]}>连接你的电脑</Text>
        <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
          Agent 在你的电脑上运行，LinkShell 让你在手机上继续。先在电脑终端里运行：
        </Text>
      </View>

      <Pressable
        onPress={() => {
          void Clipboard.setStringAsync(SETUP);
          haptics.success();
        }}
        accessibilityRole="button"
        accessibilityLabel="复制安装命令"
        style={{ backgroundColor: colors.card, borderRadius: 18, borderCurve: "continuous", padding: 16, gap: 10 }}
      >
        <Text selectable style={{ fontFamily: mono, fontSize: 13.5, lineHeight: 21, color: colors.label }}>
          {SETUP}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon sf="doc.on.doc" md="content_copy" size={12} color={colors.tertiaryLabel} />
          <Text style={[type.caption, { color: colors.tertiaryLabel }]}>轻点复制 · 需要 Node.js 22.13 或更新版本</Text>
        </View>
      </Pressable>

      <View style={{ gap: 10 }}>
        <Button title="扫码添加电脑" variant="primary" size="large" wide onPress={() => router.push("/pair")} />
        <Button title="登录 Pro 账号" variant="tonal" size="large" wide onPress={() => router.push("/account")} />
        <Text style={[type.footnote, { color: colors.tertiaryLabel, textAlign: "center", paddingHorizontal: 12 }]}>
          扫码：在电脑上运行 linkshell pair。Pro：电脑上 linkshell login，登录同一账号后电脑自动出现。
        </Text>
      </View>
    </View>
  );
}
