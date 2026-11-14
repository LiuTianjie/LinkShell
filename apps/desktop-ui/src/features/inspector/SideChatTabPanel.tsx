import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { SideChat } from "@linkshell/wire";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  Menu,
  MenuItem,
  MenuSeparator,
  isImeComposing,
  useDialogs,
} from "../../primitives";
import { MarkdownView } from "../session/MarkdownView";
import { useInspectorI18n } from "./i18n-inspector";
import {
  consumeSideChatRequest,
  usePendingSideChatRequest,
  useSideChatDraft,
} from "./side-chat-store";
import type { InspectorSessionActions } from "./use-inspector-connection";

export interface SideChatTabPanelProps {
  computerKey?: string;
  online: boolean;
  sessionId?: string;
  cwd?: string;
  sides: readonly SideChat[];
  actions?: InspectorSessionActions;
  /** The session's agent answers side questions itself; undefined while that isn't known. */
  supported?: boolean;
  agentLabel?: string;
}

export function SideChatTabPanel({
  computerKey,
  online,
  sessionId,
  cwd,
  sides,
  actions,
  supported,
  agentLabel,
}: SideChatTabPanelProps): JSX.Element {
  const { t, ti } = useInspectorI18n();
  const dialogs = useDialogs();
  const showError = useCallback(
    (err: unknown) => {
      void dialogs.alert(err instanceof Error ? err.message : String(err));
    },
    [dialogs],
  );
  const [selectedSideId, setSelectedSideId] = useState<string | undefined>(
    undefined,
  );
  const { draft, setDraft, clearSubmitted } = useSideChatDraft(computerKey, sessionId);
  const [asking, setAsking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusFrameRef = useRef(0);
  const pendingRequest = usePendingSideChatRequest(computerKey, sessionId);

  // "Ask in side chat" from a selection: a new conversation, the quote in the draft, the
  // caret after it for the question.
  useEffect(() => {
    if (pendingRequest === undefined) return;
    consumeSideChatRequest(computerKey, sessionId);
    setSelectedSideId("__new__");
    // The inspector may still be opening (hidden, or the tab not yet shown): keep trying for a
    // few frames until the box can take focus.
    let tries = 0;
    const focusDraft = () => {
      const area = textareaRef.current;
      if (area && !area.disabled) {
        area.focus();
        if (document.activeElement === area) {
          const end = area.value.length;
          area.setSelectionRange(end, end);
          area.scrollTop = area.scrollHeight;
          return;
        }
      }
      if (++tries < 30) focusFrameRef.current = requestAnimationFrame(focusDraft);
    };
    cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(focusDraft);
  }, [computerKey, pendingRequest, sessionId]);
  // Consuming the request re-runs the effect above, so only leaving cancels the focusing.
  useEffect(() => () => cancelAnimationFrame(focusFrameRef.current), []);

  useEffect(() => {
    if (!online || !sessionId || !actions) return;
    void actions.loadSides().catch(() => undefined);
  }, [actions, online, sessionId]);

  const activeSide = useMemo(() => {
    if (sides.length === 0) return undefined;
    if (selectedSideId === "__new__") return undefined;
    if (selectedSideId) {
      return sides.find((s) => s.sideId === selectedSideId) ?? sides[0];
    }
    return sides[sides.length - 1];
  }, [selectedSideId, sides]);

  const activeThreadIndex = useMemo(() => {
    if (!activeSide) return -1;
    return sides.findIndex((s) => s.sideId === activeSide.sideId);
  }, [activeSide, sides]);

  const activeThreadLabel = useMemo(() => {
    if (!activeSide || activeThreadIndex < 0) {
      return ti("sideNewThread");
    }
    const title = sideThreadTitle(activeSide.messages[0]?.text, 18);
    if (title) return title;
    return ti("sideThreadLabel", { index: activeThreadIndex + 1 });
  }, [activeSide, activeThreadIndex, ti]);

  const submitQuestion = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed || !actions || !online || !sessionId || asking) return;
      setAsking(true);
      try {
        const created = await actions.askSide(trimmed, activeSide?.sideId);
        setSelectedSideId(created.sideId);
        clearSubmitted(rawText);
      } catch (err) {
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      } finally {
        setAsking(false);
      }
    },
    [actions, activeSide?.sideId, asking, clearSubmitted, dialogs, online, sessionId],
  );

  const handleSubmit = useCallback(async () => {
    await submitQuestion(draft);
  }, [draft, submitQuestion]);

  const starterPrompts = useMemo(
    () => [ti("sideStarter1"), ti("sideStarter2"), ti("sideStarter3")],
    [ti],
  );

  const canInteract = Boolean(online && sessionId && actions && !asking && supported !== false);

  if (supported === false && sides.length === 0) {
    return (
      <div
        className="ls-sidechat-panel inspector-panel-fill"
        data-testid="sidechat-tab-panel"
        data-unsupported="true"
      >
        <div className="ls-sidechat-panel__body inspector-panel-scroll">
          <div className="ls-sidechat-empty">
            <span className="ls-sidechat-empty__badge">
              <DesktopIcon name="sparkles" size="sm" />
            </span>
            <strong className="ls-sidechat-empty__title">
              {ti("sideUnsupportedTitle", { agent: agentLabel || "Agent" })}
            </strong>
            <p>{ti("sideUnsupportedHint")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="ls-sidechat-panel inspector-panel-fill"
      data-testid="sidechat-tab-panel"
    >
      <div className="ls-sidechat-panel__body inspector-panel-scroll">
        {activeSide && activeSide.messages.length > 0 ? (
          <div className="ls-sidechat-thread">
            {activeSide.messages.map((msg, idx) => {
              const isLast = idx === activeSide.messages.length - 1;
              return (
                <div
                  key={msg.id}
                  className={`ls-sidechat-msg ls-sidechat-msg--${msg.role}`}
                >
                  {msg.role === "user" ? (
                    <SideUserMessage text={msg.text} />
                  ) : (
                    <div className="ls-sidechat-msg__assistant">
                      <MarkdownView
                        text={msg.text}
                        streaming={Boolean(activeSide.running && isLast)}
                        computerKey={computerKey}
                        sessionId={sessionId}
                        cwd={cwd}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {activeSide.running ? (
              <div>
                <Badge variant="tag" tone="running" dot="running">
                  {ti("loading")}
                </Badge>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ls-sidechat-empty">
            <span className="ls-sidechat-empty__badge">
              <DesktopIcon name="sparkles" size="sm" />
            </span>
            <strong className="ls-sidechat-empty__title">
              {ti("sideEmptyTitle")}
            </strong>
            <p>{ti("sideEmptyHint")}</p>
            <div className="ls-sidechat-starters">
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="ls-sidechat-starter-chip"
                  disabled={!canInteract}
                  onClick={() => {
                    if (canInteract) {
                      void submitQuestion(prompt);
                    } else {
                      setDraft(prompt);
                    }
                  }}
                >
                  <DesktopIcon name="sparkles" size="xs" />
                  <span>{prompt}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <form
        className="ls-sidechat-composer-card"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <textarea
          ref={textareaRef}
          rows={2}
          className="ls-sidechat-textarea"
          value={draft}
          placeholder={ti("sidePlaceholder")}
          aria-label={t("desktop.inspector.side")}
          disabled={!canInteract}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />

        <div className="ls-sidechat-composer-footer">
          {sides.length > 0 ? (
            <Menu
              placement="top-start"
              label={t("desktop.inspector.side")}
              trigger={
                <Button
                  size="xs"
                  variant="ghost"
                  leadingIcon={activeSide?.running ? "spinner" : "sparkles"}
                  trailingIcon="chevron-down"
                >
                  {activeThreadLabel}
                </Button>
              }
            >
              {sides.map((side, index) => {
                const title = sideThreadTitle(side.messages[0]?.text, 24);
                const label = title
                  ? title
                  : ti("sideThreadLabel", { index: index + 1 });
                return (
                  <MenuItem
                    key={side.sideId}
                    icon={side.running ? "spinner" : "sparkles"}
                    onSelect={() => setSelectedSideId(side.sideId)}
                  >
                    {label}
                  </MenuItem>
                );
              })}
              <MenuSeparator />
              <MenuItem
                icon="plus"
                onSelect={() => setSelectedSideId("__new__")}
              >
                {ti("sideNewThread")}
              </MenuItem>
              {activeSide && actions ? (
                <MenuItem
                  icon="trash"
                  destructive
                  onSelect={() => {
                    actions.closeSide(activeSide.sideId).catch(showError);
                    setSelectedSideId(undefined);
                  }}
                >
                  {ti("closeSide")}
                </MenuItem>
              ) : null}
            </Menu>
          ) : (
            <span className="ls-sidechat-composer-meta">
              <DesktopIcon name="sparkles" size="xs" />
              <span className="ls-truncate">{ti("sideContextMeta")}</span>
            </span>
          )}

          {activeSide?.running && actions ? (
            <button
              type="button"
              className="ls-sidechat-send-btn"
              aria-label={t("desktop.composer.stop")}
              title={t("desktop.composer.stop")}
              onClick={() => {
                actions.cancelSide(activeSide.sideId).catch(showError);
              }}
            >
              <DesktopIcon name="stop-square" size="xs" />
            </button>
          ) : (
            <button
              type="submit"
              className="ls-sidechat-send-btn"
              aria-label={ti("askSideAction")}
              title={ti("askSideAction")}
              disabled={!canInteract || !draft.trim()}
            >
              <DesktopIcon name={asking ? "spinner" : "arrow-up"} size="xs" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** The question's leading `>` lines (a quoted selection) apart from what was asked about them. */
export function splitSideQuote(text: string): { quote: string; question: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && /^>/.test(lines[index]!)) index += 1;
  return {
    quote: lines.slice(0, index).map((line) => line.replace(/^> ?/, "")).join("\n").trim(),
    question: lines.slice(index).join("\n").trim(),
  };
}

/** A thread's name: the question asked, else the passage it quotes. */
export function sideThreadTitle(text: string | undefined, max: number): string {
  if (!text) return "";
  const { quote, question } = splitSideQuote(text);
  const title = (question || quote).replace(/\s+/g, " ").trim();
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function SideUserMessage({ text }: { text: string }) {
  const { quote, question } = splitSideQuote(text);
  return (
    <div className="ls-sidechat-msg__user">
      {quote ? <blockquote className="ls-sidechat-msg__quote">{quote}</blockquote> : null}
      {question ? <span>{question}</span> : null}
    </div>
  );
}
