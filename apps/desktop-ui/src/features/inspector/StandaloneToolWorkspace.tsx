import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { SessionSummary, WorktreeEntry } from "@linkshell/wire";
import type { Connection } from "../../core/connections";
import { routerStore, useRouter } from "../../core/router-store";
import {
  Badge,
  Button,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorBoundary,
  IconButton,
  Input,
  Toolbar,
  useDialogs,
  type DataTableColumn,
} from "../../primitives";
import { FilesPanel } from "./FilesPanel";
import { FileViewerTabPanel, parseFileSpec } from "./FileViewerTabPanel";
import { useInspectorI18n } from "./i18n-inspector";
import { PreviewPanel } from "./PreviewPanel";
import { TerminalStageHost } from "./TerminalPanel";
import { useInspectorConnection } from "./use-inspector-connection";

export function isCleanIdleWorktree(wt: WorktreeEntry): boolean {
  return !wt.dirty && wt.ahead === 0 && wt.sessions.length === 0;
}

interface WorktreesManagerViewProps {
  computerKey: string;
  connection?: Connection;
  online: boolean;
  sessionsMap: Record<string, SessionSummary>;
}

function WorktreesManagerView({
  computerKey,
  connection,
  online,
  sessionsMap,
}: WorktreesManagerViewProps) {
  const { t, ti } = useInspectorI18n();
  const dialogs = useDialogs();

  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  const loadWorktrees = useCallback(async () => {
    if (!connection || !online) return;
    setLoading(true);
    try {
      const list = await connection.store.getState().listWorktrees();
      setWorktrees(list);
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection, online, dialogs]);

  useEffect(() => {
    if (!connection || !online) return;
    void loadWorktrees();
  }, [connection, online, loadWorktrees]);

  const filteredRows = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return worktrees;
    return worktrees.filter(
      (wt) =>
        wt.branch.toLowerCase().includes(q) ||
        wt.path.toLowerCase().includes(q) ||
        wt.source.toLowerCase().includes(q),
    );
  }, [worktrees, filterQuery]);

  const cleanIdleWorktrees = useMemo(
    () => worktrees.filter(isCleanIdleWorktree),
    [worktrees],
  );

  const handleRemoveSingle = useCallback(
    async (wt: WorktreeEntry) => {
      if (!connection) return;
      const needsForce = !isCleanIdleWorktree(wt);
      const confirmed = await dialogs.confirm(
        needsForce
          ? ti("removeWorktreeDirtyBody", { branch: wt.branch })
          : ti("removeWorktreeCleanBody", {
              branch: wt.branch,
              path: wt.path,
            }),
        {
          title: ti("removeWorktreeTitle"),
          confirmLabel: t("desktop.menu.deletePermanent"),
          cancelLabel: ti("cancel"),
          destructive: true,
        },
      );
      if (!confirmed) return;

      try {
        await connection.store.getState().removeWorktree(wt.path, needsForce);
        await loadWorktrees();
      } catch (err) {
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      }
    },
    [connection, dialogs, ti, t, loadWorktrees],
  );

  const handleCleanIdleBatch = useCallback(async () => {
    if (!connection || cleanIdleWorktrees.length === 0 || cleaning) return;
    const confirmed = await dialogs.confirm(
      ti("cleanWorktreesConfirmBody", { count: cleanIdleWorktrees.length }),
      {
        title: ti("cleanWorktreesConfirmTitle"),
        confirmLabel: ti("cleanWorktreesAction", {
          count: cleanIdleWorktrees.length,
        }),
        cancelLabel: ti("cancel"),
        destructive: true,
      },
    );
    if (!confirmed) return;

    setCleaning(true);
    try {
      for (const wt of cleanIdleWorktrees) {
        await connection.store.getState().removeWorktree(wt.path, false);
      }
      await loadWorktrees();
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  }, [connection, cleanIdleWorktrees, cleaning, dialogs, ti, loadWorktrees]);

  const columns = useMemo<DataTableColumn<WorktreeEntry>[]>(
    () => [
      {
        id: "branch",
        header: ti("colBranch"),
        sortable: true,
        sortAccessor: (row) => row.branch,
        cell: (row) => (
          <Badge variant="tag" icon="git-branch" tone="neutral">
            {row.branch}
          </Badge>
        ),
      },
      {
        id: "path",
        header: ti("colPath"),
        sortable: true,
        sortAccessor: (row) => row.path,
        cell: (row) => (
          <div className="inspector-subbar-group">
            <span
              className="ls-truncate"
              title={row.path}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--ls-text-xs)",
                maxWidth: 360,
              }}
            >
              {row.path}
            </span>
            <CopyButton
              value={row.path}
              revealOnHover
              size="sm"
              label={t("desktop.menu.copyPath")}
            />
          </div>
        ),
      },
      {
        id: "status",
        header: ti("colStatus"),
        sortable: true,
        sortAccessor: (row) => (row.dirty ? 2 : row.ahead > 0 ? 1 : 0),
        cell: (row) => (
          <div className="inspector-subbar-group">
            <Badge
              variant="tag"
              tone={row.dirty ? "waiting" : "ok"}
              dot={row.dirty ? "waiting" : "ok"}
            >
              {row.dirty ? ti("statusDirty") : ti("statusClean")}
            </Badge>
            {row.ahead > 0 ? (
              <Badge variant="tag" tone="accent" data-tabular="">
                {ti("statusAhead", { count: row.ahead })}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: "sessions",
        header: ti("colSessions"),
        numeric: true,
        sortable: true,
        sortAccessor: (row) => row.sessions.length,
        cell: (row) =>
          row.sessions.length === 0 ? (
            <span data-tabular="" style={{ color: "var(--ls-fg-3)" }}>
              0
            </span>
          ) : (
            <div
              className="inspector-subbar-group"
              style={{ justifyContent: "flex-end" }}
            >
              {row.sessions.slice(0, 2).map((sid) => {
                const summary = sessionsMap[sid];
                return (
                  <Button
                    key={sid}
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      routerStore.getState().openSession(computerKey, sid)
                    }
                  >
                    {summary?.title || sid.slice(0, 8)}
                  </Button>
                );
              })}
              {row.sessions.length > 2 ? (
                <Badge variant="count" tone="neutral">
                  {`+${row.sessions.length - 2}`}
                </Badge>
              ) : null}
            </div>
          ),
      },
      {
        id: "actions",
        header: ti("colActions"),
        align: "right",
        cell: (row) => (
          <Toolbar label={ti("colActions")}>
            <IconButton
              icon="plus"
              size="icon-sm"
              label={t("desktop.menu.newInProject")}
              onClick={() =>
                routerStore.getState().openNewSession(computerKey, row.path)
              }
            />
            <IconButton
              icon="folder-open"
              size="icon-sm"
              label={t("desktop.nav.files")}
              onClick={() =>
                routerStore.getState().navigate({
                  kind: "files",
                  computerKey,
                  path: row.path,
                })
              }
            />
            <IconButton
              icon="trash"
              size="icon-sm"
              variant="danger-ghost"
              label={ti("removeWorktreeTitle")}
              onClick={() => {
                void handleRemoveSingle(row);
              }}
            />
          </Toolbar>
        ),
      },
    ],
    [ti, t, sessionsMap, computerKey, handleRemoveSingle],
  );

  return (
    <div className="inspector-panel-fill">
      <div className="inspector-subbar">
        <div className="inspector-subbar-group" style={{ flex: "1 1 240px" }}>
          <Input
            size="sm"
            leadingIcon="search"
            value={filterQuery}
            placeholder={ti("worktreeSearchPlaceholder")}
            aria-label={ti("worktreeSearchPlaceholder")}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>

        <div className="inspector-subbar-group">
          <Button
            size="xs"
            variant="secondary"
            leadingIcon="trash"
            loading={cleaning}
            disabled={!online || cleanIdleWorktrees.length === 0}
            onClick={() => {
              void handleCleanIdleBatch();
            }}
          >
            {ti("cleanWorktreesAction", { count: cleanIdleWorktrees.length })}
          </Button>
          <IconButton
            icon="refresh"
            size="icon-sm"
            label={ti("refresh")}
            loading={loading}
            disabled={!online}
            onClick={() => {
              void loadWorktrees();
            }}
          />
        </div>
      </div>

      <div className="inspector-panel-scroll">
        <DataTable
          label={t("desktop.nav.worktrees")}
          columns={columns}
          rows={filteredRows}
          getRowKey={(row) => row.path}
          defaultSortColumnId="branch"
          defaultSortDirection="asc"
          emptyState={
            <EmptyState
              compact
              icon="worktree"
              title={online ? ti("noWorktreesTitle") : ti("offlineTitle")}
              description={online ? ti("noWorktreesDesc") : ti("offlineDesc")}
            />
          }
        />
      </div>
    </div>
  );
}

