import { useEffect, useMemo, useRef, useState } from "react";
import {
  emptyView,
  shownQueue,
  userMessageText,
  type ClientState,
  type QueueEntry,
  type SessionView,
} from "@linkshell/client-core";
import type {
  SessionConfigOption,
  SessionSummary,
} from "@linkshell/wire";
import {
  diffReviewStore,
  draftKeyFor,
  finishComposerSend,
  formatDiffReviewPrompt,
  reportDesktopError,
  routerStore,
  useComposerDraft,
  useDiffReviews,
  useT,
  type Connection,
  type PastedTextBlock,
} from "@/core";
import { AgentMark, DesktopIcon } from "@/icons";
import {
  Button,
  IconButton,
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  StatusDot,
  Tooltip,
} from "@/primitives";
import { ComposerBox } from "./ComposerBox";
import { openInspectorTab, openSubagentInInspector } from "../inspector";
import {
  buildPromptContentBlocks,
  buildSessionCommands,
  configCategoryIcon,
  configOptionDisplayLabel,
  configValueDisplayName,
  parseSlashCommandInput,
  revokeAttachmentPreviews,
  sessionKeyOf,
  useClientSelector,
  useSessionCopy,
  type ComposerAttachment,
} from "./session-helpers";

const EMPTY_OUTBOX: ClientState["outbox"] = {};
const EMPTY_SUBAGENTS: NonNullable<ClientState["subagents"][string]> = [];

export interface SessionComposerProps {
  connection: Connection;
  session: SessionSummary;
  view?: SessionView;
  onSystemFeedback?: (message: string) => void;
}

