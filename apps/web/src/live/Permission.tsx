import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { FieldSet, FieldLegend } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useId, useMemo, useState } from "react";
import {
  questionAnswerError,
  type PendingPermissionSummary,
  type Question,
  type QuestionAnswer,
} from "@linkshell/wire";
import {
  questionOptionName,
  questionTitle,
  recommendedLabel,
} from "@linkshell/client-core";
import {
  ErrorNotice,
  useActions,
  useClient,
  useConnection,
  useJob,
  useSessionOnline,
} from "./common";
import { Diff, Blocks } from "./Timeline";
import { Icon } from "../icons";

type QuestionOption = NonNullable<Question["options"]>[number];

/** An option's label and description as one block; the agent's "(Recommended)" becomes a 推荐 badge. */
function OptionText({ option }: { option: QuestionOption }) {
  const { text, recommended } = recommendedLabel(option.label);
  return (
    <span className="choice-text">
      <span className="choice-label">
        {text}
        {recommended && <span className="choice-badge">推荐</span>}
      </span>
      {option.description && (
        <small className="choice-description">{option.description}</small>
      )}
    </span>
  );
}

// Label's own flex row centres everything on one line; an option is a block of text with its mark
// beside the first line.
const choiceOption = "choice-option items-start leading-normal font-normal";

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
  const available = useSessionOnline();
  const job = useJob();
  const formId = useId();
  const [submitted, setSubmitted] = useState(false);
  const disabled = !available || job.busy || submitted;
  const defaults = useMemo(
    () =>
      Object.fromEntries(
        (permission.questions ?? [])
          .filter((question) => question.defaults !== undefined)
          .map((question) => [
            question.id,
            { id: question.id, values: question.defaults! },
          ]),
      ),
    [permission.questions],
  );
  const [answers, setAnswers] =
    useState<Record<string, QuestionAnswer>>(defaults);
  useEffect(() => setAnswers(defaults), [permission.requestId, defaults]);
  const filled = () =>
    (permission.questions ?? []).flatMap((question): QuestionAnswer[] =>
      answers[question.id]
        ? [answers[question.id]!]
        : question.required
          ? [{ id: question.id, values: [] }]
          : [],
    );
  const validation = permission.questions
    ?.map((question) =>
      questionAnswerError(
        question,
        answers[question.id] ??
          (question.required ? { id: question.id, values: [] } : undefined),
      ),
    )
    .find(Boolean);
  const asks = !!permission.questions;
  // A lone question is often the title too (Claude, Codex): say it once, in the heading.
  const repeated =
    permission.questions?.length === 1 &&
    permission.questions[0]!.text === permission.title;
  return (
    <section
      className="approval-card"
      data-kind={asks ? "questions" : undefined}
      aria-busy={job.busy}
    >
      <div className="approval-heading">
        <span className="approval-icon">
          <Icon name={asks ? "question" : "shield"} />
        </span>
        <div>
          <strong>{asks ? questionTitle(permission.title) : permission.title}</strong>
          <span>{asks ? "Agent 在等你的回答" : "请确认是否允许此操作"}</span>
        </div>
      </div>
      {permission.detail && <pre tabIndex={0}>{permission.detail}</pre>}
      {permission.url && (
        <p className="muted approval-url">{permission.url.url}</p>
      )}
      {permission.tool?.rawInput !== undefined && (
        <pre tabIndex={0} aria-label="待批准的工具参数">
          {typeof permission.tool.rawInput === "string"
            ? permission.tool.rawInput
            : JSON.stringify(permission.tool.rawInput, null, 2)}
        </pre>
      )}
      {permission.tool?.locations?.map((location, index) => (
        <code key={index}>
          {location.path}
          {location.line === undefined ? "" : `:${location.line}`}
        </code>
      ))}
      {permission.tool?.content?.map((content, index) =>
        content.type === "diff" || content.type === "patch" ? (
          <Diff key={index} change={content} />
        ) : content.type === "content" ? (
          <Blocks
            key={index}
            blocks={[content.content]}
            sessionId={sessionId}
            onFile={() => {}}
          />
        ) : null,
      )}
      {permission.questions && (
        <form
          id={formId}
          className="question-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || validation) return;
            void job.run(async () => {
              if (agent)
                await link.call("agents.respond", {
                  agent,
                  requestId: permission.requestId,
                  answers: filled(),
                });
              else
                await actions.answer(sessionId, permission.requestId, filled());
              setSubmitted(true);
            });
          }}
        >
          {permission.questions.map((question) => (
            <FieldSet
              key={question.id}
              className="question-field"
              disabled={disabled}
            >
              <FieldLegend className="question-legend">
                {(question.header || (repeated && question.required)) && (
                  <small className="question-header">
                    {question.header && <span>{question.header}</span>}
                    {repeated && question.required && (
                      <span className="question-required">必填</span>
                    )}
                  </small>
                )}
                <span className={repeated ? "sr-only" : "question-text"}>
                  {question.text}
                  {!repeated && question.required && (
                    <span className="question-required">必填</span>
                  )}
                </span>
              </FieldLegend>
              {question.kind === "text" ? (
                <Input
                  aria-label={question.text}
                  type={
                    question.secret
                      ? "password"
                      : question.constraints?.type === "integer" ||
                          question.constraints?.type === "number"
                        ? "number"
                        : question.constraints?.format === "email"
                          ? "email"
                          : "text"
                  }
                  min={question.constraints?.minimum}
                  max={question.constraints?.maximum}
                  step={question.constraints?.type === "integer" ? 1 : "any"}
                  minLength={question.constraints?.minLength}
                  maxLength={question.constraints?.maxLength}
                  autoComplete="off"
                  required={question.required}
                  disabled={disabled}
                  aria-invalid={
                    !!answers[question.id] &&
                    !!questionAnswerError(question, answers[question.id])
                  }
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
                  {question.kind === "choice" ? (
                    <RadioGroup
                      className="choice-list"
                      disabled={disabled}
                      value={answers[question.id]?.values[0] ?? ""}
                      onValueChange={(value) =>
                        setAnswers((previous) => ({
                          ...previous,
                          [question.id]: {
                            ...previous[question.id],
                            id: question.id,
                            values: [value],
                          },
                        }))
                      }
                      aria-label={question.text}
                    >
                      {question.options?.map((option) => (
                        <Label className={choiceOption} key={option.value}>
                          <RadioGroupItem value={option.value} />
                          <OptionText option={option} />
                        </Label>
                      ))}
                    </RadioGroup>
                  ) : (
                    <div
                      className="choice-list grid w-full gap-2"
                      role="group"
                      aria-label={question.text}
                    >
                      {question.options?.map((option) => (
                        <Label className={choiceOption} key={option.value}>
                          <Checkbox
                            disabled={disabled}
                            checked={
                              answers[question.id]?.values.includes(
                                option.value,
                              ) ?? false
                            }
                            onCheckedChange={(checked) =>
                              setAnswers((previous) => ({
                                ...previous,
                                [question.id]: {
                                  ...previous[question.id],
                                  id: question.id,
                                  values:
                                    checked === true
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
                              }))
                            }
                          />
                          <OptionText option={option} />
                        </Label>
                      ))}
                    </div>
                  )}
                  {question.other && (
                    <Input
                      disabled={disabled}
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
              {answers[question.id] &&
              questionAnswerError(question, answers[question.id]) ? (
                <small className="danger-text">
                  {questionAnswerError(question, answers[question.id])}
                </small>
              ) : null}
            </FieldSet>
          ))}
        </form>
      )}
      <div className="permission-buttons">
        {permission.options.map((option, index) => (
          <Button
            type="button"
            // One primary: the first allow is the answer most people give; the rest stay secondary.
            variant={index === permission.options.findIndex((entry) => entry.kind.startsWith("allow")) ? "default" : "outline"}
            className="h-auto min-h-9 whitespace-normal"
            key={option.optionId}
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              if (
                permission.url &&
                option.optionId === "accept" &&
                /^https?:\/\//.test(permission.url.url)
              )
                window.open(
                  permission.url.url,
                  "_blank",
                  "noopener,noreferrer",
                );
              void job.run(async () => {
                if (agent)
                  await link.call("agents.respond", {
                    agent,
                    requestId: permission.requestId,
                    optionId: option.optionId,
                  });
                else
                  await actions.respond(
                    sessionId,
                    permission.requestId,
                    option.optionId,
                  );
                setSubmitted(true);
              });
            }}
          >
            {asks ? questionOptionName(option) : option.name}
          </Button>
        ))}
        {asks && (
          // The answer is the one primary, at the end of the row after the ways out.
          <Button
            type="submit"
            form={formId}
            variant="default"
            className="h-auto min-h-9 whitespace-normal"
            disabled={disabled || !!validation}
          >
            {submitted ? "已提交" : job.busy ? "正在提交…" : "提交回答"}
          </Button>
        )}
      </div>
      {!available && (
        <p className="muted" role="status">
          {online ? "会话正在同步，完成后可继续处理。" : "电脑离线，连接恢复后可继续处理。"}已填写的回答会保留。
        </p>
      )}
      {submitted && (
        <p className="muted" role="status">
          已提交，等待 Agent 继续。
        </p>
      )}
      <ErrorNotice error={job.error} />
    </section>
  );
}
