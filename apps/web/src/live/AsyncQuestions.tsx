import { useId, useState } from "react";
import type { AsyncQuestion } from "@linkshell/wire";
import { recommendedLabel } from "@linkshell/client-core";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Check, CircleHelp } from "lucide-react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ErrorNotice, useActions, useSessionOnline, useJob } from "./common";

function Question({
  question,
  sessionId,
  answered,
}: {
  question: AsyncQuestion;
  sessionId: string;
  answered?: string;
}) {
  const actions = useActions();
  const online = useSessionOnline();
  const job = useJob();
  const inputId = useId();
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string>();
  const given = answered ?? sent;
  const done = given !== undefined;
  const disabled = done || job.busy || !online;
  const answer = (value: string) => {
    if (disabled) return;
    void job.run(async () => {
      await actions.answerAsync(sessionId, question, value);
      // Only lock the card once the host accepts this specific answer.
      setSent(value);
    });
  };
  return (
    <form
      className="async-question"
      aria-busy={job.busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) answer(text.trim());
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={!done ? inputId : undefined}>
            <CircleHelp aria-hidden="true" />
            {question.title}
          </FieldLabel>
          <div className="async-options">
            {question.options.map((option) => {
              const { text, recommended } = recommendedLabel(option);
              return (
                <Button
                  key={option}
                  type="button"
                  variant="outline"
                  className="async-option h-auto min-h-9 whitespace-normal text-left"
                  disabled={disabled}
                  aria-pressed={given === option}
                  onClick={() => answer(option)}
                >
                  {text}
                  {recommended && <span className="choice-badge">推荐</span>}
                </Button>
              );
            })}
          </div>
          {!done && (
            <Textarea
              id={inputId}
              className="async-answer-input"
              rows={1}
              maxLength={20_000}
              value={text}
              disabled={disabled}
              placeholder={question.options.length ? "其他回答" : "输入回答"}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, as the composer does; Shift-Enter and a composing IME make a new line.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && text.trim()) {
                  event.preventDefault();
                  answer(text.trim());
                }
              }}
            />
          )}
        </Field>
        {!done && (
          <div className="async-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => answer("")}
            >
              跳过
            </Button>
            <Button type="submit" disabled={disabled || !text.trim()}>
              {job.busy ? "发送中…" : "发送回答"}
            </Button>
          </div>
        )}
        {done && (
          <p role="status" className="async-answer">
            <Check aria-hidden="true" />
            {given ? `已回答：${given}` : "已跳过"}
          </p>
        )}
        <ErrorNotice error={job.error} />
      </FieldGroup>
    </form>
  );
}

export function AsyncQuestions({
  questions,
  sessionId,
  answered,
}: {
  questions: AsyncQuestion[];
  sessionId: string;
  answered?: ReadonlyMap<string, string>;
}) {
  if (!questions.length) return null;
  return (
    <div className="async-questions">
      {questions.map((question) => (
        <Question
          key={`${sessionId}:${question.id}`}
          question={question}
          sessionId={sessionId}
          answered={answered?.get(question.id)}
        />
      ))}
    </div>
  );
}
