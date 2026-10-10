import { useEffect, useMemo, useState } from "react";
import { questionAnswerError, type PendingPermissionSummary, type QuestionAnswer } from "@linkshell/wire";
import { ErrorNotice, useActions, useClient, useConnection, useJob } from "./common";
import { Diff, Blocks } from "./Timeline";
import { Icon } from "../icons";

export function Permission({
  permission,
  sessionId,
  agent,
}: {
  permission: PendingPermissionSummary;
  sessionId: string;
  agent?: string;
}) {
  const actions = useActions();
  const { link } = useConnection();
  const online = useClient((state) => state.status === "online");
  const job = useJob();
  const defaults = useMemo(() => Object.fromEntries((permission.questions ?? []).filter((question) => question.defaults !== undefined).map((question) => [question.id, { id: question.id, values: question.defaults! }])), [permission.questions]);
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>(defaults);
  useEffect(() => setAnswers(defaults), [permission.requestId, defaults]);
  const filled = () => (permission.questions ?? []).flatMap((question): QuestionAnswer[] => answers[question.id] ? [answers[question.id]!] : question.required ? [{ id: question.id, values: [] }] : []);
  const validation = permission.questions?.map((question) => questionAnswerError(question, answers[question.id] ?? (question.required ? { id: question.id, values: [] } : undefined))).find(Boolean);
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
      {permission.url && <p className="muted">{permission.url.url}</p>}
      {permission.tool?.rawInput !== undefined && <pre>{typeof permission.tool.rawInput === "string" ? permission.tool.rawInput : JSON.stringify(permission.tool.rawInput, null, 2)}</pre>}
      {permission.tool?.locations?.map((location, index) => <code key={index}>{location.path}{location.line === undefined ? "" : `:${location.line}`}</code>)}
      {permission.tool?.content?.map((content, index) => content.type === "diff" || content.type === "patch" ? <Diff key={index} change={content} /> : content.type === "content" ? <Blocks key={index} blocks={[content.content]} sessionId={sessionId} onFile={() => {}} /> : null)}
      {permission.questions && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void job.run(() =>
              agent ? link.call("agents.respond", { agent, requestId: permission.requestId, answers: filled() }).then(() => {}) : actions.answer(sessionId, permission.requestId, filled()),
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
                  type={question.secret ? "password" : question.constraints?.type === "integer" || question.constraints?.type === "number" ? "number" : question.constraints?.format === "email" ? "email" : "text"}
                  min={question.constraints?.minimum}
                  max={question.constraints?.maximum}
                  step={question.constraints?.type === "integer" ? 1 : "any"}
                  minLength={question.constraints?.minLength}
                  maxLength={question.constraints?.maxLength}
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
              {answers[question.id] && questionAnswerError(question, answers[question.id]) ? <small className="danger-text">{questionAnswerError(question, answers[question.id])}</small> : null}
            </fieldset>
          ))}
          <button
            className="button primary"
            disabled={
              !online ||
              job.busy ||
              !!validation
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
            onClick={() => {
              if (permission.url && option.optionId === "accept" && /^https?:\/\//.test(permission.url.url)) window.open(permission.url.url, "_blank", "noopener,noreferrer");
              void job.run(() => agent ? link.call("agents.respond", { agent, requestId: permission.requestId, optionId: option.optionId }).then(() => {}) : actions.respond(sessionId, permission.requestId, option.optionId));
            }}
          >
            {option.name}
          </button>
        ))}
      </div>
      <ErrorNotice error={job.error} />
    </section>
  );
}
