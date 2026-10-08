import { useEffect, useState } from "react";
import type { PendingPermissionSummary, QuestionAnswer } from "@linkshell/wire";
import { ErrorNotice, useActions, useClient, useJob } from "./common";
import { Icon } from "../icons";

export function Permission({
  permission,
  sessionId,
}: {
  permission: PendingPermissionSummary;
  sessionId: string;
}) {
  const actions = useActions();
  const online = useClient((state) => state.status === "online");
  const job = useJob();
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
  useEffect(() => setAnswers({}), [permission.requestId]);
  return (
    <section className="approval-card">
      <div className="approval-heading">
        <span className="approval-icon">
          <Icon name="shield" />
        </span>
        <div>
          <strong>{permission.title}</strong>
          <span>
            {permission.questions
              ? "请回答 Agent 的问题"
              : "请确认是否允许此操作"}
          </span>
        </div>
      </div>
      {permission.detail && <pre>{permission.detail}</pre>}
      {permission.questions && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void job.run(() =>
              actions.answer(
                sessionId,
                permission.requestId,
                permission.questions!.map(
                  (question) =>
                    answers[question.id] ?? { id: question.id, values: [] },
                ),
              ),
            );
          }}
        >
          {permission.questions.map((question) => (
            <fieldset key={question.id} className="question-field">
              <legend>
                {question.header && <small>{question.header} · </small>}
                {question.text}
              </legend>
              {question.kind === "text" ? (
                <input
                  aria-label={question.text}
                  type={question.secret ? "password" : "text"}
                  autoComplete="off"
                  required={question.required}
                  value={answers[question.id]?.values[0] ?? ""}
                  onChange={(event) =>
                    setAnswers((previous) => ({
                      ...previous,
                      [question.id]: {
                        id: question.id,
                        values: [event.target.value],
                      },
                    }))
                  }
                />
              ) : (
                <>
                  {question.options?.map((option) => (
                    <label className="choice-option" key={option.value}>
                      <input
                        type={
                          question.kind === "choices" ? "checkbox" : "radio"
                        }
                        name={`${sessionId}:${permission.requestId}:${question.id}`}
                        checked={
                          answers[question.id]?.values.includes(option.value) ??
                          false
                        }
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setAnswers((previous) => ({
                            ...previous,
                            [question.id]: {
                              ...previous[question.id],
                              id: question.id,
                              values:
                                question.kind === "choice"
                                  ? [option.value]
                                  : checked
                                    ? [
                                        ...(previous[question.id]?.values ??
                                          []),
                                        option.value,
                                      ]
                                    : (
                                        previous[question.id]?.values ?? []
                                      ).filter(
                                        (value) => value !== option.value,
                                      ),
                            },
                          }));
                        }}
                      />
                      <span>
                        {option.label}
                        {option.description && (
                          <small>{option.description}</small>
                        )}
                      </span>
                    </label>
                  ))}
                  {question.other && (
                    <input
                      aria-label={`${question.text}：其他回答`}
                      placeholder="其他回答"
                      value={answers[question.id]?.other ?? ""}
                      onChange={(event) =>
                        setAnswers((previous) => ({
                          ...previous,
                          [question.id]: {
                            id: question.id,
                            values: previous[question.id]?.values ?? [],
                            other: event.target.value,
                          },
                        }))
                      }
                    />
                  )}
                </>
              )}
            </fieldset>
          ))}
          <button
            className="button primary"
            disabled={
              !online ||
              job.busy ||
              permission.questions.some(
                (question) =>
                  question.required &&
                  !answers[question.id]?.values.some(Boolean) &&
                  !answers[question.id]?.other?.trim(),
              )
            }
          >
            提交回答
          </button>
        </form>
      )}
      <div className="permission-buttons">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            disabled={!online || job.busy}
            className={`button ${option.kind.startsWith("allow") ? "primary" : "secondary"}`}
            onClick={() =>
              void job.run(() =>
                actions.respond(
                  sessionId,
                  permission.requestId,
                  option.optionId,
                ),
              )
            }
          >
            {option.name}
          </button>
        ))}
      </div>
      <ErrorNotice error={job.error} />
    </section>
  );
}
