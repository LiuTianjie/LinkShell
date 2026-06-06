import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";

import { AppSymbol } from "../../../components/AppSymbol";
import type { Theme } from "../../../theme";
import { agentEventBorder, agentEventSurface } from "../lib/format";
import { isElevatedPermissionOption } from "../lib/commands";
import type {
  AgentPlanStep,
  AgentStructuredInput,
  AgentTimelineItem,
} from "../types";
import { CodeBlock, MarkdownContent } from "./content";

export function StructuredInputCard({
  input,
  theme,
  submitted,
  submitting,
  error,
  onSubmit,
}: {
  input: AgentStructuredInput;
  theme: Theme;
  submitted?: boolean;
  submitting?: boolean;
  error?: string;
  onSubmit: (answers: Record<string, string[]>) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  const answers = useMemo(() => {
    const next: Record<string, string[]> = {};
    for (const question of input.questions) {
      const typedAnswer = typed[question.id]?.trim();
      const selectedAnswers = (selected[question.id] ?? [])
        .map((value) => value.trim())
        .filter(Boolean);
      const values = typedAnswer ? [...selectedAnswers, typedAnswer] : selectedAnswers;
      if (values.length > 0) next[question.id] = values;
    }
    return next;
  }, [input.questions, selected, typed]);

  const canSubmit = input.questions.length > 0 &&
    input.questions.every((question) => (answers[question.id] ?? []).length > 0) &&
    !submitted &&
    !submitting;

  const toggleOption = useCallback((questionId: string, optionId: string, limit?: number) => {
    setSelected((current) => {
      const max = Math.max(limit ?? 1, 1);
      const existing = current[questionId] ?? [];
      const hasValue = existing.includes(optionId);
      const nextValues = hasValue
        ? existing.filter((value) => value !== optionId)
        : max === 1
          ? [optionId]
          : existing.length < max
            ? [...existing, optionId]
            : existing;
      return { ...current, [questionId]: nextValues };
    });
  }, []);

  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        padding: 12,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AppSymbol name="questionmark.circle.fill" size={15} color={theme.accent} />
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }}>
          {submitted ? "已发送补充信息" : submitting ? "正在发送补充信息" : "Agent 需要补充信息"}
        </Text>
      </View>
      {input.questions.map((question) => (
        <View key={question.id} style={{ gap: 6 }}>
          {question.header ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
              {question.header}
            </Text>
          ) : null}
          <Text selectable style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
            {question.question}
          </Text>
          {question.options?.length ? (
            <View style={{ gap: 6 }}>
              {question.selectionLimit && question.selectionLimit > 1 ? (
                <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
                  最多选择 {question.selectionLimit} 项
                </Text>
              ) : null}
              {question.options.map((option) => {
                const isSelected = (selected[question.id] ?? []).includes(option.id);
                return (
                  <Pressable
                    key={option.id}
                    disabled={submitted || submitting}
                    onPress={() => toggleOption(question.id, option.id, question.selectionLimit)}
                    style={{
                      borderRadius: 10,
                      borderCurve: "continuous",
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      backgroundColor: isSelected
                        ? theme.accentLight
                        : theme.bgInput,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: isSelected
                        ? theme.accent
                        : theme.separator,
                      opacity: submitted || submitting ? 0.65 : 1,
                      gap: 3,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 12, fontWeight: "800" }}>
                        {option.label}
                      </Text>
                      {isSelected ? <AppSymbol name="checkmark.circle.fill" size={14} color={theme.accent} /> : null}
                    </View>
                    {option.description ? (
                      <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }}>
                        {option.description}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {question.options?.length && !question.isOther ? null : (
            <TextInput
              value={typed[question.id] ?? ""}
              onChangeText={(value) => setTyped((current) => ({ ...current, [question.id]: value }))}
              editable={!submitted && !submitting}
              secureTextEntry={question.isSecret}
              placeholder={question.isSecret ? "输入敏感信息" : "输入回答"}
              placeholderTextColor={theme.textTertiary}
              multiline={!question.isSecret}
              style={{
                minHeight: 42,
                borderRadius: 10,
                borderCurve: "continuous",
                paddingHorizontal: 10,
                paddingVertical: 9,
                color: theme.text,
                backgroundColor: theme.bgInput,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                fontSize: 13,
              }}
            />
          )}
        </View>
      ))}
      {error ? (
        <Text style={{ color: theme.error, fontSize: 12, fontWeight: "700" }}>
          {error}
        </Text>
      ) : null}
      {!submitted ? (
        <Pressable
          disabled={!canSubmit}
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onSubmit(answers);
          }}
          style={({ pressed }) => ({
            minHeight: 40,
            borderRadius: 10,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed ? theme.accentSecondary : theme.accent,
            opacity: canSubmit ? 1 : 0.45,
          })}
        >
          <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>
            {submitting ? "发送中" : "发送回答"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function PermissionRequestCard({
  item,
  theme,
  onPermission,
}: {
  item: AgentTimelineItem;
  theme: Theme;
  onPermission: (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => void;
}) {
  const outcome = item.metadata?.permissionOutcome;
  const permissionPending = item.metadata?.permissionPending === true;
  const permissionLive = item.metadata?.permissionLive === true;
  const permissionExpired = !outcome && !permissionPending && (
    item.metadata?.permissionExpired === true || !permissionLive
  );
  const selectedOptionId = item.metadata?.optionId;
  const permissionError = typeof item.metadata?.permissionError === "string"
    ? item.metadata.permissionError
    : undefined;
  const options = item.permission!.options.length > 0
    ? item.permission!.options
    : [
        { id: "deny", label: "拒绝", kind: "deny" as const },
        { id: "allow_once", label: "允许一次", kind: "allow" as const },
      ];
  const selectedLabel = options.find((option) => option.id === selectedOptionId)?.label ??
    (outcome === "allow" ? "已允许" : outcome === "deny" ? "已拒绝" : outcome === "cancelled" ? "已取消" : undefined);
  const statusLabel = outcome
    ? selectedLabel ?? "授权已处理"
    : permissionPending
      ? "发送中"
      : permissionExpired
        ? "已失效"
        : "等待处理";
  const statusColor = outcome === "deny" || outcome === "cancelled"
    ? theme.error
    : outcome === "allow"
      ? theme.success
      : permissionExpired
        ? theme.textTertiary
        : theme.warning;
  const toolName = item.permission!.toolName || "工具调用";

  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        overflow: "hidden",
      }}
    >
      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 11,
          backgroundColor: "transparent",
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            backgroundColor: theme.accentLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppSymbol name="checkmark.shield" size={14} color={theme.warning} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
            需要授权 · {toolName}
          </Text>
          <Text style={{ color: statusColor, fontSize: 12, fontWeight: "700", marginTop: 2 }} numberOfLines={1}>
            {statusLabel}
          </Text>
        </View>
        {permissionPending ? <ActivityIndicator size="small" color={theme.warning} /> : null}
      </View>

      {item.permission!.context || item.permission!.toolInput || permissionError ? (
        <View style={{ padding: 12, gap: 9 }}>
          {item.permission!.context ? (
            <MarkdownContent text={item.permission!.context} theme={theme} />
          ) : null}
          {item.permission!.toolInput ? (
            <CodeBlock label="请求内容" code={item.permission!.toolInput} theme={theme} maxLines={8} />
          ) : null}
          {permissionError ? (
            <Text style={{ color: theme.error, fontSize: 12, lineHeight: 17, fontWeight: "700" }}>
              {permissionError}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.separator,
          gap: 3,
        }}
      >
        {options.map((option) => {
          const optionOutcome = option.kind === "allow" ? "allow" : option.kind === "deny" ? "deny" : "cancelled";
          const isAllow = option.kind === "allow";
          const isDeny = option.kind === "deny";
          const isElevated = isElevatedPermissionOption(option);
          const selected = Boolean(outcome) &&
            (selectedOptionId === option.id || (!selectedOptionId && outcome === optionOutcome));
          const inactive = Boolean(outcome) && !selected;
          const optionColor = selected
            ? theme.text
            : isAllow
              ? isElevated ? theme.warning : theme.accent
              : isDeny
                ? theme.error
                : theme.textSecondary;

          return (
            <Pressable
              key={option.id}
              disabled={permissionPending || permissionExpired || Boolean(outcome)}
              onPress={() => {
                if (isElevated) {
                  Alert.alert(
                    "确认高权限授权",
                    `“${option.label}”可能会扩大本次授权范围。确认继续吗？`,
                    [
                      { text: "取消", style: "cancel" },
                      {
                        text: "确认授权",
                        onPress: () => onPermission(item.permission!.requestId, optionOutcome, option.id),
                      },
                    ],
                  );
                  return;
                }
                onPermission(item.permission!.requestId, optionOutcome, option.id);
              }}
              style={({ pressed }) => ({
                minHeight: 36,
                borderRadius: 5,
                borderCurve: "continuous",
                paddingHorizontal: 8,
                paddingVertical: 8,
                borderLeftWidth: 3,
                borderLeftColor: selected ? theme.text : "transparent",
                backgroundColor: pressed ? theme.bgInput : "transparent",
                opacity: inactive || permissionPending || permissionExpired ? 0.45 : 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
              })}
            >
              <AppSymbol
                name={selected ? "checkmark" : isAllow ? "checkmark.circle" : isDeny ? "xmark.circle" : "minus.circle"}
                size={14}
                color={optionColor}
              />
              <Text style={{ flex: 1, color: optionColor, fontSize: 13, fontWeight: selected ? "800" : "700" }} numberOfLines={2}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function PlanCard({ steps, theme }: { steps: AgentPlanStep[]; theme: Theme }) {
  const completed = steps.filter((step) => step.status === "completed").length;
  const active = steps.find((step) => step.status === "in_progress");
  return (
    <View
      style={{
        borderRadius: 8,
        borderCurve: "continuous",
        backgroundColor: agentEventSurface(theme),
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: agentEventBorder(theme),
        overflow: "hidden",
      }}
    >
      <View
        style={{
          minHeight: 46,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
        }}
      >
        <View style={{ width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: theme.accentLight }}>
          <AppSymbol name="list.bullet.rectangle.fill" size={14} color={theme.accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "900" }} numberOfLines={1}>
            执行计划
          </Text>
          <Text style={{ color: active ? theme.accent : theme.textTertiary, fontSize: 11, fontWeight: "700", marginTop: 2 }} numberOfLines={1}>
            {active ? `正在进行：${active.text}` : `${completed}/${steps.length} 已完成`}
          </Text>
        </View>
        <View style={{ borderRadius: 999, backgroundColor: theme.bgInput, paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
            {completed}/{steps.length}
          </Text>
        </View>
      </View>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 9 }}>
        {steps.map((step, index) => {
          const isDone = step.status === "completed";
          const isActive = step.status === "in_progress";
          const color = isDone ? theme.success : isActive ? theme.accent : theme.textTertiary;
          return (
            <View key={step.id} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <View style={{ alignItems: "center", width: 16 }}>
                <AppSymbol
                  name={isDone ? "checkmark.circle.fill" : isActive ? "clock" : "circle"}
                  size={14}
                  color={color}
                />
                {index < steps.length - 1 ? (
                  <View style={{ width: StyleSheet.hairlineWidth, flex: 1, minHeight: 10, marginTop: 3, backgroundColor: theme.separator }} />
                ) : null}
              </View>
              <Text selectable style={{ flex: 1, color: isActive ? theme.text : theme.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: isActive ? "700" : "500" }}>
                {step.text}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
