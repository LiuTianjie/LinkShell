import { useEffect, useMemo, useRef, useState } from "react";
import { emptyView } from "@linkshell/client-core";
import type { SessionNotice, SessionSummary } from "@linkshell/wire";
import { DESKTOP_SHORTCUTS, FOCUS_COMPOSER_EVENT, matchesShortcut } from "@/bridge";
import { useT } from "@/core";
import { DesktopIcon } from "@/icons";
import { ErrorBoundary, IconButton, Input, isImeComposing } from "@/primitives";
import { SessionComposer } from "./SessionComposer";
import { TimelineView } from "./TimelineView";
import {
  sessionKeyOf,
  sessionUiStore,
  timelineItemSearchText,
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

  // ⌘L (and the menu's composer command) land in this session's message box.
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const focusComposer = () =>
      workspaceRef.current
        ?.querySelector<HTMLTextAreaElement>(".ls-composer-box textarea")
        ?.focus();
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusComposer);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focusComposer);
  }, []);

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

  // Matches in order, for Enter / Shift+Enter and the arrows (ported from the web client's find bar).
  const searchMatches = useMemo(() => {
    const q = ui.searchOpen ? ui.searchQuery.trim().toLowerCase() : "";
    if (!q) return [] as string[];
    return view.items
      .filter((item) => timelineItemSearchText(item).toLowerCase().includes(q))
      .map((item) => item.id);
  }, [ui.searchOpen, ui.searchQuery, view.items]);
  const [searchIndex, setSearchIndex] = useState(0);

  const firstMatchId = searchMatches[0];
  useEffect(() => {
    setSearchIndex(0);
    if (firstMatchId) sessionUiStore.getState().requestScrollToItem(sessionKey, firstMatchId);
  }, [firstMatchId, sessionKey, ui.searchQuery]);

  const stepMatch = (delta: number) => {
    if (searchMatches.length === 0) return;
    const next = (searchIndex + delta + searchMatches.length) % searchMatches.length;
    setSearchIndex(next);
    const target = searchMatches[next];
    if (target) sessionUiStore.getState().requestScrollToItem(sessionKey, target);
  };

  const closeFind = () => {
    sessionUiStore.getState().setSearchOpen(sessionKey, false);
    // Back to typing, where the person was before searching.
    queueMicrotask(() =>
      document.querySelector<HTMLTextAreaElement>(".ls-session-workspace .ls-composer-textarea")?.focus(),
    );
  };

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
      ref={workspaceRef}
      className="ls-session-workspace"
      onKeyDown={(event) => {
        if (matchesShortcut(event.nativeEvent, DESKTOP_SHORTCUTS.findInSession)) {
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
              if (isImeComposing(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              } else if (e.key === "Enter") {
                e.preventDefault();
                stepMatch(e.shiftKey ? -1 : 1);
              }
            }}
          />
          {ui.searchQuery.trim() && (
            <span className="ls-session-find-count" aria-live="polite">
              {searchMatches.length > 0
                ? copy.matchPosition(Math.min(searchIndex, searchMatches.length - 1) + 1, searchMatches.length)
                : copy.noMatches}
            </span>
          )}
          <IconButton
            icon="chevron-up"
            size="icon-sm"
            label={copy.findPrevious}
            disabled={searchMatches.length === 0}
            onClick={() => stepMatch(-1)}
          />
          <IconButton
            icon="chevron-down"
            size="icon-sm"
            label={copy.findNext}
            disabled={searchMatches.length === 0}
            onClick={() => stepMatch(1)}
          />
          <IconButton
            icon="close"
            size="icon-sm"
            label={copy.closeFind}
            onClick={closeFind}
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
            label={copy.dismissNotice}
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
