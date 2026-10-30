import * as Clipboard from "expo-clipboard";
import { Link, router } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Button } from "./button";
import { Icon } from "./icon";
import { EmptyState, LoadingState } from "./state-views";
import { useAccount } from "@/lib/account";
import { useConnectionRecovering } from "@/lib/client";
import { listComputers, retryComputerDiscovery, useComputerDiscovery, useComputers } from "@/lib/computers";

const SETUP = "npm i -g linkshell-cli\nlinkshell host --daemon";

const DESKTOP_INSTALL = "https://liutianjie.github.io/LinkShell/#install";

/** Onboarding only after the account's computer list has finished restoring. */
export function Welcome() {
  const discovery = useComputerDiscovery();
  const recovering = useConnectionRecovering();
  const account = useAccount((state) => state.session);
  const discovered = useComputers((state) => listComputers(state).length > 0);
  if (discovered || discovery === "loading" || (discovery === "failed" && recovering)) return <LoadingState label="正在恢复电脑列表…" />;
  if (discovery === "failed" || discovery === "refused") return (
    <View style={{ gap: 8 }}>
      <EmptyState icon={{ sf: "wifi.exclamationmark", md: "wifi_off" }} title={discovery === "refused" ? "需要检查连接设置" : "暂时无法读取电脑列表"} message={discovery === "refused" ? "连接被拒绝，请在「账号与电脑」中检查账号或配对状态后重试。" : "账号仍保留在这台手机上。连接恢复后，会自动显示你的电脑。"} action={{ title: "重新连接", onPress: retryComputerDiscovery }} />
      <Button title="账号与电脑" variant="plain" onPress={() => router.push("/account")} />
    </View>
  );
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
          Agent 在你的电脑上运行，LinkShell 让你在手机上继续。先在电脑上安装桌面版或 CLI。
        </Text>
      </View>

      <View style={{ backgroundColor: colors.card, borderRadius: 18, borderCurve: "continuous", padding: 16, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon sf="desktopcomputer" md="desktop_windows" size={20} color={colors.label} />
          <Text style={[type.headline, { color: colors.label }]}>桌面版 · macOS / Windows</Text>
        </View>
        <Text style={[type.subhead, { color: colors.secondaryLabel }]}>下载安装后打开 LinkShell，登录账号或显示配对码，即可连接，无需另外配置运行环境。</Text>
        <Link href={DESKTOP_INSTALL} asChild>
          <Pressable accessibilityRole="link" accessibilityLabel="打开 LinkShell 桌面版安装引导" style={({ pressed }) => ({ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, opacity: pressed ? 0.6 : 1 })}>
            <Text style={[type.subhead, { color: colors.accent, fontWeight: "600" }]}>查看下载与安装引导</Text>
            <Icon sf="arrow.up.right" md="open_in_new" size={15} color={colors.accent} />
          </Pressable>
        </Link>
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
        <Text style={[type.headline, { color: colors.label }]}>CLI · 在电脑终端安装</Text>
        <Text selectable style={{ fontFamily: mono, fontSize: 13.5, lineHeight: 21, color: colors.label }}>
          {SETUP}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon sf="doc.on.doc" md="content_copy" size={12} color={colors.tertiaryLabel} />
          <Text style={[type.caption, { flex: 1, color: colors.tertiaryLabel }]}>轻点复制 · 需要 Node.js 22.13 或更新版本</Text>
        </View>
      </Pressable>

      <View style={{ gap: 10 }}>
        <Button title="扫码添加电脑" variant="primary" size="large" wide onPress={() => router.push("/pair")} />
        <Button title={account ? "账号与电脑" : "登录 Pro 账号"} variant="tonal" size="large" wide onPress={() => router.push("/account")} />
        <Text style={[type.footnote, { color: colors.tertiaryLabel, textAlign: "center", paddingHorizontal: 12 }]}>
          扫码：打开桌面版的配对码，或在电脑运行 linkshell pair。Pro：桌面版或 CLI 登录同一账号后，电脑自动出现。
        </Text>
      </View>
    </View>
  );
}
