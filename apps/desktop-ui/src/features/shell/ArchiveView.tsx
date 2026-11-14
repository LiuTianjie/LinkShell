import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { SessionSummary } from "@linkshell/wire";
import { DESKTOP_LOCAL } from "../../bridge/desktop-bridge";
import {
  computerNames,
  confirmAndDeleteSession,
  engine,
  projectScopeStore,
  sessionTitle,
  setProjectScope,
  useI18n,
  useRouter,
  type Computer,
  type Connection,
} from "../../core";
import { AgentMark, DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  StatusDot,
  useDialogs,
} from "../../primitives";
import {
  asSessionActionDialogs,
  computerPlatformIcon,
  connectionRouteBadge,
  displayComputerName,
  formatRelativeTimestamp,
  formatSessionCountLabel,
  shortenHomePath,
  useConnectionStore,
  useRetainedMetadataConnections,
} from "./shell-helpers";

interface ArchivedComputerBucket {
  key: string;
  computer: Computer | undefined;
  connection: Connection | undefined;
  title: string;
  online: boolean;
  syncing: boolean;
  sessions: SessionSummary[];
  nextBefore?: number;
  nextBeforeId?: string;
}

function filterAndSortArchived(
  sessionsMap: Record<string, SessionSummary>,
  rawQuery: string,
): SessionSummary[] {
  const all = Object.values(sessionsMap)
    .filter((session) => session.archived)
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const q = rawQuery.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
    (s) =>
      sessionTitle(s).toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.agent.toLowerCase().includes(q),
  );
}

