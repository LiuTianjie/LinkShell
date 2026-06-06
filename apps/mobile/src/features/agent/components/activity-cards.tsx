import { memo, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { AppSymbol } from "../../../components/AppSymbol";
import type { Theme } from "../../../theme";
import {
  agentEventBorder,
  agentEventSurface,
  shortPath,
  toolStatusMeta,
} from "../lib/format";
import { commandLanguage, diffEntries, diffStats, humanizeCommand, looksLikeDiff } from "../lib/diff";
import {
  subagentDisplayName,
  subagentStatusLabel,
  subagentTitle,
} from "../lib/timeline";
import type { AgentSubagentAction, AgentToolCall } from "../types";
import { CodeBlock, DiffBlock } from "./content";

export const FileChangeCard = memo(function FileChangeCard({ tool, theme }: { tool: AgentToolCall; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const hasDiff = looksLikeDiff(output);
  const diffLineCount = output ? output.split("\n").length : 0;
  const stats = useMemo(() => hasDiff && output ? diffStats(output, input) : null, [hasDiff, input, output]);
  const entries = useMemo(() => output ? diffEntries(output, input) : diffEntries("", input), [input, output]);
  const meta = toolStatusMeta(tool.status, theme);
  const canExpand = Boolean(output || input);

  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
      }}
    >
      <Pressable
        onPress={() => canExpand && setExpanded((value) => !value)}
        disabled={!canExpand}
        style={{
          minHeight: 46,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <AppSymbol name="pencil.line" size={16} color={theme.textTertiary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
            {entries.length > 1 ? `${entries.length} 个文件修改` : "文件修改"}
          </Text>
          {stats ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
              {stats.files.length > 0 ? stats.files.map(shortPath).join("、") : "工作区 diff"}
            </Text>
          ) : input ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
              {input.split("\n").map(shortPath).join("、")}
            </Text>
          ) : null}
        </View>
        {stats ? (
          <View style={{ flexDirection: "row", gap: 4 }}>
            <View style={{ borderRadius: 999, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: "rgba(52, 199, 89, 0.12)" }}>
              <Text style={{ color: theme.success, fontSize: 11, fontWeight: "800" }}>+{stats.added}</Text>
            </View>
            <View style={{ borderRadius: 999, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: "rgba(255, 59, 48, 0.12)" }}>
              <Text style={{ color: theme.error, fontSize: 11, fontWeight: "800" }}>-{stats.removed}</Text>
            </View>
          </View>
        ) : meta ? (
          <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
            <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
          </View>
        ) : null}
        {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={13} color={theme.textTertiary} /> : null}
      </Pressable>

      {entries.length > 0 ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          {entries.slice(0, expanded ? entries.length : 4).map((entry, index) => (
            <View
              key={`${entry.path}-${index}`}
              style={{
                minHeight: 38,
                paddingHorizontal: 12,
                paddingVertical: 8,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: theme.separator,
              }}
            >
              <Text
                selectable
                style={{ flex: 1, color: theme.textSecondary, fontSize: 13 }}
                numberOfLines={1}
              >
                {shortPath(entry.path)}
              </Text>
              {entry.added > 0 || entry.removed > 0 ? (
                <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "800" }}>
                  <Text style={{ color: theme.success }}>+{entry.added}</Text>
                  <Text> </Text>
                  <Text style={{ color: theme.error }}>-{entry.removed}</Text>
                </Text>
              ) : null}
            </View>
          ))}
          {!expanded && entries.length > 4 ? (
            <Text style={{ paddingHorizontal: 12, paddingBottom: 9, color: theme.textTertiary, fontSize: 12 }}>
              还有 {entries.length - 4} 个文件
            </Text>
          ) : null}
        </View>
      ) : null}

      {hasDiff && output && expanded ? (
        <View style={{ padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          <DiffBlock diff={output} theme={theme} expanded />
        </View>
      ) : !hasDiff && output && expanded ? (
        <View style={{ gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          <Text style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}>
            这条历史事件没有携带 diff。升级后的 CLI 会优先展示补丁内容；旧记录只能显示工具返回摘要。
          </Text>
          <CodeBlock label="修改摘要" code={output} theme={theme} maxLines={6} />
        </View>
      ) : !output && input && expanded ? (
        <View style={{ padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          <CodeBlock label="修改文件" code={input} theme={theme} maxLines={6} />
        </View>
      ) : null}

      {canExpand ? (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          hitSlop={8}
          style={{
            minHeight: 38,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.separator,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "800" }}>
            {expanded
              ? hasDiff ? "收起 diff" : "收起详情"
              : hasDiff ? `查看 diff${diffLineCount > 0 ? `（${diffLineCount} 行）` : ""}` : "查看详情"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

export const ToolCard = memo(function ToolCard({ tool, theme }: { tool: AgentToolCall; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  if (tool.name.includes("文件")) return <FileChangeCard tool={tool} theme={theme} />;
  const input = tool.input?.trim();
  const output = tool.output?.trim();
  const meta = toolStatusMeta(tool.status, theme);
  const language = commandLanguage(tool.name);
  const canExpand = Boolean(input || output);
  const isCommand = tool.name.includes("命令");
  const commandSummary = isCommand && input ? humanizeCommand(input, tool.status === "running") : null;
  const title = commandSummary ? commandSummary.verb : tool.name;
  const subtitle = commandSummary ? commandSummary.target : input || output || "";
  const iconName = tool.name.includes("MCP") ? "server.rack" : "terminal.fill";

  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        overflow: "hidden",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
      }}
    >
      <Pressable
        onPress={() => canExpand && setExpanded((value) => !value)}
        disabled={!canExpand}
        style={{
          minHeight: 44,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tool.status === "running" ? theme.accentLight : theme.bgInput,
          }}
        >
          <AppSymbol name={iconName} size={14} color={tool.status === "running" ? theme.accent : theme.textTertiary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text selectable style={{ color: theme.text, fontSize: 13, fontWeight: "800" }} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text selectable style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {meta ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
            {tool.status === "running" ? <ActivityIndicator size="small" color={meta.color} /> : null}
            <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
          </View>
        ) : null}
        {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={13} color={theme.textTertiary} /> : null}
      </Pressable>
      {expanded ? (
        <View style={{ gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.separator }}>
          {input ? <CodeBlock label={`输入 · ${language}`} code={input} theme={theme} maxLines={24} /> : null}
          {output ? <CodeBlock label={`输出 · ${language}`} code={output} theme={theme} maxLines={28} /> : null}
        </View>
      ) : null}
      {expanded && canExpand && (input?.length ?? 0) + (output?.length ?? 0) > 500 ? (
        <Pressable
          onPress={() => setExpanded((value) => !value)}
          hitSlop={8}
          style={{
            minHeight: expanded ? 34 : 0,
            alignItems: "center",
            justifyContent: "center",
            borderTopWidth: expanded ? StyleSheet.hairlineWidth : 0,
            borderTopColor: theme.separator,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "700" }}>
            收起详情
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

export function SystemActivityCard({
  icon,
  title,
  text,
  theme,
  running,
}: {
  icon: string;
  title: string;
  text?: string;
  theme: Theme;
  running?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = Boolean(text && text.length > 120);
  return (
    <Pressable
      onPress={() => canExpand && setExpanded((value) => !value)}
      disabled={!canExpand}
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        backgroundColor: agentEventSurface(theme),
        paddingHorizontal: 10,
        paddingVertical: 9,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: running ? theme.accentLight : theme.bgInput,
        }}
      >
        <AppSymbol name={icon} size={13} color={running ? theme.accent : theme.textTertiary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
            {title}
          </Text>
          {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
        </View>
        {text ? (
          <Text
            selectable
            style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }}
            numberOfLines={expanded ? undefined : 2}
          >
            {text}
          </Text>
        ) : null}
      </View>
      {canExpand ? <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={12} color={theme.textTertiary} /> : null}
    </Pressable>
  );
}

export function SubagentCard({ action, theme, running }: { action: AgentSubagentAction; theme: Theme; running?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const rows = action.receiverThreadIds.length > 0
    ? action.receiverThreadIds
    : action.receiverAgents.map((agent) => agent.threadId);
  const uniqueRows = [...new Set(rows)];
  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        padding: 12,
        gap: 9,
      }}
    >
      <Pressable onPress={() => setExpanded((value) => !value)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppSymbol name="person.2.fill" size={15} color={theme.accent} />
        <Text style={{ flex: 1, color: theme.text, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
          {subagentTitle(action)}
        </Text>
        {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
        <AppSymbol name={expanded ? "chevron.down" : "chevron.right"} size={12} color={theme.textTertiary} />
      </Pressable>
      {action.prompt ? (
        <Text selectable style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 17 }} numberOfLines={expanded ? 4 : 1}>
          {action.prompt}
        </Text>
      ) : null}
      {expanded && uniqueRows.length > 0 ? (
        <View style={{ gap: 6 }}>
          {uniqueRows.map((threadId) => {
            const agent = action.receiverAgents.find((entry) => entry.threadId === threadId);
            const state = action.agentStates[threadId];
            const status = subagentStatusLabel(state?.status ?? action.status);
            return (
              <View key={threadId} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status === "失败" ? theme.error : status === "完成" ? theme.success : theme.accent }} />
                <Text selectable style={{ flex: 1, color: theme.textSecondary, fontSize: 13 }} numberOfLines={1}>
                  {agent ? subagentDisplayName(agent, threadId) : threadId}
                </Text>
                {agent?.model ? (
                  <Text style={{ color: theme.textTertiary, fontSize: 11 }} numberOfLines={1}>
                    {agent.model}
                  </Text>
                ) : null}
                <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
                  {status}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
