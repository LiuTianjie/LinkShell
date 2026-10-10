import type { PendingPermissionSummary } from "@linkshell/wire";
import { ScrollView, View } from "react-native";
import { Text } from "./fixed-text";
import { Icon } from "./icon";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";

/** The exact operation is visible before the user chooses an approval option. */
export function PermissionContext({ request }: { request: PendingPermissionSummary }) {
  const tool = request.tool;
  const input = tool?.rawInput === undefined ? undefined : typeof tool.rawInput === "string" ? tool.rawInput : JSON.stringify(tool.rawInput, null, 2);
  return <View style={{ gap: 10 }}>
    {request.url ? <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: radius.control, backgroundColor: colors.fill }}><Icon sf="globe" md="language" size={18} color={colors.accent} /><View style={{ flex: 1, gap: 3 }}><Text style={[type.caption, { color: colors.secondaryLabel }]}>授权页面</Text><Text selectable style={[type.footnote, { color: colors.label }]}>{request.url.url}</Text></View></View> : null}
    {tool?.locations?.map((location, index) => <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><Icon sf="doc.text" md="description" size={15} color={colors.tertiaryLabel} /><Text selectable style={[type.caption, { flex: 1, color: colors.secondaryLabel }]}>{location.path}{location.line === undefined ? "" : `:${location.line}`}</Text></View>)}
    {input || tool?.content?.length ? <View style={{ borderRadius: radius.control, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.code }}><View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", gap: 8, alignItems: "center" }}><Icon sf="text.alignleft" md="notes" size={14} color={colors.secondaryLabel} /><Text style={[type.caption, { color: colors.secondaryLabel, fontWeight: "500" }]}>操作详情</Text></View><ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled contentContainerStyle={{ gap: 12, padding: 12, paddingTop: 2 }}>
      {input ? <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.codeText }}>{input.slice(0, 12000)}{input.length > 12000 ? "\n… 内容较长，已显示前半部分" : ""}</Text> : null}
      {tool?.content?.map((content, index) => <View key={index} style={{ gap: 4 }}>
        {content.type === "diff" ? <><Text selectable style={[type.caption, { color: colors.secondaryLabel }]}>{content.path}</Text>{content.oldText ? <View style={{ padding: 10, borderRadius: 8, backgroundColor: colors.diffDel }}><Text style={[type.caption2, { color: colors.diffDelText, marginBottom: 4 }]}>修改前</Text><Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.diffDelText }}>{content.oldText.slice(0, 6000)}</Text></View> : null}<View style={{ padding: 10, borderRadius: 8, backgroundColor: colors.diffAdd }}><Text style={[type.caption2, { color: colors.diffAddText, marginBottom: 4 }]}>修改后</Text><Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.diffAddText }}>{content.newText.slice(0, 6000)}</Text></View></>
          : content.type === "patch" ? <Text selectable style={{ fontFamily: mono, fontSize: 12, color: colors.codeText }}>{content.path}{"\n"}{content.diff.slice(0, 12000)}</Text>
          : content.type === "content" && content.content.type === "text" ? <Text selectable style={[type.footnote, { color: colors.codeText }]}>{content.content.text.slice(0, 12000)}</Text> : null}
      </View>)}
    </ScrollView></View> : null}
  </View>;
}
