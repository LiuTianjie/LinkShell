import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useStore } from "zustand";
import { DESKTOP_COMMAND_EVENT } from "../../bridge/desktop-bridge";
import {
  DESKTOP_SHORTCUTS,
  formatShortcut,
  useDesktopCommand,
} from "../../bridge/shortcuts";
import { appTabId } from "../../core/mcp-bridge";
import { routerStore, type InspectorTab } from "../../core/router-store";
import { DesktopIcon, SubagentGlyph, type DesktopIconName } from "../../icons";
import {
  Badge,
  ErrorBoundary,
  IconButton,
  SplitResizer,
  useDialogs,
} from "../../primitives";
import {
  ChangesPanel,
  useSessionChangesSummary,
  type ChangesStatsSummary,
} from "./ChangesPanel";
import { FilesPanel } from "./FilesPanel";
import { FileViewerTabPanel } from "./FileViewerTabPanel";
import { FileExtBadge, formatCompactStat } from "./file-ext-badge";
import { useInspectorI18n } from "./i18n-inspector";
import { InspectorNewTabView } from "./InspectorNewTabView";
import {
  activateInspectorTab,
  cycleInspectorTab,
  inspectorScopeKey,
  openFileTabInInspector,
  openInspectorTab,
  requestCloseInspectorTab,
  routerTabToTabItem,
  setActiveInspectorScope,
  setInspectorDiscardConfirm,
  useInspectorTabs,
  useIsTabDirty,
  type InspectorTabItem,
  type InspectorTabKind,
} from "./inspector-tabs-store";
import { McpAppPanel, useMcpAppsDiscovery } from "./McpAppPanel";
import { PreviewPanel } from "./PreviewPanel";
import { SideChatTabPanel } from "./SideChatTabPanel";
import { SubagentTabPanel } from "./SubagentTabPanel";
import { countRunningTasksAndSubagents, TasksPanel } from "./TasksPanel";
import { TerminalPanel } from "./TerminalPanel";
import { getTerminalStageController } from "./terminal-runtime";
import { useInspectorConnection } from "./use-inspector-connection";

export type InspectorActiveTab =
  | "new-tab"
  | "changes"
  | "files"
  | "file"
  | "terminal"
  | "preview"
  | "ports"
  | "side"
  | "tasks"
  | "subagent"
  | "mcp";

const INSPECTOR_OPEN_FILE_EVENT = "linkshell-inspector-open-file";

function iconForTabKind(kind: InspectorTabKind): DesktopIconName {
  switch (kind) {
    case "new-tab":
      return "globe";
    case "changes":
      return "diff-changes";
    case "terminal":
      return "terminal";
    case "files":
    case "file":
      return "file-code";
    case "ports":
      return "port-preview";
    case "side":
      return "sparkles";
    case "tasks":
      return "activity";
    case "subagent":
      return "subagent";
    case "mcp":
      return "puzzle";
  }
}

export interface InspectorWorkbenchProps {
  computerKey: string;
  sessionId?: string;
  cwd?: string;
}

