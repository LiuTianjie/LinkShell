import type { PendingPermission } from "@linkshell/client-core";
import type { Question, QuestionAnswer } from "@linkshell/wire";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Button } from "./button";
import { Glass } from "./glass";
import { Icon } from "./icon";

type Draft = Record<string, { values: string[]; other: string }>;

function answered(question: Question, draft: Draft): boolean {
  const entry = draft[question.id];
  return !!entry && (entry.values.some(Boolean) || entry.other.trim().length > 0);
}

function Field({
  question,
  entry,
  disabled,
  onChange,
}: {
  question: Question;
  entry: { values: string[]; other: string };
  disabled: boolean;
  onChange: (next: { values: string[]; other: string }) => void;
}) {
  const many = question.kind === "choices";
  const pick = (value: string) => {
    haptics.selection();
    if (many) onChange({ ...entry, values: entry.values.includes(value) ? entry.values.filter((v) => v !== value) : [...entry.values, value] });
    else onChange({ ...entry, values: entry.values[0] === value ? [] : [value] });
  };
  const typed = question.kind === "text";
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 2 }}>
        {question.header ? (
          <Text style={[type.caption, { color: colors.accent, fontWeight: "600" }]}>
            {question.header}
            {many ? " · 可多选" : ""}
          </Text>
        ) : many ? (
          <Text style={[type.caption, { color: colors.secondaryLabel }]}>可多选</Text>
        ) : null}
        <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>{question.text}</Text>
      </View>
      {question.options?.map((option) => {
        const selected = entry.values.includes(option.value);
        return (
          <Pressable
            key={option.value}
            disabled={disabled}
            onPress={() => pick(option.value)}
            accessibilityRole={many ? "checkbox" : "radio"}
            accessibilityState={{ checked: selected }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingVertical: 9,
              paddingHorizontal: 12,
              borderRadius: 14,
              borderCurve: "continuous",
              backgroundColor: selected ? colors.accentSoft : colors.fill,
            }}
          >
            <Icon
              sf={many ? (selected ? "checkmark.square.fill" : "square") : selected ? "checkmark.circle.fill" : "circle"}
              md={many ? (selected ? "check_box" : "check_box_outline_blank") : selected ? "radio_button_checked" : "radio_button_unchecked"}
              size={18}
              color={selected ? colors.accent : colors.tertiaryLabel}
            />
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={[type.subhead, { color: colors.label, fontWeight: selected ? "600" : "400" }]}>{option.label}</Text>
              {option.description ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>{option.description}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      {typed || question.other ? (
        <TextInput
          value={typed ? (entry.values[0] ?? "") : entry.other}
          onChangeText={(value) => onChange(typed ? { ...entry, values: [value] } : { ...entry, other: value })}
          editable={!disabled}
          multiline={!question.secret}
          secureTextEntry={question.secret}
          autoCapitalize="none"
          autoCorrect={!question.secret}
          placeholder={typed ? "输入你的回答" : question.options?.length ? "或者自己写" : "输入你的回答"}
          placeholderTextColor={colors.placeholder as string}
          selectionColor={colors.accent}
          accessibilityLabel={typed ? question.text : "自己写一个回答"}
          style={[
            type.subhead,
            { color: colors.label, backgroundColor: colors.fill, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 12, paddingVertical: 10, maxHeight: 110 },
          ]}
        />
      ) : null}
    </View>
  );
}

/**
 * Questions the agent is waiting on: each with its options (one or several)
 * and room for an answer of the user's own. Skipping lets the agent go on
 * without an answer.
 */
export function QuestionCard({
  request,
  count,
  agentName,
  disabled = false,
  onAnswer,
  onChoose,
}: {
  request: PendingPermission;
  /** How many requests are waiting, this one included. */
  count: number;
  agentName: string;
  disabled?: boolean;
  onAnswer: (requestId: string, answers: QuestionAnswer[]) => Promise<void>;
  onChoose: (requestId: string, optionId: string) => Promise<void>;
}) {
  const questions = request.questions ?? [];
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState<"answer" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const window = useWindowDimensions();
  const entryOf = (question: Question) => draft[question.id] ?? { values: [], other: "" };
  const missing = questions.find((question) => question.required && !answered(question, draft));
  const ready = !missing && questions.some((question) => answered(question, draft));
  const skip = request.options.find((option) => option.optionId === "skip");

  const run = async (kind: "answer" | "skip", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(null);
    }
  };
  const submit = () =>
    run("answer", async () => {
      haptics.success();
      await onAnswer(
        request.requestId,
        questions.map((question) => {
          const entry = entryOf(question);
          return { id: question.id, values: entry.values.filter(Boolean), other: entry.other.trim() || undefined };
        }),
      );
    });

  return (
    <Glass style={{ borderRadius: 26, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{ width: 26, height: 26, borderRadius: 9, borderCurve: "continuous", backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="questionmark.bubble.fill" md="help" size={13} color={colors.accent} />
        </View>
        <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
          {agentName} 想问你
        </Text>
        {count > 1 ? <Text style={[type.caption, { color: colors.accent, fontWeight: "600" }]}>1/{count}</Text> : null}
      </View>
      {request.detail ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>{request.detail}</Text> : null}
      <ScrollView style={{ maxHeight: Math.round(window.height * 0.42) }} contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled" bounces={false}>
        {questions.map((question) => (
          <Field
            key={question.id}
            question={question}
            entry={entryOf(question)}
            disabled={disabled || busy !== null}
            onChange={(next) => setDraft((current) => ({ ...current, [question.id]: next }))}
          />
        ))}
      </ScrollView>
      {error ? <Text style={[type.caption, { color: colors.danger }]}>{error}</Text> : null}
      <View style={{ flexDirection: "row", alignSelf: "stretch", gap: 8 }}>
        {skip ? (
          <Button title="跳过" variant="tonal" size="large" wide busy={busy === "skip"} disabled={disabled || busy !== null} onPress={() => void run("skip", () => onChoose(request.requestId, skip.optionId))} />
        ) : null}
        <Button title="提交" variant="primary" size="large" wide busy={busy === "answer"} disabled={disabled || busy !== null || !ready} onPress={() => void submit()} />
      </View>
    </Glass>
  );
}
