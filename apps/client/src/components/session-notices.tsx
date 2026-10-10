import { Pressable, View } from "react-native";
import { Text } from "./fixed-text";
import { Icon } from "./icon";
import { Glass } from "./glass";
import { useActions, useClient } from "@/lib/client";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function SessionNotices({ sessionId }: { sessionId: string }) {
  const notices = useClient((state) => state.notices[sessionId]);
  const { dismissNotice } = useActions();
  return <>{notices?.map((notice) => <Glass key={notice.id} style={{ padding: 12, borderRadius: 18, gap: 3 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={[type.subhead, { flex: 1, color: notice.severity === "error" ? colors.danger : notice.severity === "warning" ? colors.waiting : colors.label, fontWeight: "600" }]}>{notice.title}</Text><Pressable onPress={() => dismissNotice(sessionId, notice.id)} accessibilityRole="button" accessibilityLabel="关闭提示" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon sf="xmark" md="close" size={12} /></Pressable></View>
    {notice.description ? <Text selectable style={[type.footnote, { color: colors.secondaryLabel }]}>{notice.description}</Text> : null}
  </Glass>)}</>;
}
