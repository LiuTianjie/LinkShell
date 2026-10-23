import type { TimelineItem } from "@linkshell/client-core";
import type { ContentBlock } from "@linkshell/wire";
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import Animated, { cubicBezier } from "react-native-reanimated";
import { describeTool, type FileChange } from "@/lib/describe";
import { baseName, duration } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Icon } from "../icon";
import { Attachments } from "./attachments";
import { SubagentCard } from "./subagent";
import { WorkflowCard } from "../workflow";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

const MAX_OUTPUT_LINES = 80;

function mediaOf(item: ToolItem): ContentBlock[] {
  return item.content.flatMap((entry) =>
    entry.type === "content" && entry.content.type !== "text" ? [entry.content] : [],
  );
}

/** CUA screenshots stay available in history without duplicating the floating preview. */
function isComputerUse(item: ToolItem): boolean {
  if (item.detail?.type === "mcp") return ["cua_repl", "computer-use", "computer_use"].includes(item.detail.server);
  return /^(?:mcp__)?(?:cua_repl|computer[-_]use)(?:__|[. ·])/.test(item.title);
}

/** Tool inputs worth showing when the row's subject doesn't already say it all. */
function paramsOf(item: ToolItem, subject: string): [string, string][] {
  if (item.toolKind === "execute" || item.toolKind === "edit" || item.toolKind === "delete" || item.toolKind === "move") return [];
  const input = item.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  if (item.detail?.type === "question") return questionParams(input as Record<string, unknown>);
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "") continue;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
    if (!text || text === subject || `“${text}”` === subject) continue;
    entries.push([key, text.length > 600 ? `${text.slice(0, 600)}…` : text]);
    if (entries.length === 8) break;
  }
  return entries;
}

/** Claude's AskUserQuestion, read as what it asks: each question and its options, not its JSON. */
function questionParams(input: Record<string, unknown>): [string, string][] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((raw, index): [string, string][] => {
    const question = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (typeof question.question !== "string") return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((entry) => {
      const option = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      if (typeof option.label !== "string") return [];
      return [`· ${option.label}${typeof option.description === "string" && option.description ? `：${option.description}` : ""}`];
    });
    const header = typeof question.header === "string" && question.header ? question.header : `问题 ${index + 1}`;
    return [[`${header}${question.multiSelect === true ? "（可多选）" : ""}`, [question.question, ...options].join("\n")]];
  });
}

function exitCodeOf(item: ToolItem): number | undefined {
  const raw = item.rawOutput as Record<string, unknown> | undefined;
  return raw && typeof raw.exitCode === "number" && raw.exitCode !== 0 ? raw.exitCode : undefined;
}

function outputOf(item: ToolItem): string {
  if (item.output) return item.output;
  const text = item.content
    .map((entry) => (entry.type === "content" && entry.content.type === "text" ? entry.content.text : ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  const raw = item.rawOutput as Record<string, unknown> | string | undefined;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["output", "stdout", "aggregated_output", "formatted_output", "content"]) {
      if (typeof raw[key] === "string" && raw[key]) return raw[key] as string;
    }
  }
  return "";
}

function tail(text: string): { text: string; hidden: number } {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= MAX_OUTPUT_LINES) return { text: lines.join("\n"), hidden: 0 };
  return { text: lines.slice(-MAX_OUTPUT_LINES).join("\n"), hidden: lines.length - MAX_OUTPUT_LINES };
}

