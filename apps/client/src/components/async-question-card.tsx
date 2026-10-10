import type { AsyncQuestion } from "@linkshell/wire";
import { useActions } from "@/lib/client";
import { QuestionCard } from "./question-card";

/** Async questions stay within reach while the conversation keeps moving. */
export function AsyncQuestionCard({ sessionId, questions, agentName, disabled }: {
  sessionId: string;
  questions: AsyncQuestion[];
  agentName: string;
  disabled: boolean;
}) {
  const actions = useActions();
  const question = questions[0];
  if (!question) return null;
  return <QuestionCard
    key={question.id}
    sessionId={sessionId}
    contained
    request={{
      requestId: `async:${question.id}`,
      title: question.title,
      detail: "回答会立即发送到当前会话",
      ts: 0,
      options: [{ optionId: "skip", name: "跳过", kind: "reject_once" }],
      questions: [{
        id: question.id, text: question.title,
        kind: question.options.length ? "choice" : "text",
        options: question.options.map((option) => ({ value: option, label: option })),
        other: question.options.length > 0,
      }],
    }}
    count={questions.length}
    agentName={agentName}
    disabled={disabled}
    onAnswer={async (_requestId, answers) => {
      const answer = answers[0];
      if (!answer) return;
      await actions.answerAsync(sessionId, question, [...answer.values, ...(answer.other ? [answer.other] : [])].join("\n"));
    }}
    onChoose={() => actions.answerAsync(sessionId, question, "")}
  />;
}
