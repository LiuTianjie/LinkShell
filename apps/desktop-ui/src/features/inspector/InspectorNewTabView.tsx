import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import type { SessionView, TaskRecords } from "@linkshell/client-core";
import type {
  MachineInfo,
  McpApp,
  SideChat,
  SubagentInfo,
} from "@linkshell/wire";
import {
  DESKTOP_LOCAL,
  desktopInvoke,
  isElectronRuntime,
  revealOnDesktop,
} from "../../bridge/desktop-bridge";
import type { Computer, Connection } from "../../core/connections";
import { appTabId } from "../../core/mcp-bridge";
import { routerStore } from "../../core/router-store";
import { DesktopIcon, SubagentGlyph, type DesktopIconName } from "../../icons";
import {
  Badge,
  IconButton,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  StatusDot,
} from "../../primitives";
import type { ChangesStatsSummary } from "./ChangesPanel";
import { FileExtBadge, formatCompactStat } from "./file-ext-badge";
import { canOpenOnThisComputer } from "./FileViewerTabPanel";
import { useInspectorI18n } from "./i18n-inspector";
import {
  openInspectorTab,
  openSubagentInInspector,
  requestOpenPortInInspector,
} from "./inspector-tabs-store";

export interface ParsedPortTarget {
  port: number;
  path: string;
}