export function DiffView({
  change,
  maxLines = 200,
  lineComments,
  onPressLine,
}: {
  change: FileChange;
  maxLines?: number;
  lineComments?: Record<number, string>;
  onPressLine?: (lineIndex: number, lineText: string) => void;
}) {
  const lines = change.lines.slice(0, maxLines);
  return (
    <View style={{ backgroundColor: colors.code, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: "100%" }}>
        <View style={{ paddingVertical: 6, minWidth: "100%" }}>
          {lines.map((line, index) => {
            if (line === "@@") {
              return (
                <Text key={index} style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.tertiaryLabel, paddingHorizontal: 10 }}>
                  ⋯
                </Text>
              );
            }
            const sign = line[0];
            const added = sign === "+";
            const removed = sign === "-";
            const comment = lineComments?.[index];
            const rowText = (
              <Text
                selectable={!onPressLine}
                style={{
                  fontFamily: mono,
                  fontSize: 12,
                  lineHeight: 18,
                  paddingHorizontal: 10,
                  color: added ? colors.diffAddText : removed ? colors.diffDelText : colors.codeText,
                  backgroundColor: comment ? colors.accentSoft : added ? colors.diffAdd : removed ? colors.diffDel : undefined,
                }}
              >
                {added ? "+ " : removed ? "− " : "  "}
                {line.slice(1) || " "}
              </Text>
            );
            if (!onPressLine) return <View key={index}>{rowText}</View>;
            return (
              <View key={index}>
                <Pressable
                  onPress={() => {
                    haptics.selection();
                    onPressLine(index, line);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`批注代码行：${line.slice(1).trim() || "空行"}`}
                >
                  {rowText}
                </Pressable>
                {comment ? (
                  <Pressable
                    onPress={() => {
                      haptics.selection();
                      onPressLine(index, line);
                    }}
                    style={{
                      marginHorizontal: 10,
                      marginVertical: 4,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 10,
                      backgroundColor: colors.accentSoft,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <Icon sf="text.bubble.fill" md="comment" size={12} color={colors.accent} />
                    <Text style={[type.caption, { color: colors.accent, fontWeight: "600", flex: 1 }]}>
                      批注：{comment}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {change.lines.length > maxLines ? (
            <Text style={[type.caption, { color: colors.tertiaryLabel, paddingHorizontal: 10, paddingTop: 4 }]}>
              还有 {change.lines.length - maxLines} 行 · 在「改动」里查看全部
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

/** Width of the glyph column; bodies indent to the text after it. */
export const GLYPH = 18;

function StatusGlyph({ status }: { status: ToolItem["status"] }) {
  if (status === "in_progress" || status === "pending") return <ActivityIndicator size="small" color={colors.secondaryLabel} />;
  if (status === "failed") return <Icon sf="xmark.circle.fill" md="cancel" size={15} color={colors.danger} />;
  return null;
}

/** One tool call: a single quiet line that opens to show its output or diff. */
export const ToolCall = memo(function ToolCall({ item }: { item: ToolItem }) {
  if (item.detail?.type === "subagent" && item.detail.workflow) return <WorkflowCard item={item} />;
  if (item.detail?.type === "subagent" && item.detail.action === "spawn") return <SubagentCard item={item} />;
  return <ToolRow item={item} />;
});

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const described = describeTool(item);
  const output = outputOf(item);
  const running = item.status === "in_progress" || item.status === "pending";
  const failed = item.status === "failed";
  const media = mediaOf(item);
  const images = media.filter((block) => block.type !== "resource_link");
  const links = media.filter((block) => block.type === "resource_link");
  const collapsedImages = isComputerUse(item);
  const params = paramsOf(item, described.subject);
  const terminal = item.content.some((entry) => entry.type === "terminal");
  const exitCode = exitCodeOf(item);
  const hasBody = (collapsedImages && images.length > 0) || described.changes.length > 0 || !!output || links.length > 0 || params.length > 0 || (terminal && !output);
  const added = described.changes.reduce((sum, c) => sum + c.added, 0);
  const removed = described.changes.reduce((sum, c) => sum + c.removed, 0);
  const tone = failed ? colors.danger : running ? colors.running : colors.secondaryLabel;

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        disabled={!hasBody}
        onPress={() => {
          haptics.selection();
          setOpen((value) => !value);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${described.verb} ${described.subject}`}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }}
      >
        {/* A bare glyph, not a tile: a run of tool calls should read as lines, not a stack of boxes. */}
        <View style={{ width: GLYPH, alignItems: "center" }}>
          <Icon {...described.glyph} size={14} color={tone} weight="medium" />
        </View>
        <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.secondaryLabel }]}>
          {described.verb ? <Text style={{ color: running ? colors.label : colors.secondaryLabel }}>{described.verb} </Text> : null}
          <Text
            style={
              described.code
                ? { fontFamily: mono, fontSize: 13, color: colors.label }
                : { color: colors.label, fontWeight: "500" }
            }
          >
            {described.subject}
          </Text>
        </Text>
        {added || removed ? (
          <Text style={[type.footnote, { fontVariant: ["tabular-nums"], fontWeight: "600" }]}>
            <Text style={{ color: colors.diffAddText }}>+{added}</Text> <Text style={{ color: colors.diffDelText }}>−{removed}</Text>
          </Text>
        ) : exitCode !== undefined ? (
          <Text style={[type.footnote, { color: colors.danger, fontVariant: ["tabular-nums"] }]}>退出码 {exitCode}</Text>
        ) : item.endedTs && item.endedTs - item.ts >= 2000 ? (
          <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>{duration(item.endedTs - item.ts)}</Text>
        ) : null}
        {exitCode === undefined ? <StatusGlyph status={item.status} /> : null}
        {hasBody && !running ? (
          <Animated.View
            style={{
              transform: [{ rotate: open ? "90deg" : "0deg" }],
              transitionProperty: "transform",
              transitionDuration: "180ms",
              transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
            }}
          >
            <Icon sf="chevron.right" md="chevron_right" size={11} color={colors.tertiaryLabel} weight="semibold" />
          </Animated.View>
        ) : null}
      </Pressable>

      {images.length > 0 && (!collapsedImages || open) ? (
        <View style={{ marginLeft: GLYPH + 8 }}>
          <Attachments blocks={images} thumb={96} />
        </View>
      ) : null}

      {open ? (
        <View style={{ marginLeft: GLYPH + 8, gap: 8 }}>
          {params.length ? <ParamsBlock entries={params} prose={item.detail?.type === "question"} /> : null}
          {described.changes.map((change) => (
            <View key={change.path} style={{ gap: 4 }}>
              {described.changes.length > 1 ? (
                <Text style={[type.caption, { color: colors.secondaryLabel, fontWeight: "600" }]}>{baseName(change.path)}</Text>
              ) : null}
              <DiffView change={change} maxLines={60} />
            </View>
          ))}
          {output && described.changes.length === 0 ? <OutputBlock text={output} /> : null}
          {terminal && !output ? (
            <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>输出在电脑的终端里</Text>
          ) : null}
          {links.length ? <Attachments blocks={links} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function ParamsBlock({ entries, prose }: { entries: [string, string][]; prose?: boolean }) {
  return (
    <View style={{ backgroundColor: colors.inset, borderRadius: 12, borderCurve: "continuous", paddingHorizontal: 12, paddingVertical: 9, gap: 7 }}>
      {entries.map(([key, value], index) => (
        <View key={`${index}:${key}`} style={{ gap: 1 }}>
          <Text style={[type.caption, { color: colors.tertiaryLabel, fontWeight: "600" }]}>{key}</Text>
          <Text selectable style={[type.footnote, { color: colors.label, fontFamily: !prose && (value.includes("\n") || value.startsWith("{") || value.startsWith("[")) ? mono : undefined }]}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function OutputBlock({ text }: { text: string }) {
  const { text: shown, hidden } = tail(text);
  return (
    <View style={{ backgroundColor: colors.code, borderRadius: 12, borderCurve: "continuous", paddingVertical: 8 }}>
      {hidden ? (
        <Text style={[type.caption, { color: colors.tertiaryLabel, paddingHorizontal: 10, paddingBottom: 4 }]}>
          前面还有 {hidden} 行
        </Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 18, color: colors.codeText, paddingHorizontal: 10 }}>
          {shown}
        </Text>
      </ScrollView>
    </View>
  );
}
