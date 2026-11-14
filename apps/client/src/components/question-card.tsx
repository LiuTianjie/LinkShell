import { recommendedLabel, type PendingPermission } from "@linkshell/client-core";
import { questionAnswerError, type Question, type QuestionAnswer } from "@linkshell/wire";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useConnection } from "@/lib/client";
import { useContentHeight } from "@/lib/content-height";
import { haptics } from "@/lib/haptics";
import { describeActionError, useLocale } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { Button } from "./button";
import { Glass } from "./glass";
import { Icon } from "./icon";

type Draft = Record<string, { values: string[]; other: string }>;
// Folding can replace the presentation. Keep pending answers in memory only.
const pendingDrafts = new Map<string, Draft>();
const EMPTY_DRAFT: Draft = {};
const draftListeners = new Set<() => void>();
function subscribeDrafts(listener: () => void) {
  draftListeners.add(listener);
  return () => { draftListeners.delete(listener); };
}

function saveDraft(key: string, draft: Draft) {
  pendingDrafts.delete(key);
  pendingDrafts.set(key, draft);
  if (pendingDrafts.size > 60) pendingDrafts.delete(pendingDrafts.keys().next().value!);
  for (const listener of draftListeners) listener();
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
  const { pick: say } = useLocale();
  const multiple = say({ zh: "可多选", en: "Choose any", ja: "複数選択可" });
  const answerHere = say({ zh: "输入你的回答", en: "Type your answer", ja: "回答を入力" });
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
            {many ? ` · ${multiple}` : ""}
          </Text>
        ) : many ? (
          <Text style={[type.caption, { color: colors.secondaryLabel }]}>{multiple}</Text>
        ) : null}
        <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>{question.text}</Text>
      </View>
      {question.options?.map((option) => {
        const selected = entry.values.includes(option.value);
        // The agent's English "(Recommended)" reads as a 推荐 tag; the label sent back is unchanged.
        const label = recommendedLabel(option.label);
        return (
          <Pressable
            key={option.value}
            disabled={disabled}
            onPress={() => pick(option.value)}
            accessibilityRole={many ? "checkbox" : "radio"}
            accessibilityState={{ checked: selected, disabled }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              paddingVertical: 9,
              paddingHorizontal: 12,
              borderRadius: radius.control,
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
              <Text style={[type.subhead, { color: colors.label, fontWeight: selected ? "600" : "400" }]}>
                {label.text}
                {label.recommended ? <Text style={[type.caption, { color: colors.accent, fontWeight: "600" }]}>{`  ${say({ zh: "推荐", en: "Recommended", ja: "おすすめ" })}`}</Text> : null}
              </Text>
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
          keyboardType={question.constraints?.type === "integer" || question.constraints?.type === "number" ? "numbers-and-punctuation" : question.constraints?.format === "email" ? "email-address" : "default"}
          placeholder={typed || !question.options?.length ? answerHere : say({ zh: "或者自己写", en: "Or write your own", ja: "または自分で入力" })}
          placeholderTextColor={colors.placeholder as string}
          selectionColor={colors.accent}
          accessibilityLabel={typed ? question.text : say({ zh: "自己写一个回答", en: "Write your own answer", ja: "自分で回答を入力" })}
          style={[
            type.subhead,
            { color: colors.label, backgroundColor: colors.fill, borderRadius: radius.control, borderCurve: "continuous", paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, maxHeight: 110 },
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
  sessionId,
  contained = false,
  request,
  count,
  agentName,
  disabled = false,
  onAnswer,
  onChoose,
}: {
  sessionId: string;
  contained?: boolean;
  request: PendingPermission;
  /** How many requests are waiting, this one included. */
  count: number;
  agentName: string;
  disabled?: boolean;
  onAnswer: (requestId: string, answers: QuestionAnswer[]) => Promise<void>;
  onChoose: (requestId: string, optionId: string) => Promise<void>;
}) {
  const questions = request.questions ?? [];
  const { pick: say } = useLocale();
  const { computer } = useConnection();
  const key = JSON.stringify([computer.key, sessionId, request.requestId]);
  const snapshot = useCallback(() => pendingDrafts.get(key) ?? EMPTY_DRAFT, [key]);
  const draft = useSyncExternalStore(subscribeDrafts, snapshot, snapshot);
  const update = (questionId: string, entry: Draft[string]) => {
    const value = { ...draft, [questionId]: entry };
    saveDraft(key, value);
  };
  const [busy, setBusy] = useState<"answer" | "skip" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const height = useContentHeight();
  const keyboardHeight = useKeyboardState((state) => state.height);
  const available = Math.max(96, height - keyboardHeight - 180);
  const maxHeight = Math.min(520, available);
  const entryOf = (question: Question) => draft[question.id] ?? { values: question.defaults ?? [], other: "" };
  const answers = questions.flatMap((question): QuestionAnswer[] => {
    if (!draft[question.id] && !question.defaults && !question.required) return [];
    const entry = entryOf(question);
    return [{ id: question.id, values: entry.values, other: entry.other.trim() || undefined }];
  });
  const validation = questions.map((question) => questionAnswerError(question, answers.find((answer) => answer.id === question.id))).find(Boolean);
  const ready = !validation;
  const skip = request.options.find((option) => option.optionId === "skip");
  // The computer also offers to stop the turn here; leaving it out left no way to do that from the card.
  const stop = request.options.find((option) => option.optionId === "cancel");

  const run = async (kind: "answer" | "skip" | "stop", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await action();
      pendingDrafts.delete(key);
      for (const listener of draftListeners) listener();
    } catch (reason) {
      haptics.error();
      setError(describeActionError(reason));
      setBusy(null);
    }
  };
  const submit = () =>
    run("answer", async () => {
      haptics.success();
      await onAnswer(
        request.requestId,
        answers,
      );
    });

  return (
    <Glass style={{ borderRadius: radius.panel }}>
      <QuestionBody contained={contained} maxHeight={maxHeight}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {/* Waiting on the user, so amber, as the approval card is. */}
        <Icon sf="questionmark.bubble.fill" md="help" size={15} color={colors.waiting} />
        <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
          {say({ zh: `${agentName} 想问你`, en: `${agentName} has a question`, ja: `${agentName} からの質問` })}
        </Text>
        {count > 1 ? <Text style={[type.caption, { color: colors.waiting, fontWeight: "600" }]}>1/{count}</Text> : null}
      </View>
      {request.detail ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>{request.detail}</Text> : null}
      <View style={{ gap: 16 }}>
        {questions.map((question) => (
          <Field
            key={question.id}
            question={question}
            entry={entryOf(question)}
            disabled={disabled || busy !== null}
            onChange={(next) => update(question.id, next)}
          />
        ))}
      </View>
      {error ? <Text style={[type.caption, { color: colors.danger }]}>{error}</Text> : null}
      {validation && Object.keys(draft).length ? <Text style={[type.caption, { color: colors.danger }]}>{validation}</Text> : null}
      <View style={{ flexDirection: "row", alignSelf: "stretch", gap: 8 }}>
        {skip ? (
          <Button title={say({ zh: "跳过", en: "Skip", ja: "スキップ" })} variant="tonal" size="large" wide busy={busy === "skip"} disabled={disabled || busy !== null} onPress={() => void run("skip", () => onChoose(request.requestId, skip.optionId))} />
        ) : null}
        <Button title={say({ zh: "提交", en: "Submit", ja: "送信" })} variant="primary" size="large" wide busy={busy === "answer"} disabled={disabled || busy !== null || !ready} onPress={() => void submit()} />
      </View>
      {stop ? (
        // Last and quiet, as on an approval: 跳过 → 提交 → 停止.
        <Button title={say({ zh: "停止", en: "Stop", ja: "停止" })} variant="plain" size="small" busy={busy === "stop"} disabled={disabled || busy !== null} onPress={() => void run("stop", () => onChoose(request.requestId, stop.optionId))} />
      ) : null}
      </QuestionBody>
    </Glass>
  );
}

function QuestionBody({ children, contained, maxHeight }: { children: ReactNode; contained: boolean; maxHeight: number }) {
  const content = { padding: 14, gap: 12 };
  if (contained) return <View style={content}>{children}</View>;
  return <ScrollView style={{ maxHeight }} contentContainerStyle={content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={false} nestedScrollEnabled bounces={false}>{children}</ScrollView>;
}