export interface StandaloneToolWorkspaceProps {
  mode: "terminals" | "files" | "ports" | "worktrees";
  computerKey: string;
}

export function StandaloneToolWorkspace({
  mode,
  computerKey,
}: StandaloneToolWorkspaceProps): JSX.Element {
  const { t } = useInspectorI18n();
  const activeRoute = useRouter((s) => s.activeRoute);
  const { connection, online, machine, sessionsMap, agents } =
    useInspectorConnection({ computerKey, withSessionsMap: true });

  const sectionLabel = useMemo(() => {
    switch (mode) {
      case "terminals":
        return t("desktop.nav.terminals");
      case "files":
        return t("desktop.nav.files");
      case "ports":
        return t("desktop.nav.ports");
      case "worktrees":
        return t("desktop.nav.worktrees");
    }
  }, [mode, t]);

  const routeFileSpec =
    activeRoute.kind === "files" && activeRoute.computerKey === computerKey
      ? activeRoute.path
      : undefined;

  const [selectedFileSpec, setSelectedFileSpec] = useState<string | undefined>(
    routeFileSpec && routeFileSpec.includes("#L") ? routeFileSpec : undefined,
  );

  useEffect(() => {
    if (!routeFileSpec) {
      setSelectedFileSpec(undefined);
      return;
    }
    if (routeFileSpec.includes("#L")) {
      setSelectedFileSpec(routeFileSpec);
    } else {
      setSelectedFileSpec(undefined);
    }
  }, [routeFileSpec]);

  const openTerminalStandalone = useCallback(() => {
    routerStore.getState().navigate({ kind: "terminals", computerKey });
  }, [computerKey]);

  return (
    <section
      aria-label={sectionLabel}
      className="inspector-standalone"
      data-tool-mode={mode}
    >
      <div className="inspector-standalone-body">
        <ErrorBoundary resetKeys={[mode, computerKey]}>
          {mode === "terminals" ? (
            <TerminalStageHost
              stageKey={`standalone:${computerKey || "default"}`}
              computerKey={computerKey || "default"}
              connection={connection}
              online={online}
              cwd={machine?.home}
              dockPosition="standalone"
            />
          ) : mode === "files" ? (
            selectedFileSpec ? (
              <FileViewerTabPanel
                connection={connection}
                online={online}
                cwd={machine?.home}
                agents={agents}
                filePath={parseFileSpec(selectedFileSpec).path}
                lineSpec={selectedFileSpec}
                onOpenTerminalAt={openTerminalStandalone}
                onBack={() => setSelectedFileSpec(undefined)}
              />
            ) : (
              <FilesPanel
                connection={connection}
                online={online}
                cwd={
                  routeFileSpec && !routeFileSpec.includes("#L")
                    ? routeFileSpec
                    : machine?.home
                }
                agents={agents}
                onOpenFile={(spec) => setSelectedFileSpec(spec)}
                onOpenTerminalAt={openTerminalStandalone}
              />
            )
          ) : mode === "ports" ? (
            <PreviewPanel
              computerKey={computerKey}
              connection={connection}
              online={online}
              cwd={machine?.home}
            />
          ) : (
            <WorktreesManagerView
              computerKey={computerKey}
              connection={connection}
              online={online}
              sessionsMap={sessionsMap}
            />
          )}
        </ErrorBoundary>
      </div>
    </section>
  );
}