export function ArchiveView() {
  const { locale, t } = useI18n();
  const dialogs = useDialogs();
  const openSession = useRouter((s) => s.openSession);

  const computers = useStore(engine.state, (s) => s.computers);
  const localComputer = useStore(engine.state, (s) => s.localComputer);
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const names = useStore(computerNames.store);
  const scope = useStore(projectScopeStore, (s) => s.scope);

  const activeStatus = useConnectionStore(activeConnection, (s) => s.status);
  const activeSessionsMap = useConnectionStore(activeConnection, (s) => s.sessions);
  const activeNextBefore = useConnectionStore(
    activeConnection,
    (s) => s.archivedNextBefore,
  );
  const activeNextBeforeId = useConnectionStore(
    activeConnection,
    (s) => s.archivedNextBeforeId,
  );

  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loadingByKey, setLoadingByKey] = useState<Record<string, boolean>>({});
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null);

  const loadedOnlineSetRef = useRef<WeakSet<Connection>>(new WeakSet());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isAllScope = scope === "all";
  const showScopeSwitch = computers.length > 1 || isAllScope;
  const retainedMap = useRetainedMetadataConnections(computers, isAllScope);

  const activeComputer: Computer | undefined =
    activeConnection?.computer ?? localComputer ?? computers[0];
  const activeComputerKey = activeComputer?.key ?? DESKTOP_LOCAL;

  const allComputers = useMemo(() => {
    const list =
      computers.length > 0 ? [...computers] : localComputer ? [localComputer] : [];
    list.sort((a, b) => {
      if (a.key === DESKTOP_LOCAL && b.key !== DESKTOP_LOCAL) return -1;
      if (b.key === DESKTOP_LOCAL && a.key !== DESKTOP_LOCAL) return 1;
      return displayComputerName(a, names, locale).localeCompare(
        displayComputerName(b, names, locale),
      );
    });
    return list;
  }, [computers, localComputer, names, locale]);

  // Trigger initial loadArchived() on activeConnection whenever it comes online
  useEffect(() => {
    if (!activeConnection) return;
    if (activeStatus !== "online") {
      loadedOnlineSetRef.current.delete(activeConnection);
      return;
    }
    if (loadedOnlineSetRef.current.has(activeConnection)) return;
    const loadFn = activeConnection.store.getState().loadArchived;
    if (typeof loadFn !== "function") return;

    loadedOnlineSetRef.current.add(activeConnection);
    const key = activeConnection.computer.key;
    setLoadingByKey((prev) => ({ ...prev, [key]: true }));
    void Promise.resolve(loadFn())
      .catch(() => {
        loadedOnlineSetRef.current.delete(activeConnection);
      })
      .finally(() => {
        if (!mountedRef.current) return;
        setLoadingByKey((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      });
  }, [activeConnection, activeStatus]);

  // Trigger initial loadArchived() across retained online connections when "All Computers" is selected
  useEffect(() => {
    if (!isAllScope) return;
    for (const comp of allComputers) {
      const conn =
        comp.key === activeConnection?.computer.key
          ? activeConnection
          : retainedMap[comp.key];
      if (!conn) continue;
      const status = conn.store.getState().status;
      if (status !== "online") {
        loadedOnlineSetRef.current.delete(conn);
        continue;
      }
      if (loadedOnlineSetRef.current.has(conn)) continue;
      const loadFn = conn.store.getState().loadArchived;
      if (typeof loadFn !== "function") continue;

      loadedOnlineSetRef.current.add(conn);
      const key = comp.key;
      setLoadingByKey((prev) => ({ ...prev, [key]: true }));
      void Promise.resolve(loadFn())
        .catch(() => {
          loadedOnlineSetRef.current.delete(conn);
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setLoadingByKey((prev) => {
            if (!prev[key]) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        });
    }
  }, [isAllScope, allComputers, activeConnection, retainedMap]);

  const singleArchivedSessions = useMemo(
    () => filterAndSortArchived(activeSessionsMap, query),
    [activeSessionsMap, query],
  );

  const allBuckets = useMemo<ArchivedComputerBucket[]>(() => {
    if (!isAllScope) return [];
    return allComputers.map((comp) => {
      const conn =
        comp.key === activeConnection?.computer.key
          ? activeConnection
          : retainedMap[comp.key];
      const state = conn?.store.getState();
      const isLocal = comp.key === DESKTOP_LOCAL;
      const online = Boolean(
        comp.machine.online || isLocal || state?.status === "online",
      );
      const syncing = Boolean(
        online && (!state?.sessionsLoaded || loadingByKey[comp.key]),
      );
      const sessions = state ? filterAndSortArchived(state.sessions, query) : [];
      return {
        key: comp.key,
        computer: comp,
        connection: conn,
        title: displayComputerName(comp, names, locale),
        online,
        syncing,
        sessions,
        nextBefore: state?.archivedNextBefore,
        nextBeforeId: state?.archivedNextBeforeId,
      };
    });
  }, [
    isAllScope,
    allComputers,
    activeConnection,
    retainedMap,
    loadingByKey,
    query,
    names,
    locale,
  ]);

  const visibleAllBuckets = useMemo(
    () =>
      allBuckets.filter(
        (b) =>
          b.sessions.length > 0 ||
          (b.syncing && !query.trim()) ||
          (b.nextBefore !== undefined && !query.trim()),
      ),
    [allBuckets, query],
  );

  const totalDisplayedCount = isAllScope
    ? allBuckets.reduce((sum, b) => sum + b.sessions.length, 0)
    : singleArchivedSessions.length;

  const isSingleInitialLoading =
    !isAllScope &&
    singleArchivedSessions.length === 0 &&
    (Boolean(loadingByKey[activeComputerKey]) || activeStatus === "connecting");

  const isAllInitialLoading =
    isAllScope &&
    totalDisplayedCount === 0 &&
    allBuckets.some((b) => b.syncing);

  const loadingText =
    locale === "en"
      ? "Loading archived sessions"
      : locale === "ja"
        ? "アーカイブ済みセッションを読み込み中"
        : "正在加载已归档会话";

  const loadMoreLabel =
    locale === "en"
      ? "Load more"
      : locale === "ja"
        ? "さらに読み込む"
        : "加载更多";

  const syncingBadgeLabel =
    locale === "en" ? "Syncing" : locale === "ja" ? "同期中" : "同步中";

  const handleOpenArchived = (computerKey: string, sessionId: string) => {
    const comp = engine.computerForKey(computerKey);
    if (comp && comp.key !== activeConnection?.computer.key) {
      engine.select(comp);
    }
    openSession(computerKey, sessionId);
  };

  const handleRestore = async (
    computerKey: string,
    conn: Connection | undefined,
    session: SessionSummary,
  ) => {
    if (!conn) return;
    const opKey = `${computerKey}:${session.id}`;
    setBusyKey(opKey);
    try {
      await conn.store.getState().archive(session.id, false);
    } finally {
      if (mountedRef.current) setBusyKey(null);
    }
  };

  const handleDelete = async (
    computerKey: string,
    conn: Connection | undefined,
    session: SessionSummary,
  ) => {
    if (!conn) return;
    const opKey = `${computerKey}:${session.id}`;
    setBusyKey(opKey);
    try {
      await confirmAndDeleteSession(
        session,
        conn.store.getState(),
        asSessionActionDialogs(dialogs),
        locale,
      );
    } finally {
      if (mountedRef.current) setBusyKey(null);
    }
  };

  const handleLoadMore = async (
    computerKey: string,
    conn: Connection | undefined,
    before: number | undefined,
    beforeId: string | undefined,
  ) => {
    if (!conn || before === undefined) return;
    const loadFn = conn.store.getState().loadArchived;
    if (typeof loadFn !== "function") return;
    setLoadingMoreKey(computerKey);
    try {
      await loadFn(before, beforeId);
    } finally {
      if (mountedRef.current) setLoadingMoreKey(null);
    }
  };

  const renderSessionList = (
    computerKey: string,
    conn: Connection | undefined,
    rows: SessionSummary[],
    nextBefore?: number,
    nextBeforeId?: string,
  ) => (
    <>
      <div className="ls-entity-list" role="list" aria-label={t("desktop.nav.archive")}>
        {rows.map((row) => {
          const opKey = `${computerKey}:${row.id}`;
          return (
            <div key={row.id} role="listitem" className="ls-entity-row">
              <button
                type="button"
                className="ls-entity-row__main"
                onClick={() => handleOpenArchived(computerKey, row.id)}
              >
                <span className="ls-entity-row__lead" aria-hidden="true">
                  <AgentMark agent={row.agent} size={15} />
                </span>
                <span className="ls-entity-row__title ls-truncate">
                  {sessionTitle(row)}
                </span>
                <span className="ls-entity-row__path ls-truncate" title={row.cwd}>
                  {shortenHomePath(row.cwd)}
                </span>
              </button>

              <div className="ls-entity-row__actions">
                <span className="ls-entity-row__meta">
                  {formatRelativeTimestamp(row.updatedAt ?? row.createdAt, locale)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon="archive-restore"
                  loading={busyKey === opKey}
                  onClick={() => void handleRestore(computerKey, conn, row)}
                >
                  {t("desktop.menu.unarchive")}
                </Button>
                <IconButton
                  icon="trash"
                  variant="ghost"
                  disabled={busyKey === opKey}
                  label={t("desktop.menu.deletePermanent")}
                  tooltip={t("desktop.menu.deletePermanent")}
                  onClick={() => void handleDelete(computerKey, conn, row)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {nextBefore !== undefined ? (
        <div className="archive-load-more-row">
          <Button
            size="sm"
            variant="secondary"
            loading={loadingMoreKey === computerKey}
            onClick={() =>
              void handleLoadMore(computerKey, conn, nextBefore, nextBeforeId)
            }
          >
            {loadMoreLabel}
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="shell-page">
      <div className="shell-page__inner">
        <div className="shell-page__header">
          <div className="shell-page__heading">
            <h1 className="shell-page__title">{t("desktop.nav.archive")}</h1>
            <p className="shell-page__subtitle">
              {isSingleInitialLoading || isAllInitialLoading
                ? loadingText
                : formatSessionCountLabel(totalDisplayedCount, locale)}
            </p>
          </div>

          {showScopeSwitch ? (
            <div className="shell-page__actions">
              <div
                className="sidebar-scope-switch"
                role="group"
                aria-label={t("desktop.nav.archive")}
              >
                <button
                  type="button"
                  aria-pressed={scope === "computer"}
                  className="sidebar-scope-switch__btn"
                  onClick={() => setProjectScope("computer")}
                >
                  {t("desktop.nav.scopeComputer")}
                </button>
                <button
                  type="button"
                  aria-pressed={scope === "all"}
                  className="sidebar-scope-switch__btn"
                  onClick={() => setProjectScope("all")}
                >
                  {t("desktop.nav.scopeAll")}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="shell-toolbar-bar">
          <div style={{ flex: "1 1 260px", maxInlineSize: "340px", minInlineSize: 0 }}>
            <Input
              size="md"
              leadingIcon="search"
              value={query}
              placeholder={
                locale === "en"
                  ? "Search archived sessions"
                  : locale === "ja"
                    ? "アーカイブ済みセッションを検索"
                    : "搜索已归档的会话"
              }
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {!isAllScope ? (
          isSingleInitialLoading ? (
            <div className="ls-entity-list" role="status" aria-live="polite">
              <div className="ls-computer-section__sync-row">
                <DesktopIcon name="spinner" size="sm" />
                <span>{loadingText}</span>
              </div>
            </div>
          ) : singleArchivedSessions.length > 0 ? (
            renderSessionList(
              activeComputerKey,
              activeConnection,
              singleArchivedSessions,
              activeNextBefore,
              activeNextBeforeId,
            )
          ) : (
            <EmptyState
              icon="archive"
              title={t("desktop.nav.archive")}
              description={
                locale === "en"
                  ? "Archived sessions appear here and can be restored anytime."
                  : locale === "ja"
                    ? "アーカイブされたセッションはここに表示され、いつでも復元できます。"
                    : "归档后的会话不会出现在左侧树中，随时可以在这里恢复或清理。"
              }
            />
          )
        ) : visibleAllBuckets.length > 0 ? (
          <div className="ls-computer-sections">
            {visibleAllBuckets.map((bucket) => {
              const routeBadge = connectionRouteBadge(
                bucket.computer,
                undefined,
                locale,
              );
              return (
                <section
                  key={bucket.key}
                  className="ls-computer-section"
                  data-computer-key={bucket.key}
                  aria-label={bucket.title}
                >
                  <div className="ls-computer-section__header">
                    <div className="ls-computer-section__title-group">
                      <span className="ls-computer-section__icon" aria-hidden="true">
                        <DesktopIcon
                          name={computerPlatformIcon(bucket.computer?.machine.platform)}
                          size="sm"
                        />
                      </span>
                      <StatusDot
                        tone={bucket.online ? "ok" : "offline"}
                        size="sm"
                      />
                      <h2 className="ls-computer-section__title ls-truncate">
                        {bucket.title}
                      </h2>
                      <Badge icon={routeBadge.icon} tone={routeBadge.tone}>
                        {routeBadge.label}
                      </Badge>
                      <span className="ls-computer-section__count">
                        {bucket.syncing && bucket.sessions.length === 0
                          ? syncingBadgeLabel
                          : formatSessionCountLabel(bucket.sessions.length, locale)}
                      </span>
                    </div>
                  </div>

                  {bucket.sessions.length > 0 ? (
                    renderSessionList(
                      bucket.key,
                      bucket.connection,
                      bucket.sessions,
                      bucket.nextBefore,
                      bucket.nextBeforeId,
                    )
                  ) : (
                    <div className="ls-entity-list">
                      <div className="ls-computer-section__sync-row">
                        <DesktopIcon name="spinner" size="sm" />
                        <span>{loadingText}</span>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon="archive"
            title={t("desktop.nav.archive")}
            description={
              locale === "en"
                ? "Archived sessions appear here and can be restored anytime."
                : locale === "ja"
                  ? "アーカイブされたセッションはここに表示され、いつでも復元できます。"
                  : "归档后的会话不会出现在左侧树中，随时可以在这里恢复或清理。"
            }
          />
        )}
      </div>
    </div>
  );
}
