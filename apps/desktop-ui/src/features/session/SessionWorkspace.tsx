import { useEffect, useMemo, useRef, useState } from "react";
import { emptyView, userMessageText } from "@linkshell/client-core";
import type { SessionNotice, SessionSummary } from "@linkshell/wire";
import { useT } from "@/core";
import { DesktopIcon } from "@/icons";
import { ErrorBoundary, IconButton, Input, isImeComposing } from "@/primitives";
import { SessionComposer } from "./SessionComposer";
import { TimelineView } from "./TimelineView";
import {
  sessionKeyOf,
  sessionUiStore,
  useClientSelector,
  useSessionConnection,
  useSessionCopy,
  useSessionUi,
} from "./session-helpers";

const EMPTY_NOTICES: (SessionNotice & { id: string })[] = [];

export interface SessionWorkspaceProps {
  computerKey: string;
  sessionId: string;
}

export function SessionWorkspace({
  computerKey,
  sessionId,
}: SessionWorkspaceProps) {
  const t = useT();
  const copy = useSessionCopy();
  const connection = useSessionConnection(computerKey);
  const sessionKey = sessionKeyOf(computerKey, sessionId);
  const ui = useSessionUi(computerKey, sessionId);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [systemNote, setSystemNote] = useState<string | undefined>();

  // Acquire ref-counted session event stream subscription on mount.
  useEffect(() => {
    if (!connection || !sessionId) return;
    setSystemNote(undefined);
    return connection.sessions.acquire(sessionId);
  }, [connection, sessionId]);

  // Focus search input when Find bar opens.
  useEffect(() => {
    if (ui.searchOpen) {
      queueMicrotask(() => searchInputRef.current?.focus());
    }
  }, [ui.searchOpen]);

  const status = useClientSelector(connection, (s) => s.status, "offline");
  const statusDetail = useClientSelector(connection, (s) => s.statusDetail, undefined);
  const storedSession = useClientSelector(
    connection,
    (s) => s.sessions[sessionId],
    undefined,
  );
  const storedView = useClientSelector(
    connection,
    (s) => s.views[sessionId],
    undefined,
  );
  const notices = useClientSelector(
    connection,
    (s) => s.notices[sessionId] ?? EMPTY_NOTICES,
    EMPTY_NOTICES,
  );

  const view = useMemo(
    () => storedView ?? emptyView(sessionId),
    [sessionId, storedView],
  );

  const fallbackSession = useMemo<SessionSummary | undefined>(() => {
    if (storedSession) return storedSession;
    const colon = sessionId.indexOf(":");
    if (colon <= 0) return undefined;
    return {
      id: sessionId,
      agent: sessionId.slice(0, colon),
      nativeId: sessionId.slice(colon + 1),
      cwd: "",
      state: view.state,
      pendingPermissions: view.permissions.length,
      createdAt: 0,
      updatedAt: 0,
      lastSeq: view.lastSeq,
      archived: false,
    };
  }, [sessionId, storedSession, view.lastSeq, view.permissions.length, view.state]);

  // Count matching items when in-session search query is non-empty.
  const matchCount = useMemo(() => {
    const q = ui.searchOpen ? ui.searchQuery.trim().toLowerCase() : "";
    if (!q) return 0;
    let count = 0;
    for (const item of view.items) {
      if (item.kind === "user") {
        if (userMessageText(item.blocks).toLowerCase().includes(q)) count++;
      } else if (item.kind === "agent" || item.kind === "thought") {
        if (item.text.toLowerCase().includes(q)) count++;
      } else if (item.kind === "tool") {
        if (
          item.title.toLowerCase().includes(q) ||
          item.output.toLowerCase().includes(q)
        ) {
          count++;
        }
      } else if (item.kind === "error") {
        if (item.message.toLowerCase().includes(q)) count++;
      }
    }
    return count;
  }, [ui.searchOpen, ui.searchQuery, view.items]);

  if (!connection || !fallbackSession) {
    return (
      <div
        className="ls-session-workspace"
        style={{ alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ls-fg-3)" }}>
          <DesktopIcon name="spinner" size="sm" />
          <span>{connection ? copy.sessionNotFound : copy.connectingComputer}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="ls-session-workspace"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f" &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          sessionUiStore.getState().setSearchOpen(sessionKey, true);
          queueMicrotask(() => searchInputRef.current?.select());
        }
      }}
    >
      {/* In-session Find bar (`⌘/Ctrl+F`) */}
      {ui.searchOpen && (
        <div className="ls-session-find-bar" role="search">
          <DesktopIcon name="search" size="xs" />
          <Input
            ref={searchInputRef}
            type="search"
            value={ui.searchQuery}
            placeholder={t("desktop.timeline.searchPlaceholder")}
            onChange={(e) =>
              sessionUiStore.getState().setSearchQuery(sessionKey, e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key === "Escape" && !isImeComposing(e)) {
                e.preventDefault();
                sessionUiStore.getState().setSearchOpen(sessionKey, false);
              }
            }}
          />
          {ui.searchQuery.trim() && (
            <span className="ls-session-find-count">
              {copy.matchesCount(matchCount)}
            </span>
          )}
          <IconButton
            icon="close"
            size="icon-sm"
            label={copy.closeFind}
            onClick={() =>
              sessionUiStore.getState().setSearchOpen(sessionKey, false)
            }
          />
        </div>
      )}

      {/* Offline / Reconnecting status bar */}
      {status !== "online" && statusDetail && (
        <div
          className="ls-notice-card"
          style={{ borderRadius: 0, borderInline: 0, borderTop: 0 }}
        >
          <DesktopIcon name="spinner" size="xs" />
          <span>{statusDetail}</span>
        </div>
      )}

      {/* Live transient ACP session notices */}
      {notices.map((notice) => (
        <div
          key={notice.id}
          className="ls-notice-card"
          style={{ borderRadius: 0, borderInline: 0, borderTop: 0, alignItems: "center" }}
        >
          <DesktopIcon name="info" size="xs" />
          <span style={{ flex: 1 }}>
            <strong>{notice.title}</strong>
            {notice.description ? ` · ${notice.description}` : ""}
          </span>
          <IconButton
            icon="close"
            size="icon-sm"
            label={copy.closeFind}
            onClick={() =>
              connection.store.getState().dismissNotice(sessionId, notice.id)
            }
          />
        </div>
      ))}

      <ErrorBoundary resetKeys={[computerKey, sessionId]}>
        <TimelineView
          connection={connection}
          session={fallbackSession}
          view={view}
          systemNote={systemNote}
        />

        <SessionComposer
          connection={connection}
          session={fallbackSession}
          view={view}
          onSystemFeedback={setSystemNote}
        />
      </ErrorBoundary>
    </div>
  );
}
