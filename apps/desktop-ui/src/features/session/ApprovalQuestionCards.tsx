import { useEffect, useId, useMemo, useState } from "react";
import {
  permissionContent,
  questionOptionName,
  questionTitle,
  recommendedLabel,
} from "@linkshell/client-core";
import {
  permissionChoices,
  questionAnswerError,
  type AsyncQuestion,
  type PendingPermissionSummary,
  type PermissionChoice,
  type Question,
  type QuestionAnswer,
} from "@linkshell/wire";
import { openExternalUrl } from "@/bridge/desktop-bridge";
import { reportDesktopError, useT, type Connection } from "@/core";
import { DesktopIcon } from "@/icons";
import { Badge, Button, Input, isImeComposing, useDialogs } from "@/primitives";
import { DiffBlock } from "./DiffBlock";
import { MarkdownView } from "./MarkdownView";
import {
  describeActionError,
  reportOnFailure,
  useClientSelector,
  useSessionCopy,
} from "./session-helpers";

type QuestionOption = NonNullable<Question["options"]>[number];

export interface ApprovalCardProps {
  permission: PendingPermissionSummary;
  connection: Connection;
  /** Session ID when resolving inside a session; omit when `agent` is set for pre-session ACP auth/questions. */
  sessionId?: string;
  /** Agent ID for pre-session `agents.respond` interactions on NewSessionWorkspace. */
  agent?: string;
  cwd?: string;
  sessionKey?: string;
}