export function parsePortOrUrlInput(raw: string): ParsedPortTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const barePort = /^:?(\d{2,5})(\/.*)?$/.exec(trimmed);
  if (barePort) {
    const port = Number(barePort[1]);
    if (port >= 1 && port <= 65535) {
      return { port, path: barePort[2] || "/" };
    }
  }

  const normalized = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/i.test(trimmed)
      ? `http://${trimmed}`
      : null;
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const port = Number(url.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return {
        port,
        path: `${url.pathname || "/"}${url.search}${url.hash}`,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function basenameOfPath(rawPath: string): string {
  const trimmed = rawPath.replace(/[\\/]+$/, "");
  if (!trimmed) return rawPath;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function platformIconFor(platform?: string): DesktopIconName {
  if (platform === "darwin" || platform === "macos") return "computer-mac";
  if (platform === "linux") return "computer-linux";
  return "computer-pc";
}

function formatElapsedShort(startedAt?: number): string | undefined {
  if (!startedAt || startedAt <= 0) return undefined;
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

function formatTokenShort(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

interface MergedSubagentItem {
  toolCallId: string;
  title: string;
  task?: string;
  running: boolean;
  failed: boolean;
  startedAt?: number;
}

interface SearchFileHit {
  path: string;
  label: string;
  isDir?: boolean;
}

export interface InspectorNewTabViewProps {
  computerKey: string;
  sessionId?: string;
  connection?: Connection;
  computer?: Computer;
  online: boolean;
  machine?: MachineInfo;
  cwd?: string;
  gitBranch?: string;
  view?: SessionView;
  diffStats: ChangesStatsSummary;
  portCount: number;
  subagents: readonly SubagentInfo[];
  tasksMap: TaskRecords;
  sides: readonly SideChat[];
  mcpApps: readonly McpApp[];
  onOpenFile: (path: string) => void;
}

export function InspectorNewTabView({
  computerKey,
  sessionId,
  connection,
  computer,
  online,
  machine,
  cwd,
  gitBranch,
  view,
  diffStats,
  portCount,
  subagents,
  tasksMap,
  sides,
  mcpApps,
  onOpenFile,
}: InspectorNewTabViewProps): JSX.Element {
  const { locale, ti } = useInspectorI18n();
  const [query, setQuery] = useState("");
  const [fileHits, setFileHits] = useState<SearchFileHit[]>([]);
  const [showAllSubagents, setShowAllSubagents] = useState(false);

  const parsedPort = useMemo(() => parsePortOrUrlInput(query), [query]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || parsedPort || !connection || !online) {
      setFileHits([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (cwd) {
            const res = await connection.link.call("fs.projectFiles", {
              cwd,
              query: trimmed,
              limit: 8,
            });
            if (!cancelled && Array.isArray(res?.files)) {
              setFileHits(
                res.files
                  .filter((f) => !f.isDir)
                  .slice(0, 8)
                  .map((f) => ({
                    path: f.path,
                    label: f.relativePath || f.path,
                  })),
              );
              return;
            }
          }
        } catch {
          // Fall back to fs.search on older hosts.
        }
        try {
          const fallback = await connection.link.call("fs.search", {
            query: trimmed,
            limit: 8,
          });
          if (!cancelled && Array.isArray(fallback?.entries)) {
            setFileHits(
              fallback.entries
                .filter((e) => e.file !== false)
                .slice(0, 8)
                .map((e) => ({
                  path: e.path || e.name,
                  label: e.name,
                })),
            );
          }
        } catch {
          if (!cancelled) setFileHits([]);
        }
      })();
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection, cwd, online, parsedPort, query]);

  const handleSearchSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (parsedPort) {
        requestOpenPortInInspector(
          computerKey,
          sessionId,
          parsedPort.port,
          parsedPort.path,
          "new-tab",
        );
        setQuery("");
        return;
      }
      if (fileHits.length > 0) {
        onOpenFile(fileHits[0]!.path);
        setQuery("");
      }
    },
    [computerKey, fileHits, onOpenFile, parsedPort, sessionId],
  );

  const mergedSubagents = useMemo<MergedSubagentItem[]>(() => {
    const map = new Map<string, MergedSubagentItem>();
    for (const sub of subagents) {
      map.set(sub.toolCallId, {
        toolCallId: sub.toolCallId,
        title: sub.name || sub.agentType || sub.task || "Subagent",
        task: sub.task,
        running: Boolean(sub.running),
        failed: Boolean(sub.failed),
        startedAt: sub.startedAt,
      });
    }
    if (view) {
      for (const item of view.items) {
        if (
          item.kind === "tool" &&
          (item.detail?.type === "subagent" || item.sub !== undefined)
        ) {
          const detail =
            item.detail?.type === "subagent" ? item.detail : undefined;
          if (detail && detail.action && detail.action !== "spawn") continue;
          const existing = map.get(item.id);
          const st = detail?.workflow?.state ?? detail?.state;
          const running =
            existing?.running ??
            (st === "running" ||
              (!st &&
                (item.status === "in_progress" || item.status === "pending")));
          const failed =
            existing?.failed ?? (st === "failed" || item.status === "failed");
          map.set(item.id, {
            toolCallId: item.id,
            title:
              existing?.title ||
              detail?.name ||
              detail?.agentType ||
              item.title ||
              "Subagent",
            task: existing?.task ?? detail?.task,
            running,
            failed,
            startedAt: existing?.startedAt ?? item.ts,
          });
        }
      }
    }
    return Array.from(map.values());
  }, [subagents, view]);

  const runningSubagentsCount = useMemo(
    () => mergedSubagents.filter((s) => s.running).length,
    [mergedSubagents],
  );

  const visibleSubagents = useMemo(
    () =>
      showAllSubagents ? mergedSubagents : mergedSubagents.slice(0, 4),
    [mergedSubagents, showAllSubagents],
  );

  const runningBgTasks = useMemo(
    () =>
      Object.values(tasksMap).filter((task) => task.state === "running"),
    [tasksMap],
  );

  const hostTitle =
    machine?.naming?.customName ||
    machine?.naming?.defaultName ||
    machine?.hostname ||
    computer?.machine.name ||
    computerKey ||
    "Local";

  const platformIcon = platformIconFor(
    machine?.platform ?? computer?.machine.platform,
  );

  const usedTokens = view?.usage?.usedTokens ?? 0;
  const contextWindow = view?.usage?.contextWindow ?? 0;
  const usagePct =
    usedTokens > 0 && contextWindow > 0
      ? Math.min(100, Math.max(2, Math.round((usedTokens / contextWindow) * 100)))
      : usedTokens > 0
        ? Math.min(100, Math.max(4, Math.round((usedTokens / 200_000) * 100)))
        : 0;

  const handleOpenInEditor = useCallback(
    async (app: "vscode" | "cursor" | "reveal") => {
      const targetPath = cwd || machine?.home;
      if (!targetPath) return;
      const isLocalConnection =
        !connection || connection.computer.key === DESKTOP_LOCAL;
      if (app === "reveal" && isElectronRuntime() && isLocalConnection) {
        const ok = await revealOnDesktop(targetPath);
        if (ok) return;
      }
      if (!connection) return;
      if (!canOpenOnThisComputer(connection)) return;
      try {
        await connection.link.call("desktop.openPath", {
          path: targetPath,
          app,
        });
      } catch {
        await desktopInvoke("openPath", { path: targetPath, app }).catch(
          () => undefined,
        );
      }
    },
    [connection, cwd, machine?.home],
  );

  const dirtyDiff = diffStats.added > 0 || diffStats.removed > 0;

  return (
    <div className="ls-newtab inspector-panel-scroll" data-testid="inspector-new-tab">
      {/* Row 1: Antigravity-style Pill Search / URL Input */}
      <form
        className="ls-newtab__search-form ls-newtab__search"
        onSubmit={handleSearchSubmit}
      >
        <div className="ls-newtab__search-pill">
          <DesktopIcon
            name="search"
            size="sm"
            className="ls-newtab__search-icon"
          />
          <input
            type="search"
            value={query}
            placeholder={ti("newTabSearchPlaceholder")}
            aria-label={ti("newTabSearchPlaceholder")}
            className="ls-newtab__search-input"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <IconButton
              icon="close"
              size="icon-sm"
              label={ti("clearComments")}
              onClick={() => setQuery("")}
            />
          ) : null}
        </div>

        {parsedPort || fileHits.length > 0 ? (
          <div className="ls-newtab__search-results" role="listbox">
            {parsedPort ? (
              <button
                type="button"
                role="option"
                aria-selected={true}
                className="ls-newtab__search-hit"
                onClick={() => {
                  requestOpenPortInInspector(
                    computerKey,
                    sessionId,
                    parsedPort.port,
                    parsedPort.path,
                    "new-tab",
                  );
                  setQuery("");
                }}
              >
                <DesktopIcon name="globe" size="sm" />
                <span className="ls-truncate">
                  {ti("openPortShortcut", { port: parsedPort.port })}
                </span>
                <span className="ls-newtab__tool-meta" data-tabular="">
                  :{parsedPort.port}
                </span>
              </button>
            ) : null}

            {fileHits.map((hit, index) => (
              <button
                key={hit.path}
                type="button"
                role="option"
                aria-selected={!parsedPort && index === 0}
                className="ls-newtab__search-hit"
                onClick={() => {
                  onOpenFile(hit.path);
                  setQuery("");
                }}
              >
                <FileExtBadge path={hit.path} />
                <span className="ls-truncate" title={hit.path}>
                  {hit.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </form>

      {/* Row 2: Codex-style 2-Column Tactile 工具 Grid */}
      <section className="ls-newtab__section">
        <div className="ls-newtab__section-head">
          <span className="ls-newtab__section-title">{ti("toolsSection")}</span>
        </div>

        <div className="ls-newtab__tools-grid ls-newtab__actions">
          <button
            type="button"
            className="ls-newtab__tool-card ls-newtab__action"
            onClick={() =>
              openInspectorTab(
                computerKey,
                sessionId,
                { id: "changes", kind: "changes" },
                { replaceTabId: "new-tab" },
              )
            }
          >
            <span className="ls-newtab__tool-lead">
              <DesktopIcon name="diff-changes" size="sm" />
              <span className="ls-newtab__tool-label">{ti("tabChanges")}</span>
            </span>
            {dirtyDiff ? (
              <span className="inspector-diff-stat-pill" data-tabular="">
                <span className="inspector-diff-stat-add">
                  +{formatCompactStat(diffStats.added)}
                </span>
                <span className="inspector-diff-stat-del">
                  -{formatCompactStat(diffStats.removed)}
                </span>
              </span>
            ) : null}
          </button>

          <button
            type="button"
            className="ls-newtab__tool-card ls-newtab__action"
            onClick={() => {
              if (routerStore.getState().bottomDockOpen) {
                routerStore.getState().toggleBottomDock(false);
              }
              openInspectorTab(
                computerKey,
                sessionId,
                { id: "terminal", kind: "terminal" },
                { replaceTabId: "new-tab" },
              );
            }}
          >
            <span className="ls-newtab__tool-lead">
              <DesktopIcon name="terminal" size="sm" />
              <span className="ls-newtab__tool-label">{ti("tabTerminal")}</span>
            </span>
            <Kbd shortcut="Mod+J" />
          </button>

          <button
            type="button"
            className="ls-newtab__tool-card ls-newtab__action"
            onClick={() =>
              openInspectorTab(
                computerKey,
                sessionId,
                { id: "files", kind: "files" },
                { replaceTabId: "new-tab" },
              )
            }
          >
            <span className="ls-newtab__tool-lead">
              <DesktopIcon name="file-code" size="sm" />
              <span className="ls-newtab__tool-label">{ti("tabFiles")}</span>
            </span>
            <Kbd shortcut="Mod+P" />
          </button>

          <button
            type="button"
            className="ls-newtab__tool-card ls-newtab__action"
            onClick={() =>
              openInspectorTab(
                computerKey,
                sessionId,
                { id: "side", kind: "side" },
                { replaceTabId: "new-tab" },
              )
            }
          >
            <span className="ls-newtab__tool-lead">
              <DesktopIcon name="sparkles" size="sm" />
              <span className="ls-newtab__tool-label">{ti("tabSideChat")}</span>
            </span>
            {sides.length > 0 ? (
              <Badge variant="count" tone="neutral">
                {sides.length}
              </Badge>
            ) : (
              <span className="ls-newtab__tool-meta">/side</span>
            )}
          </button>

          <button
            type="button"
            className="ls-newtab__tool-card ls-newtab__action"
            onClick={() =>
              openInspectorTab(
                computerKey,
                sessionId,
                { id: "ports", kind: "ports" },
                { replaceTabId: "new-tab" },
              )
            }
          >
            <span className="ls-newtab__tool-lead">
              <DesktopIcon name="port-preview" size="sm" />
              <span className="ls-newtab__tool-label">{ti("tabPorts")}</span>
            </span>
            {portCount > 0 ? (
              <Badge variant="count" tone="neutral">
                {portCount}
              </Badge>
            ) : null}
          </button>

          <Menu
            placement="bottom-end"
            label={ti("moreTools")}
            trigger={
              <button
                type="button"
                className="ls-newtab__tool-card ls-newtab__action"
              >
                <span className="ls-newtab__tool-lead">
                  <DesktopIcon name="puzzle" size="sm" />
                  <span className="ls-newtab__tool-label">
                    {ti("moreTools")}
                  </span>
                </span>
                <DesktopIcon name="chevron-down" size="xs" />
              </button>
            }
          >
            <MenuLabel>{ti("mcpPluginsGroup")}</MenuLabel>
            {mcpApps.length > 0 ? (
              mcpApps.map((app) => {
                const key = appTabId(app.server, app.resourceUri);
                const label = app.title || app.tool || app.server;
                return (
                  <MenuItem
                    key={key}
                    icon="puzzle"
                    onSelect={() =>
                      openInspectorTab(
                        computerKey,
                        sessionId,
                        {
                          id: `mcp:${key}`,
                          kind: "mcp",
                          appId: key,
                          title: label,
                        },
                        { replaceTabId: "new-tab" },
                      )
                    }
                  >
                    {label}
                  </MenuItem>
                );
              })
            ) : (
              <MenuItem icon="puzzle" disabled>
                {ti("noMcpPlugins")}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              icon="activity"
              shortcut={
                runningBgTasks.length > 0
                  ? String(runningBgTasks.length)
                  : undefined
              }
              onSelect={() =>
                openInspectorTab(
                  computerKey,
                  sessionId,
                  { id: "tasks", kind: "tasks" },
                  { replaceTabId: "new-tab" },
                )
              }
            >
              {ti("tabBackgroundTasks")}
            </MenuItem>
            <MenuItem
              icon="bottom-dock"
              onSelect={() => routerStore.getState().toggleBottomDock(true)}
            >
              {ti("bottomTerminalPanel")}
            </MenuItem>
            <MenuItem
              icon="external-link"
              disabled={
                !online ||
                !(cwd || machine?.home) ||
                !canOpenOnThisComputer(connection)
              }
              onSelect={() => {
                void handleOpenInEditor("vscode");
              }}
            >
              {ti("contextOpenInEditor")}
            </MenuItem>
          </Menu>
        </div>
      </section>

      {/* Row 3: Antigravity-style Conditional Subagents Section */}
      {mergedSubagents.length > 0 ? (
        <section
          className="ls-newtab__section ls-newtab__subagents"
          data-testid="inspector-newtab-subagents"
        >
          <div className="ls-newtab__section-head">
            <span className="ls-newtab__section-title">
              <span>{ti("subagentsHeader")}</span>
              <Badge variant="count" tone="neutral">
                {mergedSubagents.length}
              </Badge>
              {runningSubagentsCount > 0 ? (
                <StatusDot tone="running" size="sm" />
              ) : null}
            </span>
          </div>

          <div className="ls-newtab__subagent-list">
            {visibleSubagents.map((sub) => {
              const elapsed = formatElapsedShort(sub.startedAt);
              return (
                <button
                  key={sub.toolCallId}
                  type="button"
                  className="ls-newtab__subagent-row"
                  data-running={sub.running ? "true" : undefined}
                  onClick={() =>
                    openSubagentInInspector(computerKey, sessionId, {
                      toolCallId: sub.toolCallId,
                      title: sub.title,
                    })
                  }
                >
                  <SubagentGlyph
                    sessionId={sessionId}
                    toolCallId={sub.toolCallId}
                    size="sm"
                  />
                  <span className="ls-newtab__subagent-body">
                    <span className="ls-newtab__subagent-title ls-truncate">
                      {sub.title}
                    </span>
                    {sub.task && sub.task !== sub.title ? (
                      <span className="ls-newtab__subagent-task ls-truncate">
                        {sub.task}
                      </span>
                    ) : null}
                  </span>
                  {elapsed ? (
                    <span className="ls-newtab__tool-meta" data-tabular="">
                      {elapsed}
                    </span>
                  ) : null}
                  <DesktopIcon name="chevron-right" size="xs" />
                </button>
              );
            })}

            {mergedSubagents.length > 4 ? (
              <button
                type="button"
                className="ls-newtab__more-btn"
                onClick={() => setShowAllSubagents((v) => !v)}
              >
                {showAllSubagents
                  ? ti("collapseSubagents")
                  : ti("viewAllSubagents", { count: mergedSubagents.length })}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Direct 1-Click MCP Plugins Section (when MCP apps exist) */}
      {mcpApps.length > 0 ? (
        <section
          className="ls-newtab__section ls-newtab__mcp"
          data-testid="inspector-newtab-mcp"
        >
          <div className="ls-newtab__section-head">
            <span className="ls-newtab__section-title">
              <span>
                {locale === "en"
                  ? "MCP Plugins"
                  : locale === "ja"
                    ? "MCP プラグイン"
                    : "MCP 插件"}
              </span>
              <Badge variant="count" tone="neutral">
                {mcpApps.length}
              </Badge>
            </span>
          </div>

          <div className="ls-newtab__subagent-list">
            {mcpApps.map((app) => {
              const key = appTabId(app.server, app.resourceUri);
              const label = app.title || app.tool || app.server;
              return (
                <button
                  key={key}
                  type="button"
                  className="ls-newtab__subagent-row"
                  data-mcp-key={key}
                  onClick={() =>
                    openInspectorTab(
                      computerKey,
                      sessionId,
                      {
                        id: `mcp:${key}`,
                        kind: "mcp",
                        appId: key,
                        title: label,
                      },
                      { replaceTabId: "new-tab" },
                    )
                  }
                >
                  <DesktopIcon name="puzzle" size="sm" />
                  <span className="ls-newtab__subagent-body">
                    <span className="ls-newtab__subagent-title ls-truncate">
                      {label}
                    </span>
                    {app.server && app.server !== label ? (
                      <span className="ls-newtab__subagent-task ls-truncate">
                        {app.server}
                      </span>
                    ) : null}
                  </span>
                  <DesktopIcon name="chevron-right" size="xs" />
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Row 4: Claude-style Borderless Environment & Context */}
      <section
        className="ls-newtab__section ls-newtab__context"
        data-testid="inspector-newtab-context"
      >
        <div className="ls-newtab__section-head">
          <span className="ls-newtab__section-title">
            {ti("envContextSection")}
          </span>
        </div>

        <div className="ls-newtab__context-list">
          <div className="ls-newtab__context-row">
            <span className="ls-newtab__context-lead">
              <DesktopIcon name={platformIcon} size="sm" />
              <span className="ls-truncate">{hostTitle}</span>
            </span>
            <StatusDot tone={online ? "ok" : "offline"} size="sm" />
          </div>

          {cwd ? (
            <div className="ls-newtab__context-row">
              <span className="ls-newtab__context-lead" title={cwd}>
                <DesktopIcon name="folder" size="sm" />
                <span className="ls-truncate">{basenameOfPath(cwd)}</span>
              </span>
              <IconButton
                icon="external-link"
                size="icon-sm"
                label={ti("contextOpenInEditor")}
                disabled={!online}
                onClick={() => {
                  void handleOpenInEditor("vscode");
                }}
              />
            </div>
          ) : null}

          {gitBranch ? (
            <div className="ls-newtab__context-row">
              <span className="ls-newtab__context-lead">
                <DesktopIcon name="git-branch" size="sm" />
                <span
                  className="ls-truncate"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {gitBranch}
                </span>
              </span>
            </div>
          ) : null}

          {usedTokens > 0 ? (
            <div className="ls-newtab__usage">
              <div className="ls-newtab__usage-track" aria-hidden="true">
                <div
                  className="ls-newtab__usage-fill"
                  style={{ width: `${usagePct}%` }}
                />
              </div>
              <span className="ls-newtab__usage-label" data-tabular="">
                {ti("contextTokensUsed", {
                  used: formatTokenShort(usedTokens),
                })}
              </span>
            </div>
          ) : null}

          {runningBgTasks.length > 0 ? (
            <button
              type="button"
              className="ls-newtab__context-row ls-newtab__task-row"
              onClick={() =>
                openInspectorTab(
                  computerKey,
                  sessionId,
                  { id: "tasks", kind: "tasks" },
                  { replaceTabId: "new-tab" },
                )
              }
            >
              <span className="ls-newtab__context-lead">
                <DesktopIcon name="activity" size="sm" />
                <span className="ls-truncate">
                  {ti("runningTasksBadge", { count: runningBgTasks.length })}
                </span>
              </span>
              <DesktopIcon name="chevron-right" size="xs" />
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
