import type { PendingPermissionSummary } from "@linkshell/wire";
import { permissionContent } from "@linkshell/client-core";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { DiffStat } from "./diff-stat";
import { Text } from "./fixed-text";
import { Icon } from "./icon";
import { Markdown } from "./markdown";
import { DiffView } from "./timeline/tool-call";
import { fileChanges } from "@/lib/describe";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";

/** Compact prev/next pager shown when a session has multiple pending permissions. */
export function PermissionPager({
  index,
  total,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (total <= 1) return null;
  const canPrev = index > 0;
  const canNext = index < total - 1;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Pressable
        onPress={() => {
          if (!canPrev) return;
          haptics.selection();
          onPrev();
        }}
        disabled={!canPrev}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="上一条待处理请求"
        style={({ pressed }) => ({
          width: 26,
          height: 26,
          borderRadius: 13,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.fill,
          opacity: !canPrev ? 0.35 : pressed ? 0.6 : 1,
        })}
      >
        <Icon sf="chevron.left" md="chevron_left" size={12} color={colors.label} weight="semibold" />
      </Pressable>
      <Text style={[type.caption, { color: colors.waiting, fontWeight: "600", fontVariant: ["tabular-nums"], minWidth: 34, textAlign: "center" }]}>
        {index + 1} / {total}
      </Text>
      <Pressable
        onPress={() => {
          if (!canNext) return;
          haptics.selection();
          onNext();
        }}
        disabled={!canNext}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="下一条待处理请求"
        style={({ pressed }) => ({
          width: 26,
          height: 26,
          borderRadius: 13,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.fill,
          opacity: !canNext ? 0.35 : pressed ? 0.6 : 1,
        })}
      >
        <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.label} weight="semibold" />
      </Pressable>
    </View>
  );
}

/** The exact operation is visible before the user chooses an approval option. */
export function PermissionContext({ request }: { request: PendingPermissionSummary }) {
  const tool = request.tool;
  const body = permissionContent(request);
  const input = body.rawInput === undefined ? undefined : typeof body.rawInput === "string" ? body.rawInput : JSON.stringify(body.rawInput, null, 2);
  return <View style={{ gap: 10 }}>
    {body.detail ? <PermissionDetail key={request.requestId} detail={body.detail} /> : null}
    {body.markdown ? <Markdown text={body.markdown} /> : null}
    {request.url ? <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.fill }}><Icon sf="globe" md="language" size={18} color={colors.accent} /><View style={{ flex: 1, gap: 3 }}><Text style={[type.caption, { color: colors.secondaryLabel }]}>授权页面</Text><Text selectable style={[type.footnote, { color: colors.label }]}>{request.url.url}</Text></View></View> : null}
    {tool?.locations?.map((location, index) => <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}><Icon sf="doc.text" md="description" size={15} color={colors.tertiaryLabel} /><Text selectable style={[type.caption, { flex: 1, color: colors.secondaryLabel }]}>{location.path}{location.line === undefined ? "" : `:${location.line}`}</Text></View>)}
    {input || body.content.length ? <View style={{ borderRadius: radius.control, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.code }}><View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", gap: 8, alignItems: "center" }}><Icon sf="text.alignleft" md="notes" size={14} color={colors.secondaryLabel} /><Text style={[type.caption, { color: colors.secondaryLabel, fontWeight: "500" }]}>操作详情</Text></View><ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled contentContainerStyle={{ gap: 12, padding: 12, paddingTop: 2 }}>
      {input ? <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.codeText }}>{input.slice(0, 12000)}{input.length > 12000 ? "\n… 内容较长，已显示前半部分" : ""}</Text> : null}
      {body.content.map((content, index) => {
        if (content.type === "diff" || content.type === "patch") {
          const [change] = fileChanges([content]);
          if (change) {
            return (
              <View key={index} style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text selectable style={[type.caption, { flex: 1, color: colors.secondaryLabel }]}>{change.path}</Text>
                  <Text style={[type.caption, { fontVariant: ["tabular-nums"] }]}><DiffStat added={change.added} removed={change.removed} /></Text>
                </View>
                {change.lines.length ? (
                  <DiffView change={change} maxLines={200} />
                ) : (
                  <Text style={[type.caption, { color: colors.tertiaryLabel }]}>内容无行级差异</Text>
                )}
              </View>
            );
          }
        }
        return (
          <View key={index} style={{ gap: 4 }}>
            {content.type === "content" && content.content.type === "text" ? <Text selectable style={[type.footnote, { color: colors.codeText }]}>{content.content.text.slice(0, 12000)}</Text> : null}
          </View>
        );
      })}
    </ScrollView></View> : null}
  </View>;
}

function PermissionDetail({ detail }: { detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textStyle = { fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.codeText };
  return (
    <View style={{ backgroundColor: colors.code, borderRadius: radius.control, borderCurve: "continuous", padding: 10, overflow: "hidden" }}>
      {/* Measure the full text at the same width so wrapped lines also offer expansion. */}
      <Text
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        onTextLayout={(event) => setOverflows(event.nativeEvent.lines.length > 6)}
        style={[textStyle, { position: "absolute", top: 10, left: 10, right: 10, opacity: 0 }]}
      >
        {detail}
      </Text>
      <Text selectable numberOfLines={expanded ? undefined : 6} style={textStyle}>{detail}</Text>
      {overflows ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}
        >
          <Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>{expanded ? "收起" : "展开完整内容"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