export function ApprovalCard({
  permission,
  connection,
  sessionId,
  agent,
  cwd,
  sessionKey,
}: ApprovalCardProps) {
  const t = useT();
  const copy = useSessionCopy();
  const dialogs = useDialogs();
  const formId = useId();
  const online = useClientSelector(connection, (s) => s.status === "online", false);

  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | undefined>();

  const defaults = useMemo(
    () =>
      Object.fromEntries(
        (permission.questions ?? [])
          .filter((question) => question.defaults !== undefined)
          .map((question) => [
            question.id,
            { id: question.id, values: [...question.defaults!] },
          ]),
      ),
    [permission.questions],
  );

  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>(defaults);
  const [otherChecked, setOtherChecked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setAnswers(defaults);
    setOtherChecked({});
    setSubmitted(false);
    setErrorMsg(undefined);
  }, [permission.requestId, defaults]);

  const asks = Boolean(permission.questions && permission.questions.length > 0);
  const body = useMemo(() => permissionContent(permission), [permission]);

  /**
   * Sacred visual-system invariant:
   * Tool approvals ALWAYS use `permissionChoices(permission.options)` so button order is strictly
   * `拒绝` -> `允许` -> `始终允许` -> `停止` regardless of agent ordering or language.
   */
  const choices: (Omit<PermissionChoice, "role"> & Partial<Pick<PermissionChoice, "role">>)[] =
    useMemo(
      () =>
        asks
          ? permission.options.map((option) => ({
              option,
              label: questionOptionName(option),
            }))
          : permissionChoices(permission.options),
      [asks, permission.options],
    );

  const validationError = useMemo(() => {
    if (!asks || !permission.questions) return undefined;
    return permission.questions
      .map((question) =>
        questionAnswerError(
          question,
          answers[question.id] ??
            (question.required ? { id: question.id, values: [] } : undefined),
        ),
      )
      .find(Boolean);
  }, [answers, asks, permission.questions]);

  const repeatedSingleQuestion =
    permission.questions?.length === 1 &&
    permission.questions[0]!.text.trim() === permission.title.trim();

  const rawInputText = useMemo(() => {
    const raw = body.rawInput;
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === body.detail?.trim() || trimmed === permission.title.trim()) {
        return undefined;
      }
      return raw;
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const entries = Object.entries(raw as Record<string, unknown>).filter(
        ([, val]) => val !== undefined && val !== "",
      );
      if (entries.length === 0) return undefined;
      const coveredKeys = new Set(["command", "cmd", "description", "workdir", "cwd"]);
      if (body.detail && entries.every(([k]) => coveredKeys.has(k))) return undefined;
    }
    return JSON.stringify(raw, null, 2);
  }, [body.detail, body.rawInput, permission.title]);

  const hasPrimarySummary = Boolean(body.detail || body.markdown || body.content.length > 0);
  const disabled = !online || busy || submitted;

  const invokeOption = async (optionId: string) => {
    if (disabled) return;
    setBusy(true);
    setErrorMsg(undefined);
    try {
      if (agent && !sessionId) {
        await connection.link.call("agents.respond", {
          agent,
          requestId: permission.requestId,
          optionId,
        });
      } else if (sessionId) {
        await connection.store.getState().respond(sessionId, permission.requestId, optionId);
      }
      setSubmitted(true);
    } catch (error) {
      setErrorMsg(describeActionError(error, copy.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  const submitQuestionAnswers = async () => {
    if (disabled || !permission.questions) return;
    if (validationError) {
      setErrorMsg(validationError);
      return;
    }
    const payload: QuestionAnswer[] = permission.questions.flatMap((question) => {
      const current = answers[question.id];
      if (current) return [current];
      return question.required ? [{ id: question.id, values: [] }] : [];
    });

    setBusy(true);
    setErrorMsg(undefined);
    try {
      if (agent && !sessionId) {
        await connection.link.call("agents.respond", {
          agent,
          requestId: permission.requestId,
          answers: payload,
        });
      } else if (sessionId) {
        await connection.store.getState().answer(sessionId, permission.requestId, payload);
      }
      setSubmitted(true);
    } catch (error) {
      setErrorMsg(describeActionError(error, copy.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  const handleConsentUrlClick = async () => {
    if (!permission.url) return;
    const confirmed = await dialogs.confirm(copy.urlConsentWarning(permission.url.url), {
      confirmLabel: copy.openConsentUrl,
    });
    if (confirmed) {
      openExternalUrl(permission.url.url);
    }
  };

  const updateAnswer = (questionId: string, updater: (prev: QuestionAnswer) => QuestionAnswer) => {
    setAnswers((prev) => {
      const current = prev[questionId] ?? { id: questionId, values: [] };
      return {
        ...prev,
        [questionId]: updater(current),
      };
    });
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (
      !asks ||
      disabled ||
      !permission.questions ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isImeComposing(event)
    ) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable ||
      (target instanceof HTMLInputElement &&
        target.type !== "radio" &&
        target.type !== "checkbox")
    ) {
      return;
    }

    if (event.key < "1" || event.key > "9") return;

    const focusedQuestionId = target
      ?.closest("[data-question-id]")
      ?.getAttribute("data-question-id");
    const targetQuestion = focusedQuestionId
      ? permission.questions.find((q) => q.id === focusedQuestionId)
      : permission.questions.length === 1
        ? permission.questions[0]
        : undefined;

    if (!targetQuestion || targetQuestion.kind === "text") return;

    const idx = Number(event.key) - 1;
    const opts = targetQuestion.options ?? [];

    if (idx < opts.length) {
      event.preventDefault();
      const chosen = opts[idx]!;
      if (targetQuestion.kind === "choices") {
        updateAnswer(targetQuestion.id, (prev) => {
          const set = new Set(prev.values);
          if (set.has(chosen.value)) set.delete(chosen.value);
          else set.add(chosen.value);
          return { ...prev, values: [...set] };
        });
      } else {
        setOtherChecked((prev) => ({ ...prev, [targetQuestion.id]: false }));
        updateAnswer(targetQuestion.id, (prev) => ({
          ...prev,
          values: [chosen.value],
          other: undefined,
        }));
      }
    } else if (targetQuestion.other && idx === opts.length) {
      event.preventDefault();
      if (targetQuestion.kind === "choices") {
        const nextChecked = !otherChecked[targetQuestion.id];
        setOtherChecked((prev) => ({ ...prev, [targetQuestion.id]: nextChecked }));
        if (!nextChecked) {
          updateAnswer(targetQuestion.id, (prev) => ({ ...prev, other: undefined }));
        }
      } else {
        setOtherChecked((prev) => ({ ...prev, [targetQuestion.id]: true }));
        updateAnswer(targetQuestion.id, (prev) => ({ ...prev, values: [] }));
      }
    }
  };

  return (
    <section
      className="ls-approval-card"
      data-kind={asks ? "questions" : "permission"}
      aria-busy={busy}
      tabIndex={asks && !disabled ? -1 : undefined}
      onKeyDown={handleCardKeyDown}
    >
      <div className="ls-approval-header">
        <span className="ls-approval-icon" aria-hidden="true">
          <DesktopIcon name={asks ? "help-circle" : "approval-shield"} size="xs" />
        </span>
        <div className="ls-approval-title">
          {asks ? questionTitle(permission.title) : permission.title}
        </div>
      </div>

      <div className="ls-approval-body">
        {body.detail && (
          <pre className="ls-approval-pre" tabIndex={0}>
            {body.detail}
          </pre>
        )}

        {body.markdown && (
          <MarkdownView
            text={body.markdown}
            computerKey={connection.computer.key}
            sessionId={sessionId}
            cwd={cwd}
          />
        )}

        {body.content.map((entry, idx) => {
          if (entry.type === "diff" || entry.type === "patch") {
            return (
              <DiffBlock
                key={idx}
                change={entry}
                computerKey={connection.computer.key}
                sessionId={sessionId}
                sessionKey={sessionKey}
              />
            );
          }
          if (entry.type === "content" && entry.content.type === "text") {
            return (
              <pre key={idx} className="ls-approval-pre" tabIndex={0}>
                {entry.content.text}
              </pre>
            );
          }
          return null;
        })}

        {permission.url && (
          <div>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon="external-link"
              onClick={() => reportOnFailure(handleConsentUrlClick())}
            >
              {copy.openConsentUrl}
            </Button>
          </div>
        )}

        {rawInputText !== undefined &&
          (hasPrimarySummary ? (
            <details className="ls-approval-raw">
              <summary>{copy.viewFullParams}</summary>
              <pre
                className="ls-approval-pre"
                tabIndex={0}
                aria-label={copy.toolParamsAria}
                style={{ marginTop: 6 }}
              >
                {rawInputText}
              </pre>
            </details>
          ) : (
            <pre className="ls-approval-pre" tabIndex={0} aria-label={copy.toolParamsAria}>
              {rawInputText}
            </pre>
          ))}

        {asks &&
          permission.questions?.map((question) => (
            <QuestionFieldset
              key={question.id}
              formId={formId}
              question={question}
              hidePromptText={repeatedSingleQuestion}
              answer={answers[question.id]}
              otherOpen={Boolean(otherChecked[question.id])}
              disabled={disabled}
              recommendedBadge={t("desktop.timeline.recommended")}
              copy={copy}
              onToggleSingle={(value) => {
                setOtherChecked((prev) => ({ ...prev, [question.id]: false }));
                updateAnswer(question.id, (prev) => ({
                  ...prev,
                  values: [value],
                  other: undefined,
                }));
              }}
              onToggleMulti={(value, checked) => {
                updateAnswer(question.id, (prev) => {
                  const set = new Set(prev.values);
                  if (checked) set.add(value);
                  else set.delete(value);
                  return { ...prev, values: [...set] };
                });
              }}
              onToggleOther={(checked) => {
                setOtherChecked((prev) => ({ ...prev, [question.id]: checked }));
                if (question.kind === "choice" && checked) {
                  updateAnswer(question.id, (prev) => ({ ...prev, values: [] }));
                }
                if (!checked) {
                  updateAnswer(question.id, (prev) => ({ ...prev, other: undefined }));
                }
              }}
              onOtherText={(otherText) => {
                updateAnswer(question.id, (prev) => ({
                  ...prev,
                  other: otherText || undefined,
                }));
              }}
              onTextInput={(textVal) => {
                updateAnswer(question.id, (prev) => ({
                  ...prev,
                  values: textVal ? [textVal] : [],
                }));
              }}
              onSubmitEnter={() => void submitQuestionAnswers()}
            />
          ))}

        {errorMsg && (
          <div className="ls-composer-send-error" role="alert">
            {errorMsg}
          </div>
        )}
      </div>

      <div className="ls-approval-actions">
        {asks ? (
          <>
            {choices.map((choice) => (
              <Button
                key={choice.option.optionId}
                variant="secondary"
                disabled={disabled}
                onClick={() => void invokeOption(choice.option.optionId)}
              >
                {choice.label}
              </Button>
            ))}
            <Button
              variant="primary"
              loading={busy}
              disabled={disabled || Boolean(validationError)}
              onClick={() => void submitQuestionAnswers()}
            >
              {copy.submitAnswers}
            </Button>
          </>
        ) : (
          choices.map((choice) => {
            // 审批卡: only 允许 is the filled primary; 拒绝, 始终允许 and 停止 are all secondary.
            const variant = choice.role === "allow" ? "primary" : "secondary";
            return (
              <Button
                key={choice.option.optionId}
                variant={variant}
                disabled={disabled}
                onClick={() => void invokeOption(choice.option.optionId)}
              >
                {choice.label}
              </Button>
            );
          })
        )}
      </div>
    </section>
  );
}

interface QuestionFieldsetProps {
  formId: string;
  question: Question;
  hidePromptText: boolean;
  answer: QuestionAnswer | undefined;
  otherOpen: boolean;
  disabled: boolean;
  recommendedBadge: string;
  copy: ReturnType<typeof useSessionCopy>;
  onToggleSingle: (value: string) => void;
  onToggleMulti: (value: string, checked: boolean) => void;
  onToggleOther: (checked: boolean) => void;
  onOtherText: (text: string) => void;
  onTextInput: (text: string) => void;
  onSubmitEnter: () => void;
}

function QuestionFieldset({
  formId,
  question,
  hidePromptText,
  answer,
  otherOpen,
  disabled,
  recommendedBadge,
  copy,
  onToggleSingle,
  onToggleMulti,
  onToggleOther,
  onOtherText,
  onTextInput,
  onSubmitEnter,
}: QuestionFieldsetProps) {
  const selectedValues = answer?.values ?? [];
  const radioName = `${formId}-${question.id}`;

  const choiceKind = question.kind === "choices" ? "checkbox" : "radio";
  const otherIndex = (question.options?.length ?? 0) + 1;

  return (
    <fieldset
      className="ls-question-fieldset"
      data-question-id={question.id}
      disabled={disabled}
    >
      {(question.header || !hidePromptText) && (
        <legend className="ls-question-legend">
          {question.header && (
            <Badge tone="neutral" style={{ marginInlineEnd: 6 }}>
              {question.header}
            </Badge>
          )}
          {!hidePromptText ? question.text : null}
        </legend>
      )}

      {question.kind === "text" ? (
        <Input
          type={question.secret ? "password" : "text"}
          value={selectedValues[0] ?? ""}
          placeholder={copy.answerPlaceholder}
          onChange={(e) => onTextInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isImeComposing(e)) {
              e.preventDefault();
              onSubmitEnter();
            }
          }}
        />
      ) : (
        <div className="ls-question-options">
          {(question.options ?? []).map((option, idx) => {
            const isChecked = selectedValues.includes(option.value);
            return (
              <QuestionChoiceRow
                key={option.value}
                index={idx + 1}
                name={radioName}
                kind={choiceKind}
                option={option}
                checked={isChecked}
                recommendedBadge={recommendedBadge}
                onChange={(checked) => {
                  if (question.kind === "choices") {
                    onToggleMulti(option.value, checked);
                  } else if (checked) {
                    onToggleSingle(option.value);
                  }
                }}
              />
            );
          })}

          {question.other && (
            <div>
              <label className="ls-question-option" data-checked={otherOpen}>
                <input
                  type={choiceKind}
                  name={radioName}
                  checked={otherOpen}
                  className="ls-sr-only ls-question-native-input"
                  onChange={(e) => onToggleOther(e.target.checked)}
                />
                <span
                  className="ls-question-keycap"
                  data-kind={choiceKind}
                  data-checked={otherOpen ? "true" : undefined}
                  aria-hidden="true"
                >
                  {otherOpen ? (
                    <DesktopIcon name="check" size="xs" />
                  ) : choiceKind === "radio" ? (
                    otherIndex
                  ) : null}
                </span>
                <span className="ls-question-option-body">
                  <span className="ls-question-option-label">{copy.otherOption}</span>
                </span>
              </label>
              {otherOpen && (
                <div style={{ marginTop: 6 }}>
                  <Input
                    type={question.secret ? "password" : "text"}
                    value={answer?.other ?? ""}
                    placeholder={copy.otherPlaceholder}
                    onChange={(e) => onOtherText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !isImeComposing(e)) {
                        e.preventDefault();
                        onSubmitEnter();
                      }
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}

function QuestionChoiceRow({
  index,
  name,
  kind,
  option,
  checked,
  recommendedBadge,
  onChange,
}: {
  index: number;
  name: string;
  kind: "radio" | "checkbox";
  option: QuestionOption;
  checked: boolean;
  recommendedBadge: string;
  onChange: (checked: boolean) => void;
}) {
  const { text, recommended } = recommendedLabel(option.label);
  return (
    <label className="ls-question-option" data-checked={checked}>
      <input
        type={kind}
        name={name}
        checked={checked}
        className="ls-sr-only ls-question-native-input"
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className="ls-question-keycap"
        data-kind={kind}
        data-checked={checked ? "true" : undefined}
        aria-hidden="true"
      >
        {checked ? (
          <DesktopIcon name="check" size="xs" />
        ) : kind === "radio" ? (
          index
        ) : null}
      </span>
      <span className="ls-question-option-body">
        <span className="ls-question-option-label">
          <span>{text}</span>
          {recommended && (
            <span className="ls-question-recommended-pill">{recommendedBadge}</span>
          )}
        </span>
        {option.description && (
          <span className="ls-question-option-desc">{option.description}</span>
        )}
      </span>
    </label>
  );
}

/* ============================================================================
 * Non-Blocking Async Questions (`AsyncQuestion[]` during active turns)
 * ============================================================================ */

export interface AsyncQuestionsBarProps {
  questions: readonly AsyncQuestion[];
  connection: Connection;
  sessionId: string;
}

export function AsyncQuestionsBar({
  questions,
  connection,
  sessionId,
}: AsyncQuestionsBarProps) {
  const copy = useSessionCopy();
  const online = useClientSelector(connection, (s) => s.status === "online", false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  if (questions.length === 0) return null;

  const sendReply = async (question: AsyncQuestion, value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !online || busyId) return;
    setBusyId(question.id);
    try {
      await connection.store.getState().answerAsync(sessionId, question, trimmed);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
    } catch (error) {
      reportDesktopError(error);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {questions.map((question) => {
        const draft = drafts[question.id] ?? "";
        const isBusy = busyId === question.id;
        return (
          <div key={question.id} className="ls-async-question-card" aria-busy={isBusy}>
            <div className="ls-async-question-header">
              <span className="ls-approval-icon" aria-hidden="true">
                <DesktopIcon name="help-circle" size="xs" />
              </span>
              <span className="ls-approval-title">{question.title}</span>
              <span className="ls-question-recommended-pill" style={{ marginInlineStart: "auto" }}>
                {copy.asyncQuestionBadge}
              </span>
            </div>
            <div className="ls-async-question-body">
              {question.options.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {question.options.map((opt) => {
                    const { text } = recommendedLabel(opt);
                    return (
                      <Button
                        key={opt}
                        variant="secondary"
                        size="sm"
                        disabled={!online || isBusy}
                        onClick={() => void sendReply(question, opt)}
                      >
                        {text}
                      </Button>
                    );
                  })}
                </div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <Input
                  value={draft}
                  placeholder={copy.answerPlaceholder}
                  disabled={!online || isBusy}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [question.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isImeComposing(e)) {
                      e.preventDefault();
                      void sendReply(question, draft);
                    }
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={isBusy}
                  disabled={!online || isBusy || !draft.trim()}
                  onClick={() => void sendReply(question, draft)}
                >
                  {copy.replyAction}
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