export function SessionComposer({
  connection,
  session,
  view: passedView,
  onSystemFeedback,
}: SessionComposerProps) {
  const t = useT();
  const copy = useSessionCopy();
  const computerKey = connection.computer.key;
  const sessionKey = sessionKeyOf(computerKey, session.id);

  const online = useClientSelector(connection, (s) => s.status === "online", false);
  const storeView = useClientSelector(
    connection,
    (s) => s.views[session.id],
    undefined,
  );
  const view = passedView ?? storeView ?? emptyView(session.id);

  const queueing = useClientSelector(
    connection,
    (s) => s.queueing[session.id],
    undefined,
  );
  const outboxMap = useClientSelector(connection, (s) => s.outbox, EMPTY_OUTBOX);
  const storeSubagents = useClientSelector(
    connection,
    (s) => s.subagents[session.id] ?? EMPTY_SUBAGENTS,
    EMPTY_SUBAGENTS,
  );
  const sessionOutbox = useMemo(
    () =>
      Object.entries(outboxMap)
        .filter(([, item]) => item.sessionId === session.id)
        .map(([clientMessageId, item]) => ({ clientMessageId, ...item })),
    [outboxMap, session.id],
  );

  // Live running subagents pill (shown only while subagents are actively running)
  const subagentSummary = useMemo(() => {
    let spawnedCount = 0;
    let spawnedRunning = 0;
    let latestItemId: string | undefined;
    let latestTitle: string | undefined;
    let latestAgent: string | undefined;
    for (const item of view.items) {
      if (
        item.kind === "tool" &&
        item.detail?.type === "subagent" &&
        item.detail.action === "spawn"
      ) {
        spawnedCount += 1;
        latestItemId = item.id;
        latestTitle = item.detail.name || item.detail.agentType;
        latestAgent = item.detail.agentType;
        const st = item.detail.workflow?.state ?? item.detail.state;
        const active =
          st === "running" ||
          (!st && (item.status === "in_progress" || item.status === "pending"));
        if (active) spawnedRunning += 1;
      }
    }
    if (storeSubagents.length > spawnedCount) {
      const activeStore = storeSubagents.filter((s) => s.state === "running").length;
      const fallback = storeSubagents[storeSubagents.length - 1];
      return {
        count: storeSubagents.length,
        running: Math.max(spawnedRunning, activeStore),
        latestItemId: latestItemId ?? fallback?.toolCallId,
        latestTitle: latestTitle ?? fallback?.name ?? fallback?.agentType,
        latestAgent: latestAgent ?? fallback?.agentType,
      };
    }
    return {
      count: spawnedCount,
      running: spawnedRunning,
      latestItemId,
      latestTitle,
      latestAgent,
    };
  }, [storeSubagents, view.items]);

  const hasStatusPills = subagentSummary.running > 0;

  const queueItems = useMemo(
    () => shownQueue(session.queue, queueing),
    [queueing, session.queue],
  );

  const reviews = useDiffReviews(sessionKey);

  const draftKey = draftKeyFor(computerKey, session.id);
  const { text, setText, clearSubmitted } = useComposerDraft(draftKey);

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pastedBlocks, setPastedBlocks] = useState<PastedTextBlock[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>();

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(
    () => () => {
      revokeAttachmentPreviews(attachmentsRef.current);
    },
    [],
  );

  const isRunning = session.state === "running" || view.turnActive;
  const driver = view.driver ?? session.driver;
  const desktopDriven = driver === "desktop";

  const commands = useMemo(
    () => buildSessionCommands(session.agent, view.commands),
    [session.agent, view.commands],
  );

  // Order config options cleanly: model -> mode -> effort -> other
  const orderedConfigs = useMemo(() => {
    const rank: Record<string, number> = {
      model: 0,
      mode: 1,
      effort: 2,
      model_config: 3,
      other: 4,
    };
    return [...(view.config ?? [])]
      .filter((opt) => opt.values.length > 0)
      .sort((a, b) => (rank[a.category] ?? 9) - (rank[b.category] ?? 9));
  }, [view.config]);

  const modeOption = useMemo(
    () => orderedConfigs.find((opt) => opt.category === "mode"),
    [orderedConfigs],
  );
  const modelOption = useMemo(
    () => orderedConfigs.find((opt) => opt.category === "model"),
    [orderedConfigs],
  );

  const hasSendablePayload =
    Boolean(text.trim()) || attachments.length > 0 || pastedBlocks.length > 0;

  const handleSetConfig = async (option: SessionConfigOption, nextValue: string) => {
    if (!online || nextValue === option.current) return;
    try {
      await connection.store.getState().setConfig(session.id, option.id, nextValue);
    } catch (error) {
      reportDesktopError(error);
    }
  };

  const handleCycleMode = () => {
    if (!modeOption || modeOption.values.length < 2) return;
    const currentIndex = modeOption.values.findIndex((v) => v.value === modeOption.current);
    const nextEntry = modeOption.values[(currentIndex + 1) % modeOption.values.length];
    if (nextEntry) {
      void handleSetConfig(modeOption, nextEntry.value);
    }
  };

  const handleLocalSlashCommand = async (): Promise<boolean> => {
    if (attachments.length > 0 || pastedBlocks.length > 0) return false;
    const parsed = parseSlashCommandInput(text);
    if (!parsed) return false;

    const actions = connection.store.getState();

    if (parsed.name === "new" || parsed.name === "reset" || parsed.name === "clear") {
      clearSubmitted(text);
      routerStore.getState().openNewSession(computerKey, session.worktree?.source ?? session.cwd);
      return true;
    }

    if (parsed.name === "stop" || parsed.name === "cancel") {
      clearSubmitted(text);
      if (isRunning) {
        await actions.cancel(session.id);
      }
      return true;
    }

    if (parsed.name === "model" && modelOption) {
      if (!parsed.rest) {
        clearSubmitted(text);
        onSystemFeedback?.(
          `${t("desktop.composer.model")}: ${configOptionDisplayLabel(modelOption)}`,
        );
        return true;
      }
      const matched = modelOption.values.find(
        (v) =>
          v.value.toLowerCase() === parsed.rest.toLowerCase() ||
          v.name.toLowerCase().includes(parsed.rest.toLowerCase()),
      );
      if (matched) {
        clearSubmitted(text);
        await handleSetConfig(modelOption, matched.value);
        return true;
      }
    }

    if ((parsed.name === "mode" || parsed.name === "permissions") && modeOption) {
      if (!parsed.rest) {
        clearSubmitted(text);
        onSystemFeedback?.(
          `${t("desktop.composer.mode")}: ${configOptionDisplayLabel(modeOption)}`,
        );
        return true;
      }
      const matched = modeOption.values.find(
        (v) =>
          v.value.toLowerCase() === parsed.rest.toLowerCase() ||
          v.name.toLowerCase().includes(parsed.rest.toLowerCase()),
      );
      if (matched) {
        clearSubmitted(text);
        await handleSetConfig(modeOption, matched.value);
        return true;
      }
    }

    if (parsed.name === "status") {
      clearSubmitted(text);
      const used = view.usage?.usedTokens ?? view.usage?.tokens?.totalTokens;
      const win = view.usage?.contextWindow;
      const usageNote =
        used !== undefined && win
          ? ` · ${Math.round((used / win) * 100)}% (${used.toLocaleString()}/${win.toLocaleString()})`
          : "";
      onSystemFeedback?.(`${session.agent} · ${session.cwd}${usageNote}`);
      return true;
    }

    return false;
  };

  const submitMessage = async (options?: { steerNow?: boolean; overrideText?: string }) => {
    if (!online || sending) return;
    setSendError(undefined);

    if (options?.overrideText === undefined) {
      try {
        if (await handleLocalSlashCommand()) return;
      } catch (error) {
        reportDesktopError(error);
        return;
      }
    }

    const submittedText = options?.overrideText ?? text;
    const useOverride = options?.overrideText !== undefined;
    const currentAttachments = useOverride ? [] : attachments;
    const currentPasted = useOverride ? [] : pastedBlocks;

    if (!submittedText.trim() && currentAttachments.length === 0 && currentPasted.length === 0) {
      return;
    }

    setSending(true);
    try {
      const uploadDir = `${session.cwd.replace(/[\\/]+$/, "")}/.linkshell/uploads`;
      const blocks = await buildPromptContentBlocks({
        text: submittedText,
        pastedBlocks: currentPasted,
        attachments: currentAttachments,
        cwd: session.cwd,
        uploadFile: ({ name, data }) =>
          connection.link.call("fs.upload", { dir: uploadDir, name, data }),
      });

      if (blocks.length === 0) return;

      const deliveryPromise = connection.store.getState().send(session.id, blocks, {
        now: Boolean(options?.steerNow),
      });

      /**
       * Sacred draft preservation rule (`finishComposerSend`):
       * Draft & attachments clear ONLY when Host confirms delivery; on `"failed"`, user input stays intact!
       */
      await finishComposerSend(deliveryPromise, () => {
        if (!useOverride) {
          clearSubmitted(submittedText);
          revokeAttachmentPreviews(currentAttachments);
          setAttachments([]);
          setPastedBlocks([]);
        }
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSendError(msg);
      reportDesktopError(error);
    } finally {
      setSending(false);
    }
  };

  const handleSubmitReviews = async () => {
    if (reviews.length === 0 || !online || sending) return;
    const prompt = formatDiffReviewPrompt(reviews);
    if (!prompt) return;
    await submitMessage({ overrideText: prompt });
    diffReviewStore.getState().clearSession(sessionKey);
  };

  const handleEditQueued = async (entry: QueueEntry) => {
    try {
      const taken = await connection.store.getState().takeQueued(session.id, entry.clientMessageId);
      const extracted = taken ? userMessageText(taken) : entry.text;
      if (extracted) {
        setText((curr) => (curr.trim() ? `${curr}\n\n${extracted}` : extracted));
      }
    } catch (error) {
      reportDesktopError(error);
    }
  };

  const handleMoveQueuedUp = async (index: number) => {
    if (index <= 0) return;
    const ids = queueItems.map((item) => item.clientMessageId);
    const swapped = [...ids];
    const tmp = swapped[index - 1]!;
    swapped[index - 1] = swapped[index]!;
    swapped[index] = tmp;
    try {
      await connection.store.getState().reorderQueue(session.id, swapped);
    } catch (error) {
      reportDesktopError(error);
    }
  };

  return (
    <div className="ls-composer-shell">
      <div className="ls-composer-inner">
        {/* Batch code-review comments banner */}
        {reviews.length > 0 && (
          <div className="ls-composer-review-bar">
            <span>{t("desktop.timeline.submitReview", { count: reviews.length })}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => diffReviewStore.getState().clearSession(sessionKey)}
              >
                {copy.clearReviews}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leadingIcon="send-to-agent"
                disabled={!online || sending}
                onClick={() => void handleSubmitReviews()}
              >
                {t("desktop.composer.send")}
              </Button>
            </div>
          </div>
        )}

        {/* Failed outbox quick-retry bar */}
        {sessionOutbox.map((failed) => (
          <div
            key={failed.clientMessageId}
            className="ls-composer-queue-bar"
            style={{ borderColor: "color-mix(in srgb, var(--ls-danger) 35%, var(--ls-border-subtle))" }}
          >
            <div className="ls-composer-queue-row">
              <DesktopIcon name="alert-circle" size="xs" />
              <span className="ls-composer-queue-text">
                {userMessageText(failed.content) || copy.failedDelivery}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!online}
                onClick={() => void connection.store.getState().retry(failed.clientMessageId)}
              >
                {copy.retryFailed}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => connection.store.getState().discard(failed.clientMessageId)}
              >
                {copy.discardFailed}
              </Button>
            </div>
          </div>
        ))}

        {/* Editable queued follow-ups bar (`shownQueue`) */}
        {queueItems.length > 0 && (
          <div className="ls-composer-queue-bar">
            <div className="ls-composer-queue-head">
              <span>{t("desktop.composer.queuedCount", { count: queueItems.length })}</span>
            </div>
            {queueItems.map((entry, idx) => (
              <div key={entry.clientMessageId} className="ls-composer-queue-row">
                <DesktopIcon name="clock" size="xs" />
                <span className="ls-composer-queue-text">{entry.text}</span>
                {!entry.pending && (
                  <>
                    <Tooltip content={t("desktop.composer.sendNow")}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!online}
                        onClick={() =>
                          void connection.store
                            .getState()
                            .sendQueuedNow(session.id, entry.clientMessageId)
                        }
                      >
                        {t("desktop.composer.sendNow")}
                      </Button>
                    </Tooltip>
                    <Tooltip content={t("desktop.composer.editQueued")}>
                      <IconButton
                        icon="edit"
                        size="icon-sm"
                        label={t("desktop.composer.editQueued")}
                        disabled={!online}
                        onClick={() => void handleEditQueued(entry)}
                      />
                    </Tooltip>
                    {idx > 0 && (
                      <Tooltip content={t("desktop.composer.moveUp")}>
                        <IconButton
                          icon="chevron-up"
                          size="icon-sm"
                          label={t("desktop.composer.moveUp")}
                          disabled={!online}
                          onClick={() => void handleMoveQueuedUp(idx)}
                        />
                      </Tooltip>
                    )}
                    <Tooltip content={t("desktop.composer.removeQueued")}>
                      <IconButton
                        icon="close"
                        size="icon-sm"
                        label={t("desktop.composer.removeQueued")}
                        disabled={!online}
                        onClick={() =>
                          void connection.store
                            .getState()
                            .unqueue(session.id, entry.clientMessageId)
                        }
                      />
                    </Tooltip>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Live running subagents status pill (shown only when running > 0) */}
        {hasStatusPills && (
          <div className="ls-composer-status-pills">
            <button
              type="button"
              className="ls-status-pill"
              onClick={() => {
                if (subagentSummary.count === 1 && subagentSummary.latestItemId) {
                  openSubagentInInspector(computerKey, session.id, {
                    toolCallId: subagentSummary.latestItemId,
                    title: subagentSummary.latestTitle,
                    agent: subagentSummary.latestAgent,
                  });
                } else {
                  openInspectorTab(computerKey, session.id, {
                    id: "new-tab",
                    kind: "new-tab",
                  });
                }
              }}
            >
              <StatusDot tone="running" />
              <span>
                {copy.subagentsPillLabel(
                  subagentSummary.count,
                  subagentSummary.running,
                )}
              </span>
            </button>
          </div>
        )}

        {/* Handoff takeover banner when session is currently driven in a local terminal */}
        {desktopDriven ? (
          <div className="ls-composer-box" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: "12px 16px" }}>
            <span style={{ fontSize: 13, color: "var(--ls-fg-2)" }}>
              {copy.desktopDrivenBanner}
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={!online}
              onClick={() => void connection.store.getState().takeover(session.id)}
            >
              {t("desktop.composer.takeover")}
            </Button>
          </div>
        ) : (
          <ComposerBox
            value={text}
            onChange={setText}
            placeholder={isRunning ? copy.composerBusyPlaceholder : copy.composerPlaceholder}
            textareaAriaLabel={t("desktop.composer.placeholder")}
            disabled={!online}
            connection={connection}
            cwd={session.cwd}
            commands={commands}
            attachments={attachments}
            onAddAttachments={(added) => setAttachments((prev) => [...prev, ...added])}
            onRemoveAttachment={(id) =>
              setAttachments((prev) => {
                const target = prev.find((item) => item.id === id);
                if (target) revokeAttachmentPreviews([target]);
                return prev.filter((item) => item.id !== id);
              })
            }
            pastedBlocks={pastedBlocks}
            onAddPastedBlock={(block) => setPastedBlocks((prev) => [...prev, block])}
            onExpandPastedBlock={(id) => {
              const target = pastedBlocks.find((b) => b.id === id);
              if (!target) return;
              setPastedBlocks((prev) => prev.filter((b) => b.id !== id));
              setText((curr) => (curr ? `${curr}\n${target.text}` : target.text));
            }}
            onRemovePastedBlock={(id) =>
              setPastedBlocks((prev) => prev.filter((b) => b.id !== id))
            }
            onSubmit={submitMessage}
            onCycleMode={modeOption ? handleCycleMode : undefined}
            leftControls={
              <>
                {orderedConfigs.map((option) => (
                  <SessionConfigChipMenu
                    key={option.id}
                    agent={session.agent}
                    option={option}
                    disabled={!online}
                    onSelect={(val) => void handleSetConfig(option, val)}
                  />
                ))}
              </>
            }
            rightControls={
              <>
                <ContextUsageRing usage={view.usage} label={t("desktop.composer.contextUsage")} />

                {isRunning && (
                  <Tooltip content={t("desktop.composer.stop")}>
                    <button
                      type="button"
                      className="ls-composer-send-btn"
                      data-stop="true"
                      aria-label={t("desktop.composer.stop")}
                      disabled={!online}
                      onClick={() => void connection.store.getState().cancel(session.id)}
                    >
                      <DesktopIcon name="stop-square" size="sm" />
                    </button>
                  </Tooltip>
                )}

                {isRunning && hasSendablePayload && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!online || sending}
                    onClick={() => void submitMessage({ steerNow: true })}
                  >
                    {t("desktop.composer.steer")}
                  </Button>
                )}

                <Tooltip
                  content={
                    isRunning ? t("desktop.composer.queue") : t("desktop.composer.send")
                  }
                >
                  <button
                    type="button"
                    className="ls-composer-send-btn"
                    aria-label={
                      isRunning ? t("desktop.composer.queue") : t("desktop.composer.send")
                    }
                    disabled={!online || sending || !hasSendablePayload}
                    onClick={() => void submitMessage({ steerNow: false })}
                  >
                    <DesktopIcon name="arrow-up" size="sm" />
                  </button>
                </Tooltip>
              </>
            }
          />
        )}

        {sendError && (
          <div style={{ fontSize: 12, color: "var(--ls-danger)", paddingInline: 4 }} role="alert">
            {sendError}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Mandatory E2E contract (`apps/windows/scripts/model-ui-e2e.mjs`):
 * - Trigger: `button.composer-chip[data-category={option.category}]`
 * - Menu popup: `<Menu className="composer-chip-menu">` (`[data-state="open"]`)
 * - Option row: `<MenuRadioItem>` (`[role="menuitemradio"]`) -> `<span className="composer-chip-option"><span>{label}</span>...</span>`
 */
function SessionConfigChipMenu({
  agent,
  option,
  disabled,
  onSelect,
}: {
  agent: string;
  option: SessionConfigOption;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  const displayLabel = configOptionDisplayLabel(option);
  const iconName = configCategoryIcon(option.category, option.current);

  return (
    <Menu
      className="composer-chip-menu"
      placement="top-start"
      trigger={
        <button
          type="button"
          className="composer-chip ls-composer-chip"
          data-category={option.category}
          disabled={disabled}
          aria-label={option.name}
        >
          {option.category === "model" ? (
            <AgentMark agent={agent} size="xs" />
          ) : (
            <DesktopIcon name={iconName} size="xs" />
          )}
          <span>{displayLabel}</span>
          <DesktopIcon name="chevron-down" size="xs" />
        </button>
      }
    >
      <MenuRadioGroup value={option.current} onValueChange={onSelect}>
        {option.values.map((entry) => (
          <MenuRadioItem key={entry.value} value={entry.value}>
            <span className="composer-chip-option ls-composer-chip-option">
              <span>{configValueDisplayName(option, entry)}</span>
              {entry.description && (
                <span className="ls-composer-chip-desc">{entry.description}</span>
              )}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}

function ContextUsageRing({
  usage,
  label,
}: {
  usage: SessionView["usage"];
  label: string;
}) {
  const used = usage?.usedTokens ?? usage?.tokens?.totalTokens;
  const total = usage?.contextWindow;
  if (used === undefined || !total || total <= 0) return null;

  const pct = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);
  const strokeColor =
    pct >= 90
      ? "var(--ls-danger)"
      : pct >= 75
        ? "var(--ls-waiting)"
        : "var(--ls-accent)";

  return (
    <Tooltip
      content={`${label}: ${pct}% (${used.toLocaleString()} / ${total.toLocaleString()})`}
    >
      <span className="ls-context-ring" aria-label={`${label} ${pct}%`}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="var(--ls-border-strong)"
            strokeWidth="2"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span>{pct}%</span>
      </span>
    </Tooltip>
  );
}
