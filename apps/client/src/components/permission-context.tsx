import type { PendingPermissionSummary } from "@linkshell/wire";
import { ScrollView, View } from "react-native";
import { Text } from "./fixed-text";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

/** The exact operation is visible before the user chooses an approval option. */
export function PermissionContext({ request }: { request: PendingPermissionSummary }) {
  const tool = request.tool;
  const input = tool?.rawInput === undefined ? undefined : typeof tool.rawInput === "string" ? tool.rawInput : JSON.stringify(tool.rawInput, null, 2);
  return <View style={{ gap: 8 }}>
    {request.url ? <Text selectable style={[type.footnote, { color: colors.accent }]}>{request.url.url}</Text> : null}
    {tool?.locations?.map((location, index) => <Text key={index} selectable style={[type.caption, { color: colors.secondaryLabel }]}>{location.path}{location.line === undefined ? "" : `:${location.line}`}</Text>)}
    {input || tool?.content?.length ? <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled contentContainerStyle={{ gap: 8, padding: 10, backgroundColor: colors.code, borderRadius: 12 }}>
      {input ? <Text selectable style={{ fontFamily: mono, fontSize: 12, color: colors.codeText }}>{input.slice(0, 12000)}</Text> : null}
      {tool?.content?.map((content, index) => <View key={index} style={{ gap: 4 }}>
        {content.type === "diff" ? <><Text selectable style={[type.caption, { color: colors.secondaryLabel }]}>{content.path}</Text>{content.oldText ? <Text selectable style={{ fontFamily: mono, fontSize: 12, color: colors.diffDelText }}>{content.oldText.slice(0, 6000)}</Text> : null}<Text selectable style={{ fontFamily: mono, fontSize: 12, color: colors.diffAddText }}>{content.newText.slice(0, 6000)}</Text></>
          : content.type === "patch" ? <Text selectable style={{ fontFamily: mono, fontSize: 12, color: colors.codeText }}>{content.path}{"\n"}{content.diff.slice(0, 12000)}</Text>
          : content.type === "content" && content.content.type === "text" ? <Text selectable style={[type.footnote, { color: colors.codeText }]}>{content.content.text.slice(0, 12000)}</Text> : null}
      </View>)}
    </ScrollView> : null}
  </View>;
}