export function InspectorWorkbench({
  computerKey,
  sessionId,
  cwd: cwdProp,
}: InspectorWorkbenchProps): JSX.Element {
  const { t, ti } = useInspectorI18n();

  const inspectorWidth = useStore(routerStore, (s) => s.inspectorWidth);
  const routerTab = useStore(routerStore, (s) => s.inspectorTab);
  const routerTabSeq = useStore(routerStore, (s) => s.inspectorTabRequestSeq);
  const bottomDockOpen = useStore(routerStore, (s) => s.bottomDockOpen);

  const scopeTabs = useInspectorTabs(computerKey, sessionId);
  const activeTabItem: InspectorTabItem =
    scopeTabs.tabs.find((item) => item.id === scopeTabs.activeId) ??
    scopeTabs.tabs[0] ?? { id: "new-tab", kind: "new-tab" };

  const tabstripRef = useRef<HTMLDivElement | null>(null);
  const lastRouterSyncRef = useRef<{
    tab: InspectorTab;
    seq: number;
  }>({
    tab: routerTab,
    seq: routerTabSeq,
  });

  const [portCount, setPortCount] = useState(0);
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);

  const {
    connection,
    computer,
    online,
    machine,
    session,
    view,
    subagentViews,
    subagents,
    tasksMap,
    sides,
    cwd,
    agents,
    actions,
  } = useInspectorConnection({
    computerKey,
    sessionId,
    cwd: cwdProp,
  });

  const sessionSummaryStats = useSessionChangesSummary(view);
  const [panelStats, setPanelStats] = useState<ChangesStatsSummary | null>(
    null,
  );
  const effectiveDiffStats = panelStats ?? sessionSummaryStats;

  const runningTasksCount = countRunningTasksAndSubagents(subagents, tasksMap);

  const mcpDiscovery = useMcpAppsDiscovery({
    connection,
    online,
    sessionId,
    sessionAgent: session?.agent,
  });

  // Reset per-host/cwd derived branch & diff stats when switching workspace scope.
  useEffect(() => {
    setPanelStats(null);
    setGitBranch(session?.worktree?.branch);
  }, [computerKey, sessionId, cwd, session?.worktree?.branch]);

  // Lightweight branch & listening-port hydration for New Tab overview before Changes/Ports tabs mount.
  useEffect(() => {
    if (!connection || !online) return undefined;
    let alive = true;
    if (cwd) {
      const storeState = connection.store.getState();
      const gitInfoPromise =
        typeof storeState.gitInfo === "function"
          ? storeState.gitInfo(cwd)
          : connection.link
              .call("git.info", { path: cwd })
              .then((r) => r?.git ?? null)
              .catch(() => null);
      void Promise.resolve(gitInfoPromise)
        .then((info) => {
          if (alive && info?.branch) {
            setGitBranch((prev) => prev ?? info.branch ?? undefined);
          }
        })
        .catch(() => undefined);
    }
    void connection.link
      .call("ports.list", {})
      .then((res) => {
        if (alive && Array.isArray(res?.ports)) {
          setPortCount(res.ports.length);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connection, online, cwd]);

  const openRouterTab = useCallback(
    (target: InspectorTab) => {
      if (target === "mcp") {
        const first = mcpDiscovery.apps[0];
        if (first) {
          const key = appTabId(first.server, first.resourceUri);
          openInspectorTab(
            computerKey,
            sessionId,
            {
              id: `mcp:${key}`,
              kind: "mcp",
              appId: key,
              title: first.title || first.tool || first.server,
            },
            { openPanel: false },
          );
          return;
        }
      }
      openInspectorTab(
        computerKey,
        sessionId,
        routerTabToTabItem(target),
        { openPanel: false },
      );
    },
    [computerKey, mcpDiscovery.apps, sessionId],
  );

  // Only an explicit request (the router bumps its seq) opens a tab; switching sessions must
  // not replay the last session's tab into this one.
  const restoredOnMountRef = useRef(false);
  useEffect(() => {
    const prev = lastRouterSyncRef.current;
    lastRouterSyncRef.current = { tab: routerTab, seq: routerTabSeq };
    // At start-up the remembered tab comes back, once, into an untouched scope.
    if (!restoredOnMountRef.current) {
      restoredOnMountRef.current = true;
      const untouched =
        scopeTabs.tabs.length === 1 && scopeTabs.tabs[0]?.id === "new-tab";
      if (prev.seq === routerTabSeq && untouched && routerTab !== "new-tab") {
        openRouterTab(routerTab);
        return;
      }
    }
    if (prev.seq === routerTabSeq) return;
    if (routerTab === "new-tab") {
      openRouterTab("new-tab");
      return;
    }
    const alreadyActive =
      activeTabItem.kind === routerTab ||
      (routerTab === "files" && activeTabItem.kind === "file") ||
      (routerTab === "mcp" && activeTabItem.kind === "mcp");
    if (!alreadyActive) openRouterTab(routerTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- React only to a new request seq.
  }, [routerTab, routerTabSeq]);

  const scopeKey = inspectorScopeKey(computerKey, sessionId);
  const dialogs = useDialogs();

  useEffect(() => {
    setActiveInspectorScope({ computerKey, sessionId });
    return () => setActiveInspectorScope(undefined);
  }, [computerKey, sessionId]);

  useEffect(
    () =>
      setInspectorDiscardConfirm((tab) =>
        dialogs.confirm(
          ti("discardDraftBody", { name: tab.title || tab.path || tab.id }),
          {
            title: ti("discardDraftTitle"),
            confirmLabel: ti("discardDraftConfirm"),
            cancelLabel: ti("cancel"),
            destructive: true,
          },
        ),
      ),
    [dialogs, ti],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      void requestCloseInspectorTab(computerKey, sessionId, tabId);
    },
    [computerKey, sessionId],
  );

  // Keep active tab pill scrolled into view inside horizontal tab strip.
  useEffect(() => {
    const strip = tabstripRef.current;
    if (!strip) return;
    const activeEl = strip.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeTabItem.id, scopeTabs.tabs.length]);

  const handleOpenFileInTab = useCallback(
    (spec: string, replaceNewTab = false) => {
      openFileTabInInspector(
        computerKey,
        sessionId,
        spec,
        replaceNewTab ? { replaceTabId: "new-tab" } : { openPanel: true },
      );
    },
    [computerKey, sessionId],
  );

  const openFileInTab = useCallback(
    (spec: string) => handleOpenFileInTab(spec, false),
    [handleOpenFileInTab],
  );
  const openFileReplacingNewTab = useCallback(
    (spec: string) => handleOpenFileInTab(spec, true),
    [handleOpenFileInTab],
  );
  const selectTasksTab = useCallback(
    (nextTab: "changes" | "files" | "terminal" | "ports" | "side") =>
      openInspectorTab(computerKey, sessionId, { id: nextTab, kind: nextTab }),
    [computerKey, sessionId],
  );
  const refreshMcpApps = mcpDiscovery.refresh;
  const refreshMcp = useCallback(() => {
    void refreshMcpApps();
  }, [refreshMcpApps]);

  useDesktopCommand((cmd) => {
    if (cmd.command === "inspector" && cmd.panel) {
      const rawPanel = String(cmd.panel);
      routerStore.getState().toggleInspector(true);
      if (rawPanel === "context" || rawPanel === "tasks") {
        openInspectorTab(computerKey, sessionId, { id: "tasks", kind: "tasks" });
      } else if (rawPanel === "preview" || rawPanel === "ports") {
        openInspectorTab(computerKey, sessionId, { id: "ports", kind: "ports" });
      } else if (rawPanel === "side") {
        openInspectorTab(computerKey, sessionId, { id: "side", kind: "side" });
      } else if (
        rawPanel === "new-tab" ||
        rawPanel === "changes" ||
        rawPanel === "files" ||
        rawPanel === "terminal"
      ) {
        if (rawPanel === "terminal" && routerStore.getState().bottomDockOpen) {
          routerStore.getState().toggleBottomDock(false);
        }
        openInspectorTab(computerKey, sessionId, {
          id: rawPanel,
          kind: rawPanel,
        });
      }
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onRawCommand = (event: Event) => {
      const detail =
        (event as CustomEvent<Record<string, unknown>>).detail ?? {};
      if (
        detail.command === "toggleBottomTerminal" ||
        detail.command === "bottom-terminal"
      ) {
        routerStore.getState().toggleBottomDock();
        return;
      }
      if (
        detail.command === "open-file" &&
        typeof detail.path === "string" &&
        detail.path.length > 0
      ) {
        handleOpenFileInTab(detail.path);
      }
    };
    const onOpenFileEvent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          computerKey?: string;
          sessionId?: string;
          path?: string;
          line?: number;
        }>
      ).detail;
      if (!detail?.path) return;
      if (
        detail.computerKey &&
        computerKey &&
        detail.computerKey !== computerKey
      ) {
        return;
      }
      const spec =
        typeof detail.line === "number" && detail.line > 0
          ? `${detail.path}#L${detail.line}`
          : detail.path;
      handleOpenFileInTab(spec);
    };
    window.addEventListener(DESKTOP_COMMAND_EVENT, onRawCommand);
    window.addEventListener(INSPECTOR_OPEN_FILE_EVENT, onOpenFileEvent);
    return () => {
      window.removeEventListener(DESKTOP_COMMAND_EVENT, onRawCommand);
      window.removeEventListener(INSPECTOR_OPEN_FILE_EVENT, onOpenFileEvent);
    };
  }, [computerKey, handleOpenFileInTab]);

  const handleOpenTerminalAt = useCallback(
    (dir: string) => {
      const controller = getTerminalStageController(
        computerKey || "default",
        computerKey || "default",
      );
      // The controller only learns its connection from a mounted terminal panel; this may be first.
      controller.bindConnection(connection);
      controller.createTerminal({ cwd: dir, sessionId }).catch((err: unknown) => {
        void dialogs.alert(err instanceof Error ? err.message : String(err));
      });
      if (!routerStore.getState().bottomDockOpen) {
        openInspectorTab(computerKey, sessionId, {
          id: "terminal",
          kind: "terminal",
        });
      }
    },
    [computerKey, connection, dialogs, sessionId],
  );

  const labelForTab = (tab: InspectorTabItem): string => {
    switch (tab.kind) {
      case "new-tab":
        return ti("tabNewTab");
      case "changes":
        return ti("tabChanges");
      case "terminal":
        return ti("tabTerminal");
      case "files":
        return ti("tabFiles");
      case "file":
        return (
          tab.title ||
          tab.path?.replace(/\\/g, "/").split("/").pop() ||
          ti("tabFiles")
        );
      case "ports":
        return ti("tabPorts");
      case "side":
        return ti("tabSideChat");
      case "tasks":
        return ti("tabBackgroundTasks");
      case "subagent": {
        if (tab.title) return tab.title;
        const found = subagents.find((s) => s.toolCallId === tab.toolCallId);
        return found?.name || found?.agentType || "Subagent";
      }
      case "mcp":
        return tab.title || ti("tabPlugins");
    }
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const target = scopeTabs.tabs[index];
      if (target) {
        event.preventDefault();
        closeTab(target.id);
      }
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const count = scopeTabs.tabs.length;
    if (count <= 1) return;
    const nextIdx =
      event.key === "ArrowRight"
        ? (index + 1) % count
        : (index - 1 + count) % count;
    const nextTab = scopeTabs.tabs[nextIdx];
    if (!nextTab) return;
    activateInspectorTab(computerKey, sessionId, nextTab.id);
    const buttons =
      tabstripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIdx]?.focus();
  };

  // Ctrl+Tab while focus is in the inspector; the app-wide binding calls the same function.
  const handleWorkbenchKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return;
    if (cycleInspectorTab(event.shiftKey ? -1 : 1)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const isWide = inspectorWidth >= 520;

  return (
    <aside
      aria-label={ti("inspectorAria")}
      className="inspector-workbench"
      data-active-tab={activeTabItem.kind}
      data-testid="inspector-workbench"
      onKeyDown={handleWorkbenchKeyDown}
    >
      <SplitResizer
        orientation="vertical"
        side="start"
        size={inspectorWidth}
        min={280}
        max={720}
        defaultSize={400}
        cssVariable="--inspector-w"
        targetSelector=".desktop-workbench"
        paneSelector=".desktop-inspector"
        label={ti("resizeInspector")}
        className="inspector-edge-resizer"
        collapse={{
          threshold: 200,
          onCollapse: () => routerStore.getState().toggleInspector(false),
        }}
        onResize={(nextWidth) =>
          routerStore.getState().setInspectorWidth(nextWidth)
        }
      />

      <div className="inspector-tabs-root inspector-tabs">
        <header className="ls-inspector-header desktop-inspector-header chrome-bar app-drag">
          <div
            ref={tabstripRef}
            role="tablist"
            aria-label={ti("inspectorAria")}
            focusgroup="tablist nomemory"
            className="ls-inspector-tabstrip inspector-header-tablist no-drag"
          >
            {scopeTabs.tabs.map((tab, idx) => (
              <InspectorTabButton
                key={tab.id}
                tab={tab}
                index={idx}
                computerKey={computerKey}
                sessionId={sessionId}
                selected={tab.id === activeTabItem.id}
                title={labelForTab(tab)}
                closeLabel={ti("closeTab")}
                dirtyLabel={ti("unsavedBadge")}
                diffStats={tab.kind === "changes" ? effectiveDiffStats : undefined}
                count={
                  tab.kind === "ports"
                    ? portCount
                    : tab.kind === "tasks"
                      ? runningTasksCount
                      : 0
                }
                onKeyDown={handleTabKeyDown}
                onClose={closeTab}
              />
            ))}
          </div>

          <IconButton
            icon="plus"
            size="icon-sm"
            className="ls-inspector-newtab-btn no-drag"
            label={ti("tabNewTab")}
            onClick={() =>
              openInspectorTab(computerKey, sessionId, {
                id: "new-tab",
                kind: "new-tab",
              })
            }
          />

          <div className="ls-inspector-header__actions inspector-header-actions no-drag">
            {activeTabItem.kind === "terminal" ? (
              <IconButton
                icon="bottom-dock"
                size="icon-sm"
                aria-pressed={bottomDockOpen}
                shortcut={formatShortcut(DESKTOP_SHORTCUTS.terminal)}
                label={bottomDockOpen ? ti("dockToRight") : ti("dockToBottom")}
                onClick={() => routerStore.getState().toggleBottomDock()}
              />
            ) : null}

            <IconButton
              icon={isWide ? "minimize" : "maximize"}
              size="icon-sm"
              label={isWide ? ti("narrowPanel") : ti("widenPanel")}
              onClick={() =>
                routerStore.getState().setInspectorWidth(isWide ? 380 : 580)
              }
            />

            <IconButton
              icon="inspector-toggle"
              size="icon-sm"
              label={t("desktop.toggleInspector")}
              shortcut={formatShortcut(DESKTOP_SHORTCUTS.toggleInspector)}
              onClick={() => routerStore.getState().toggleInspector(false)}
            />
          </div>
        </header>

        <div className="inspector-body">
          {scopeTabs.tabs.map((tab) => {
            const isSelected = tab.id === activeTabItem.id;
            return (
              // Keyed per scope: a tab id like "changes" exists in every session, and sharing
              // one component instance would carry drafts and commit messages across sessions.
              <div
                key={`${scopeKey}:${tab.id}`}
                role="tabpanel"
                data-tab-id={tab.id}
                data-tab-kind={tab.kind}
                data-inactive={isSelected ? undefined : "true"}
                aria-hidden={!isSelected || undefined}
                className="ls-tab-panel inspector-panel-fill"
              >
                <ErrorBoundary resetKeys={[computerKey, sessionId, tab.id]}>
                  {tab.kind === "new-tab" ? (
                    <MemoNewTabView
                      computerKey={computerKey}
                      sessionId={sessionId}
                      connection={connection}
                      computer={computer}
                      online={online}
                      machine={machine}
                      cwd={cwd}
                      gitBranch={gitBranch}
                      view={view}
                      diffStats={effectiveDiffStats}
                      portCount={portCount}
                      subagents={subagents}
                      tasksMap={tasksMap}
                      sides={sides}
                      mcpApps={mcpDiscovery.apps}
                      onOpenFile={openFileReplacingNewTab}
                    />
                  ) : tab.kind === "changes" ? (
                    <MemoChangesPanel
                      connection={connection}
                      online={online}
                      active={isSelected}
                      sessionId={sessionId}
                      session={session}
                      cwd={cwd}
                      view={view}
                      actions={actions}
                      onStatsChange={setPanelStats}
                      onBranchChange={setGitBranch}
                      onOpenFile={openFileInTab}
                    />
                  ) : tab.kind === "files" ? (
                    <MemoFilesPanel
                      connection={connection}
                      online={online}
                      cwd={cwd}
                      agents={agents}
                      onOpenFile={openFileInTab}
                      onOpenTerminalAt={handleOpenTerminalAt}
                    />
                  ) : tab.kind === "file" ? (
                    <MemoFileViewer
                      computerKey={computerKey}
                      sessionId={sessionId}
                      tabId={tab.id}
                      connection={connection}
                      online={online}
                      cwd={cwd}
                      agents={agents}
                      filePath={tab.path ?? ""}
                      lineSpec={tab.lineSpec}
                      reloadNonce={tab.reloadNonce}
                      onOpenTerminalAt={handleOpenTerminalAt}
                    />
                  ) : tab.kind === "terminal" ? (
                    <MemoTerminalPanel
                      computerKey={computerKey}
                      connection={connection}
                      online={online}
                      sessionId={sessionId}
                      cwd={cwd}
                    />
                  ) : tab.kind === "ports" ? (
                    <MemoPreviewPanel
                      computerKey={computerKey}
                      connection={connection}
                      online={online}
                      cwd={cwd}
                      actions={actions}
                      requestedPort={tab.port}
                      requestedPath={tab.path}
                      requestNonce={tab.portRequestNonce}
                      onPortCountChange={setPortCount}
                    />
                  ) : tab.kind === "side" ? (
                    <MemoSideChat
                      computerKey={computerKey}
                      online={online}
                      sessionId={sessionId}
                      cwd={cwd}
                      sides={sides}
                      actions={actions}
                    />
                  ) : tab.kind === "tasks" ? (
                    <MemoTasksPanel
                      computerKey={computerKey}
                      computer={computer}
                      machine={machine}
                      connection={connection}
                      online={online}
                      sessionId={sessionId}
                      cwd={cwd}
                      gitBranch={gitBranch}
                      diffStats={effectiveDiffStats}
                      subagents={subagents}
                      tasksMap={tasksMap}
                      actions={actions}
                      onSelectTab={selectTasksTab}
                      onOpenTerminalAt={handleOpenTerminalAt}
                    />
                  ) : tab.kind === "subagent" ? (
                    <MemoSubagentPanel
                      computerKey={computerKey}
                      sessionId={sessionId}
                      cwd={cwd}
                      toolCallId={tab.toolCallId ?? tab.id.replace(/^subagent:/, "")}
                      fallbackTitle={tab.title}
                      parentView={view}
                      subagentViews={subagentViews}
                      subagents={subagents}
                      actions={actions}
                    />
                  ) : (
                    <MemoMcpAppPanel
                      connection={connection}
                      online={online}
                      sessionId={sessionId}
                      apps={mcpDiscovery.apps}
                      loading={mcpDiscovery.loading}
                      onRefresh={refreshMcp}
                      actions={actions}
                      initialAppKey={tab.appId}
                    />
                  )}
                </ErrorBoundary>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

// Streaming agent output re-renders the workbench per event; panels whose props did not
// change (an open file, the terminal, a preview) skip that work.
const MemoNewTabView = memo(InspectorNewTabView);
const MemoChangesPanel = memo(ChangesPanel);
const MemoFilesPanel = memo(FilesPanel);
const MemoFileViewer = memo(FileViewerTabPanel);
const MemoTerminalPanel = memo(TerminalPanel);
const MemoPreviewPanel = memo(PreviewPanel);
const MemoSideChat = memo(SideChatTabPanel);
const MemoTasksPanel = memo(TasksPanel);
const MemoSubagentPanel = memo(SubagentTabPanel);
const MemoMcpAppPanel = memo(McpAppPanel);

interface InspectorTabButtonProps {
  tab: InspectorTabItem;
  index: number;
  computerKey: string;
  sessionId?: string;
  selected: boolean;
  title: string;
  closeLabel: string;
  dirtyLabel: string;
  diffStats?: ChangesStatsSummary;
  count: number;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  onClose: (tabId: string) => void;
}

function InspectorTabButton({
  tab,
  index,
  computerKey,
  sessionId,
  selected,
  title,
  closeLabel,
  dirtyLabel,
  diffStats,
  count,
  onKeyDown,
  onClose,
}: InspectorTabButtonProps): JSX.Element {
  const dirty = useIsTabDirty(computerKey, sessionId, tab.id);
  return (
    <div
      className="ls-inspector-tab"
      data-active={selected ? "true" : undefined}
      data-tab-id={tab.id}
      data-tab-value={tab.kind}
      data-dirty={dirty ? "true" : undefined}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={dirty ? `${title} · ${dirtyLabel}` : title}
        title={tab.kind === "file" ? tab.path || title : title}
        tabIndex={selected ? 0 : -1}
        data-tab-id={tab.id}
        data-tab-value={tab.kind}
        className="ls-inspector-tab__main"
        onClick={() => {
          if (tab.kind === "terminal" && routerStore.getState().bottomDockOpen) {
            routerStore.getState().toggleBottomDock(false);
          }
          activateInspectorTab(computerKey, sessionId, tab.id);
        }}
        onKeyDown={(e) => onKeyDown(e, index)}
      >
        {tab.kind === "subagent" ? (
          <SubagentGlyph
            sessionId={sessionId}
            toolCallId={tab.toolCallId ?? tab.id}
            size="sm"
          />
        ) : tab.kind === "file" ? (
          <FileExtBadge path={tab.path ?? tab.title ?? ""} />
        ) : (
          <DesktopIcon name={iconForTabKind(tab.kind)} size="xs" />
        )}

        <span className="ls-inspector-tab__label">
          <span className="inspector-tab-title">{title}</span>
          {diffStats && (diffStats.added > 0 || diffStats.removed > 0) ? (
            <span className="inspector-diff-stat-pill" data-tabular="">
              <span className="inspector-diff-stat-add">
                +{formatCompactStat(diffStats.added)}
              </span>
              <span className="inspector-diff-stat-del">
                -{formatCompactStat(diffStats.removed)}
              </span>
            </span>
          ) : null}
          {count > 0 ? (
            <Badge variant="count" tone="neutral">
              {count}
            </Badge>
          ) : null}
        </span>
        {dirty ? <span className="ls-inspector-tab__dirty" aria-hidden="true" /> : null}
      </button>

      <button
        type="button"
        aria-label={`${closeLabel} ${title}`}
        title={closeLabel}
        className="ls-inspector-tab__close"
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
      >
        <DesktopIcon name="close" size={11} />
      </button>
    </div>
  );
}
