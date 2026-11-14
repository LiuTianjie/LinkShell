import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
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
import type { InspectorSessionActions } from "./use-inspector-connection";

export interface SideChatTabPanelProps {
  computerKey?: string;
  online: boolean;
  sessionId?: string;
  cwd?: string;
  sides: readonly SideChat[];
  actions?: InspectorSessionActions;
}

export function SideChatTabPanel({
  computerKey,
  online,
  sessionId,
  cwd,
  sides,
  actions,
}: SideChatTabPanelProps): JSX.Element {
  const { t, ti } = useInspectorI18n();
  const dialogs = useDialogs();
  const [selectedSideId, setSelectedSideId] = useState<string | undefined>(
    undefined,
  );
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);

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
    const firstMsg = activeSide.messages[0]?.text?.trim();
    if (firstMsg) {
      return firstMsg.slice(0, 18);
    }
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
        setDraft("");
      } catch (err) {
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      } finally {
        setAsking(false);
      }
    },
    [actions, activeSide?.sideId, asking, dialogs, online, sessionId],
  );

  const handleSubmit = useCallback(async () => {
    await submitQuestion(draft);
  }, [draft, submitQuestion]);

  const starterPrompts = useMemo(
    () => [ti("sideStarter1"), ti("sideStarter2"), ti("sideStarter3")],
    [ti],
  );

  const canInteract = Boolean(online && sessionId && actions && !asking);

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
                    <div className="ls-sidechat-msg__user">{msg.text}</div>
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
            <span
              className="ls-sidechat-empty__badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                inlineSize: 36,
                blockSize: 36,
                borderRadius: 10,
                border: "var(--ls-hairline) solid var(--ls-border)",
                backgroundColor: "var(--ls-surface-2)",
                color: "var(--ls-fg-2)",
              }}
            >
              <DesktopIcon name="sparkles" size="sm" />
            </span>
            <strong
              style={{
                fontSize: "var(--ls-text-base)",
                fontWeight: 600,
                color: "var(--ls-fg)",
              }}
            >
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
                const firstMsg = side.messages[0]?.text?.trim();
                const label = firstMsg
                  ? firstMsg.slice(0, 24)
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
                    void actions.closeSide(activeSide.sideId);
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
                void actions.cancelSide(activeSide.sideId);
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
