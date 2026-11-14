import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { revealOnDesktop } from "../../bridge/desktop-bridge";
import {
  evaluateFusionCapability,
  fusionCapabilityMessage,
  launchFusionApp,
  loadFusionIcons,
  pollFusionState,
  quitFusionApp,
  refreshFusionState,
  startComputerFusion,
  stopComputerFusion,
  useFusionState,
  type FusionRemoteApp,
} from "../../core/fusion-store";
import { useI18n } from "../../core/i18n";
import { routerStore } from "../../core/router-store";
import { DesktopIcon } from "../../icons";
import {
  Badge,
  Button,
  ContextMenu,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  StatusDot,
  Tab,
  TabList,
  Tabs,
  Toolbar,
  isImeComposing,
  startScopedViewTransition,
  useDialogs,
} from "../../primitives";
import { RemoteModeSwitch } from "./FusionControls";
import {
  getRemoteCopy,
  resolveAppCategory,
  type FusionCategoryKey,
  type RemoteCopy,
} from "./remote-copy";
import {
  resolveLocalDesktopEnv,
  useRemoteComputer,
} from "./use-remote-computer";

export interface FusionWorkspaceProps {
  computerKey: string;
  /** Set true only when WorkspaceTopBar is intentionally omitted above this view. */
  standaloneChrome?: boolean;
}

interface ExtendedFusionApp extends FusionRemoteApp {
  category?: string;
  rawCategory?: string;
  isSystem?: boolean;
  stubPath?: string;
}

const ORDERED_CATEGORIES: FusionCategoryKey[] = [
  "all",
  "running",
  "developer",
  "productivity",
  "utilities",
  "social",
  "entertainment",
  "creative",
  "other",
];

type FusionErrorKind = "permission" | "locked" | "outdated" | "generic";

function classifyFusionError(error: string): FusionErrorKind {
  const lower = error.toLowerCase();
  if (
    lower.includes("录制") ||
    lower.includes("权限") ||
    lower.includes("permission") ||
    lower.includes("recording") ||
    lower.includes("accessibility") ||
    lower.includes("denied")
  ) {
    return "permission";
  }
  if (
    lower.includes("锁屏") ||
    lower.includes("locked") ||
    lower.includes("host_locked")
  ) {
    return "locked";
  }
  if (
    lower.includes("-32601") ||
    lower.includes("method not found") ||
    lower.includes("host_outdated") ||
    lower.includes("outdated") ||
    lower.includes("不支持")
  ) {
    return "outdated";
  }
  return "generic";
}

function appMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "A";
  const first = Array.from(trimmed)[0] ?? "A";
  return first.toUpperCase();
}

const SKELETON_SLOTS = Array.from({ length: 12 }, (_, idx) => idx);

function FusionAppIcon({
  name,
  src,
  size = "md",
  showRemoteBadge = false,
}: {
  name: string;
  src?: string;
  size?: "sm" | "md";
  showRemoteBadge?: boolean;
}) {
  return (
    <span
      className="ls-fusion-icon"
      data-size={size}
      style={size === "md" ? { inlineSize: 48, blockSize: 48 } : undefined}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="ls-fusion-icon__img"
        />
      ) : (
        <span className="ls-fusion-icon__fallback" aria-hidden="true">
          {appMonogram(name)}
        </span>
      )}
      {showRemoteBadge ? (
        <span className="ls-fusion-icon__badge" aria-hidden="true">
          <DesktopIcon name="fusion-mode" size={10} />
        </span>
      ) : null}
    </span>
  );
}

function FusionRemediationBanner({
  error,
  copy,
  retrying,
  checkingPerm,
  canCheckPerm,
  onRetry,
  onCheckPermission,
  onOpenFullDesktop,
}: {
  error: string;
  copy: RemoteCopy;
  retrying: boolean;
  checkingPerm: boolean;
  canCheckPerm: boolean;
  onRetry: () => void;
  onCheckPermission: () => void;
  onOpenFullDesktop: () => void;
}) {
  const kind = classifyFusionError(error);
  const isWaiting = kind === "permission" || kind === "locked";

  const title =
    kind === "permission"
      ? copy.fusionPermissionTitle
      : kind === "locked"
        ? copy.fusionLockedTitle
        : kind === "outdated"
          ? copy.fusionOutdatedTitle
          : copy.fusionConnectionErrorTitle;

  const description =
    kind === "permission"
      ? copy.fusionPermissionDesc
      : kind === "locked"
        ? copy.fusionLockedDesc
        : kind === "outdated"
          ? copy.fusionOutdatedDesc
          : error;

  return (
    <div
      role="alert"
      data-tone={isWaiting ? "waiting" : "danger"}
      className="ls-remote-remediation"
    >
      <div className="ls-remote-remediation__main">
        <span className="ls-remote-remediation__icon" aria-hidden="true">
          <DesktopIcon
            name={
              kind === "locked"
                ? "lock"
                : kind === "permission"
                  ? "approval-pending"
                  : "alert-triangle"
            }
            size="md"
          />
        </span>
        <div>
          <p className="ls-remote-remediation__title">{title}</p>
          <p className="ls-remote-remediation__desc">{description}</p>
          {kind === "permission" ? (
            <ol className="ls-remote-remediation__steps">
              {copy.fusionPermissionSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
      <div className="ls-remote-remediation__actions">
        {kind === "permission" && canCheckPerm ? (
          <Button
            size="sm"
            variant="secondary"
            loading={checkingPerm}
            onClick={onCheckPermission}
          >
            {copy.fusionCheckPermissions}
          </Button>
        ) : null}
        {kind === "locked" ? (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon="remote-screen"
            onClick={onOpenFullDesktop}
          >
            {copy.fusionSwitchToScreen}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          leadingIcon="refresh"
          loading={retrying}
          onClick={onRetry}
        >
          {copy.fusionRetry}
        </Button>
      </div>
    </div>
  );
}

/**
 * First-Class 融合模式 (Fusion Mode Launchpad & Active Window Hub) (`#7` §3.3, `#18`).
 */
export function FusionWorkspace({
  computerKey,
  standaloneChrome = false,
}: FusionWorkspaceProps): JSX.Element {
  const { locale } = useI18n();
  const copy = getRemoteCopy(locale);
  const dialogs = useDialogs();
  const {
    connection,
    displayName,
    remotePlatform,
    platformIcon,
    online,
    statusTone,
  } = useRemoteComputer(computerKey, { retainStreams: true });

  const fusion = useFusionState(computerKey);
  const capability = evaluateFusionCapability(
    computerKey,
    remotePlatform,
    resolveLocalDesktopEnv(),
  );

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FusionCategoryKey>("all");
  const [checkingPermission, setCheckingPermission] = useState(false);
  const [pausedByUser, setPausedByUser] = useState<Record<string, boolean>>({});
  const manualPauseRef = useRef<Record<string, boolean>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);
  const requestedIconsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    requestedIconsRef.current.clear();
  }, [computerKey, fusion.hostSlug]);

  const isConnected =
    fusion.phase === "connected" || (fusion.hubRunning && fusion.connected);
  const isStarting = fusion.phase === "starting";
  const isStopping = fusion.phase === "stopping";
  const manuallyPaused = Boolean(pausedByUser[computerKey]);

  // Hydrate initial Fusion Hub snapshot / cached catalog on mount.
  useEffect(() => {
    if (!capability.supported) return;
    void refreshFusionState(computerKey, displayName);
  }, [capability.supported, computerKey, displayName]);

  // Poll live window counts & app catalog (`450ms` during handshake, `2000ms` steady-state).
  useEffect(() => {
    if (!capability.supported || (!isStarting && !fusion.hubRunning && !isConnected)) {
      return undefined;
    }
    return pollFusionState(computerKey, displayName);
  }, [capability.supported, computerKey, displayName, fusion.hubRunning, isConnected, isStarting]);

  // Batch-load 160x160 badged squircle icons for discovered apps (at most once per bundle/slug).
  useEffect(() => {
    if (!capability.supported || fusion.apps.length === 0 || !fusion.hostSlug) {
      return;
    }
    const missing = fusion.apps
      .map((app) => app.bundle)
      .filter(
        (bundle) =>
          Boolean(bundle) &&
          !(bundle in fusion.icons) &&
          !requestedIconsRef.current.has(bundle),
      );
    if (missing.length === 0) return;
    const batch = missing.slice(0, 32);
    for (const bundle of batch) {
      requestedIconsRef.current.add(bundle);
    }
    void loadFusionIcons(computerKey, fusion.hostSlug, batch);
  }, [capability.supported, computerKey, fusion.apps, fusion.hostSlug, fusion.icons]);

  const runningSet = useMemo(() => {
    const active = new Set<string>(fusion.activeBundles);
    for (const [bundle, count] of Object.entries(fusion.windowCounts)) {
      if (count > 0) active.add(bundle);
    }
    for (const app of fusion.apps) {
      if (app.running || (app.windows ?? 0) > 0) active.add(app.bundle);
    }
    return active;
  }, [fusion.activeBundles, fusion.apps, fusion.windowCounts]);

  const enrichedApps = useMemo<ExtendedFusionApp[]>(() => {
    const map = new Map<string, ExtendedFusionApp>();
    for (const raw of fusion.apps) {
      const ext = raw as ExtendedFusionApp;
      map.set(ext.bundle, ext);
    }
    for (const bundle of runningSet) {
      if (!map.has(bundle)) {
        const fallbackName = bundle.split(".").at(-1) || bundle;
        map.set(bundle, {
          bundle,
          name: fallbackName,
          running: true,
          windows: fusion.windowCounts[bundle] ?? 1,
        });
      }
    }
    return [...map.values()].sort((a, b) => {
      const aRun = runningSet.has(a.bundle) ? 0 : 1;
      const bRun = runningSet.has(b.bundle) ? 0 : 1;
      if (aRun !== bRun) return aRun - bRun;
      return a.name.localeCompare(b.name, locale);
    });
  }, [fusion.apps, fusion.windowCounts, locale, runningSet]);

  const runningApps = useMemo(
    () => enrichedApps.filter((app) => runningSet.has(app.bundle)),
    [enrichedApps, runningSet],
  );

  const totalWindowCount = useMemo(() => {
    const fromCounts = Object.values(fusion.windowCounts).reduce(
      (sum, n) => sum + (Number.isFinite(n) ? n : 0),
      0,
    );
    return fromCounts > 0 ? fromCounts : runningApps.length;
  }, [fusion.windowCounts, runningApps.length]);

  const categoryCounts = useMemo(() => {
    const counts: Record<FusionCategoryKey, number> = {
      all: enrichedApps.length,
      running: runningApps.length,
      developer: 0,
      productivity: 0,
      utilities: 0,
      social: 0,
      entertainment: 0,
      creative: 0,
      other: 0,
    };
    for (const app of enrichedApps) {
      const cat = resolveAppCategory(app.category, app.rawCategory);
      counts[cat] += 1;
    }
    return counts;
  }, [enrichedApps, runningApps.length]);

  const visibleCategories = useMemo(
    () =>
      ORDERED_CATEGORIES.filter(
        (key) =>
          key === "all" ||
          key === "running" ||
          key === category ||
          categoryCounts[key] > 0,
      ),
    [category, categoryCounts],
  );

  const filteredApps = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return enrichedApps.filter((app) => {
      if (category === "running" && !runningSet.has(app.bundle)) return false;
      if (
        category !== "all" &&
        category !== "running" &&
        resolveAppCategory(app.category, app.rawCategory) !== category
      ) {
        return false;
      }
      if (!normalizedQuery) return true;
      return (
        app.name.toLowerCase().includes(normalizedQuery) ||
        app.bundle.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [category, enrichedApps, query, runningSet]);

  const handleCategoryChange = useCallback((next: string) => {
    const valid = next as FusionCategoryKey;
    void startScopedViewTransition(gridRef.current, () => {
      setCategory(valid);
    });
  }, []);

  const handleStartFusion = useCallback(
    async (launchBundle?: string) => {
      if (!connection) return;
      manualPauseRef.current[computerKey] = false;
      setPausedByUser((prev) =>
        prev[computerKey] ? { ...prev, [computerKey]: false } : prev,
      );
      try {
        await startComputerFusion({
          computerKey,
          name: displayName,
          link: connection.link,
          streams: connection.streams,
          launchBundle,
        });
      } catch {
        // Error state is stored in `fusionStore` and rendered via `FusionRemediationBanner`.
      }
    },
    [computerKey, connection, displayName],
  );

  const handleDisconnectFusion = useCallback(async () => {
    manualPauseRef.current[computerKey] = true;
    setPausedByUser((prev) => ({ ...prev, [computerKey]: true }));
    await stopComputerFusion(computerKey, displayName);
    if (connection) {
      await connection.link.call("fusion.stop", {}).catch(() => undefined);
    }
  }, [computerKey, connection, displayName]);

  // Auto-start headless Fusion on capable online remote Macs so the tab immediately shows the live app grid.
  useEffect(() => {
    if (
      !capability.supported ||
      !online ||
      !connection ||
      manualPauseRef.current[computerKey]
    ) {
      return;
    }
    if (
      fusion.phase === "idle" &&
      !fusion.hubRunning &&
      !fusion.connected &&
      !fusion.error
    ) {
      void handleStartFusion();
    }
  }, [
    capability.supported,
    computerKey,
    connection,
    fusion.connected,
    fusion.error,
    fusion.hubRunning,
    fusion.phase,
    handleStartFusion,
    online,
  ]);

  const handleLaunchOrActivate = useCallback(
    async (app: ExtendedFusionApp) => {
      if (!fusion.hubRunning && !isConnected) {
        await handleStartFusion(app.bundle);
        return;
      }
      try {
        await launchFusionApp(computerKey, app.bundle, {
          hostSlug: fusion.hostSlug || undefined,
          name: displayName,
        });
      } catch {
        // Error captured in `fusionStore`.
      }
    },
    [
      computerKey,
      displayName,
      fusion.hostSlug,
      fusion.hubRunning,
      handleStartFusion,
      isConnected,
    ],
  );

  const handleQuit = useCallback(
    async (app: ExtendedFusionApp, force = false) => {
      if (force) {
        const confirmed = await dialogs.confirm(
          copy.fusionForceQuitConfirmDesc(app.name),
          {
            title: copy.fusionForceQuitConfirmTitle(app.name),
            confirmLabel: copy.fusionForceQuitApp,
            destructive: true,
          },
        );
        if (!confirmed) return;
      }
      try {
        await quitFusionApp(computerKey, app.bundle, {
          hostSlug: fusion.hostSlug || undefined,
          name: displayName,
          force,
        });
      } catch {
        // Error captured in `fusionStore`.
      }
    },
    [
      computerKey,
      copy,
      dialogs,
      displayName,
      fusion.hostSlug,
    ],
  );

  const handleRevealStub = useCallback(
    (app?: ExtendedFusionApp) => {
      const targetPath = app?.stubPath || fusion.appsDir;
      if (!targetPath) return;
      void revealOnDesktop(targetPath).catch(() => undefined);
    },
    [fusion.appsDir],
  );

  const handleCheckRemotePermission = useCallback(() => {
    if (!connection) return;
    setCheckingPermission(true);
    void connection.link
      .call("screen.access", { ask: true })
      .catch(() => undefined)
      .finally(() => {
        setCheckingPermission(false);
      });
  }, [connection]);

  const transportLabel =
    fusion.mode === "direct" ? copy.fusionDirect : copy.fusionTunnel;
  const rttSuffix =
    typeof fusion.rttMs === "number" && Number.isFinite(fusion.rttMs)
      ? ` · ${Math.max(1, Math.round(fusion.rttMs))}ms`
      : "";

  return (
    <section
      aria-label={`${displayName} · ${copy.fusionMode}`}
      className="ls-remote-workspace"
    >
      <div
        role="region"
        aria-label={copy.fusionToolbarLabel}
        data-standalone-chrome={standaloneChrome ? "true" : undefined}
        className="ls-remote-subbar"
      >
        <div className="ls-remote-subbar__lead">
          <span className="ls-remote-subbar__computer">
            <DesktopIcon name={platformIcon} size="sm" />
            <span className="ls-remote-subbar__computer-name">{displayName}</span>
            <StatusDot tone={statusTone} size="sm" />
          </span>
          <RemoteModeSwitch computerKey={computerKey} activeMode="fusion" />
          {isConnected ? (
            <span className="ls-remote-subbar__meta ls-remote-subbar__meta--fusion no-drag">
              <span>{`${transportLabel}${rttSuffix}`}</span>
            </span>
          ) : isStarting || fusion.hubRunning ? (
            <span className="ls-remote-subbar__meta ls-remote-subbar__meta--fusion no-drag">
              <DesktopIcon name="spinner" size="xs" />
              <span>{copy.fusionConnecting}</span>
            </span>
          ) : null}
        </div>

        {capability.supported ? (
          <Toolbar
            label={copy.fusionToolbarLabel}
            className="ls-remote-subbar__actions no-drag"
          >
            <Input
              size="sm"
              type="search"
              leadingIcon="search"
              value={query}
              placeholder={copy.fusionSearchPlaceholder}
              aria-label={copy.fusionSearchPlaceholder}
              className="ls-fusion-search no-drag"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !isImeComposing(event) && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              onEnterSubmit={() => {
                const first = filteredApps[0];
                if (first) void handleLaunchOrActivate(first);
              }}
              trailingSlot={
                query ? (
                  <IconButton
                    size="icon-sm"
                    icon="close"
                    label={copy.fusionClearSearch}
                    hideTooltip
                    onClick={() => setQuery("")}
                  />
                ) : undefined
              }
            />

            <IconButton
              size="icon-sm"
              icon="refresh"
              label={copy.fusionRefreshCatalog}
              disabled={!fusion.hubRunning && !isConnected}
              disabledReason={copy.fusionHubNotRunningReason}
              onClick={() => void refreshFusionState(computerKey, displayName)}
            />

            {fusion.appsDir ? (
              <IconButton
                size="icon-sm"
                icon="folder-open"
                label={copy.fusionRevealStubs}
                onClick={() => handleRevealStub()}
              />
            ) : null}

            {fusion.hubRunning || isConnected || isStarting ? (
              <Button
                size="sm"
                variant="danger-ghost"
                leadingIcon="stop-square"
                loading={isStopping}
                onClick={() => void handleDisconnectFusion()}
              >
                {copy.fusionDisconnect}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                leadingIcon="fusion-mode"
                loading={isStarting}
                loadingLabel={copy.fusionConnecting}
                disabled={!online || !connection}
                disabledReason={
                  !online ? copy.screenOfflineTitle : undefined
                }
                onClick={() => void handleStartFusion()}
              >
                {copy.fusionStart}
              </Button>
            )}
          </Toolbar>
        ) : null}
      </div>

      {!capability.supported ? (
        <div className="ls-fusion-empty-wrap">
          <EmptyState
            icon="fusion-mode"
            title={copy.fusionUnsupportedTitle}
            description={fusionCapabilityMessage(capability.reason, locale)}
            actions={
              capability.reason === "local-computer" ? (
                <Button
                  variant="primary"
                  leadingIcon="plus"
                  onClick={() =>
                    routerStore.getState().openNewSession(computerKey)
                  }
                >
                  {copy.fusionNewLocalSession}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  leadingIcon="remote-screen"
                  onClick={() => routerStore.getState().openScreen(computerKey)}
                >
                  {copy.fusionSwitchToScreen}
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="ls-fusion-body">
          {fusion.error ? (
            <FusionRemediationBanner
              error={fusion.error}
              copy={copy}
              retrying={isStarting}
              checkingPerm={checkingPermission}
              canCheckPerm={Boolean(connection && online)}
              onRetry={() => void handleStartFusion()}
              onCheckPermission={handleCheckRemotePermission}
              onOpenFullDesktop={() =>
                routerStore.getState().openScreen(computerKey)
              }
            />
          ) : null}

          {runningApps.length > 0 ? (
            <section
              aria-label={copy.fusionActiveWindowsTitle}
              className="ls-fusion-active-section"
            >
              <div className="ls-fusion-section-head">
                <h2 className="ls-fusion-section-title">
                  <DesktopIcon name="fusion-mode" size="sm" />
                  <span>{copy.fusionActiveWindowsTitle}</span>
                  <Badge variant="count" tone="neutral">
                    {totalWindowCount}
                  </Badge>
                </h2>
              </div>

              <div className="ls-fusion-active-list">
                {runningApps.map((app) => {
                  const winCount = Math.max(
                    1,
                    fusion.windowCounts[app.bundle] ?? app.windows ?? 1,
                  );
                  const isBusy = Boolean(fusion.busyBundles[app.bundle]);
                  const iconSrc = fusion.icons[app.bundle]?.src;

                  return (
                    <div key={app.bundle} className="ls-fusion-active-card">
                      <div className="ls-fusion-active-card__info">
                        <FusionAppIcon
                          name={app.name}
                          src={iconSrc}
                          size="sm"
                          showRemoteBadge
                        />
                        <div className="ls-fusion-active-card__text">
                          <span className="ls-fusion-active-card__name">
                            {app.name}
                          </span>
                          <span className="ls-fusion-active-card__sub">
                            <StatusDot tone="ok" size="sm" />
                            <span>{copy.fusionWindowCount(winCount)}</span>
                          </span>
                        </div>
                      </div>

                      <div className="ls-fusion-active-card__actions">
                        <Button
                          size="xs"
                          variant="secondary"
                          loading={isBusy}
                          onClick={() => void handleLaunchOrActivate(app)}
                        >
                          {copy.fusionActivateApp}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => void handleQuit(app, false)}
                        >
                          {copy.fusionQuitApp}
                        </Button>
                        <Menu
                          placement="bottom-end"
                          label={app.name}
                          trigger={
                            <IconButton
                              size="icon-sm"
                              icon="more-horizontal"
                              label={app.name}
                              hideTooltip
                            />
                          }
                        >
                          <MenuItem
                            icon="external-link"
                            onSelect={() => void handleLaunchOrActivate(app)}
                          >
                            {copy.fusionActivateApp}
                          </MenuItem>
                          {app.stubPath || fusion.appsDir ? (
                            <MenuItem
                              icon="folder-open"
                              onSelect={() => handleRevealStub(app)}
                            >
                              {copy.fusionRevealAppStub}
                            </MenuItem>
                          ) : null}
                          <MenuSeparator />
                          <MenuItem
                            icon="close"
                            onSelect={() => void handleQuit(app, false)}
                          >
                            {copy.fusionQuitApp}
                          </MenuItem>
                          <MenuItem
                            icon="alert-triangle"
                            destructive
                            onSelect={() => void handleQuit(app, true)}
                          >
                            {copy.fusionForceQuitApp}
                          </MenuItem>
                        </Menu>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {enrichedApps.length > 0 || !fusion.error ? (
            <section
              aria-label={copy.fusionCatalogTitle}
              className="ls-fusion-catalog"
            >
              <div className="ls-fusion-tabs-bar">
                <Tabs
                  value={category}
                  onValueChange={handleCategoryChange}
                  variant="underline"
                >
                  <TabList label={copy.fusionCategoriesLabel}>
                    {visibleCategories.map((catKey) => (
                      <Tab
                        key={catKey}
                        value={catKey}
                        count={
                          enrichedApps.length > 0 &&
                          (catKey === "all" || catKey === "running")
                            ? categoryCounts[catKey]
                            : undefined
                        }
                      >
                        {copy.categories[catKey]}
                      </Tab>
                    ))}
                  </TabList>
                </Tabs>
                <span className="ls-fusion-section-meta">
                  {enrichedApps.length === 0
                    ? isStarting || fusion.hubRunning || (online && !manuallyPaused)
                      ? copy.fusionSyncingCatalog
                      : ""
                    : !isConnected
                      ? copy.fusionOfflineCatalogHint
                      : copy.fusionAppsCount(filteredApps.length)}
                </span>
              </div>

              {enrichedApps.length === 0 ? (
                !online && !isStarting && !fusion.hubRunning && !isConnected ? (
                  <EmptyState
                    compact
                    icon="fusion-mode"
                    title={copy.screenOfflineTitle}
                    description={copy.screenOfflineDesc}
                  />
                ) : manuallyPaused &&
                  !isStarting &&
                  !fusion.hubRunning &&
                  !isConnected ? (
                  <EmptyState
                    compact
                    icon="fusion-mode"
                    title={copy.fusionMode}
                    description={copy.fusionPausedHint}
                    actions={
                      <Button
                        size="sm"
                        variant="primary"
                        leadingIcon="fusion-mode"
                        onClick={() => void handleStartFusion()}
                      >
                        {copy.fusionStart}
                      </Button>
                    }
                  />
                ) : (
                  <div
                    ref={gridRef}
                    aria-busy="true"
                    data-fusion-skeleton="true"
                    className="ls-fusion-grid"
                  >
                    {SKELETON_SLOTS.map((slot) => (
                      <div
                        key={slot}
                        aria-hidden="true"
                        data-skeleton-card="true"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 10,
                          padding: "16px 12px 14px",
                          borderRadius: 12,
                          border: "var(--ls-hairline, 1px) solid var(--ls-border)",
                          background: "var(--ls-surface-2, transparent)",
                        }}
                      >
                        <span
                          style={{
                            inlineSize: 48,
                            blockSize: 48,
                            borderRadius: "22.5%",
                            background: "var(--ls-control-bg)",
                            border: "var(--ls-hairline, 1px) solid var(--ls-border)",
                          }}
                        />
                        <span
                          style={{
                            inlineSize: slot % 2 === 0 ? 64 : 52,
                            blockSize: 10,
                            borderRadius: 4,
                            background: "var(--ls-border)",
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )
              ) : filteredApps.length === 0 ? (
                <EmptyState
                  compact
                  icon="search"
                  title={copy.fusionNoMatchingAppsTitle}
                  description={copy.fusionNoMatchingAppsDesc}
                />
              ) : (
                <div ref={gridRef} className="ls-fusion-grid">
                  {filteredApps.map((app) => {
                    const isRunning = runningSet.has(app.bundle);
                    const winCount =
                      fusion.windowCounts[app.bundle] ?? app.windows ?? 0;
                    const isBusy = Boolean(fusion.busyBundles[app.bundle]);
                    const iconSrc = fusion.icons[app.bundle]?.src;
                    const canRevealStub = Boolean(app.stubPath || fusion.appsDir);

                    return (
                      <ContextMenu
                        key={app.bundle}
                        label={app.name}
                        nativeItems={() => [
                          {
                            id: "launch",
                            label: isRunning
                              ? copy.fusionActivateApp
                              : copy.fusionLaunchApp,
                          },
                          ...(canRevealStub
                            ? [
                                {
                                  id: "reveal",
                                  label: copy.fusionRevealAppStub,
                                },
                              ]
                            : []),
                          ...(isRunning
                            ? [
                                { type: "separator" as const },
                                { id: "quit", label: copy.fusionQuitApp },
                                {
                                  id: "force-quit",
                                  label: copy.fusionForceQuitApp,
                                },
                              ]
                            : []),
                        ]}
                        onNativeSelect={(actionId) => {
                          if (actionId === "launch") {
                            void handleLaunchOrActivate(app);
                          } else if (actionId === "reveal") {
                            handleRevealStub(app);
                          } else if (actionId === "quit") {
                            void handleQuit(app, false);
                          } else if (actionId === "force-quit") {
                            void handleQuit(app, true);
                          }
                        }}
                        menu={
                          <>
                            <MenuItem
                              icon={isRunning ? "external-link" : "play"}
                              onSelect={() => void handleLaunchOrActivate(app)}
                            >
                              {isRunning
                                ? copy.fusionActivateApp
                                : copy.fusionLaunchApp}
                            </MenuItem>
                            {canRevealStub ? (
                              <MenuItem
                                icon="folder-open"
                                onSelect={() => handleRevealStub(app)}
                              >
                                {copy.fusionRevealAppStub}
                              </MenuItem>
                            ) : null}
                            {isRunning ? (
                              <>
                                <MenuSeparator />
                                <MenuItem
                                  icon="close"
                                  onSelect={() => void handleQuit(app, false)}
                                >
                                  {copy.fusionQuitApp}
                                </MenuItem>
                                <MenuItem
                                  icon="alert-triangle"
                                  destructive
                                  onSelect={() => void handleQuit(app, true)}
                                >
                                  {copy.fusionForceQuitApp}
                                </MenuItem>
                              </>
                            ) : null}
                          </>
                        }
                      >
                        <div
                          data-running={isRunning ? "true" : undefined}
                          data-bundle={app.bundle}
                          className="ls-fusion-app-card"
                        >
                          <button
                            type="button"
                            disabled={isBusy}
                            className="ls-fusion-app-card__launch"
                            onClick={() => void handleLaunchOrActivate(app)}
                          >
                            <FusionAppIcon
                              name={app.name}
                              src={iconSrc}
                              showRemoteBadge={isConnected}
                            />
                            <span className="ls-fusion-app-card__name">
                              {app.name}
                            </span>
                            <span className="ls-fusion-app-card__meta">
                              {isBusy ? (
                                <DesktopIcon name="spinner" size="xs" />
                              ) : isRunning ? (
                                <span className="ls-fusion-app-card__running-pill">
                                  <StatusDot tone="ok" size="sm" />
                                  <span>
                                    {winCount > 0
                                      ? copy.fusionWindowCount(winCount)
                                      : copy.fusionRunningLabel}
                                  </span>
                                </span>
                              ) : null}
                            </span>
                          </button>

                          <div className="ls-fusion-app-card__quick">
                            <Menu
                              placement="bottom-end"
                              label={app.name}
                              trigger={
                                <IconButton
                                  size="icon-sm"
                                  icon="more-horizontal"
                                  label={app.name}
                                  hideTooltip
                                />
                              }
                            >
                              <MenuItem
                                icon={isRunning ? "external-link" : "play"}
                                onSelect={() =>
                                  void handleLaunchOrActivate(app)
                                }
                              >
                                {isRunning
                                  ? copy.fusionActivateApp
                                  : copy.fusionLaunchApp}
                              </MenuItem>
                              {canRevealStub ? (
                                <MenuItem
                                  icon="folder-open"
                                  onSelect={() => handleRevealStub(app)}
                                >
                                  {copy.fusionRevealAppStub}
                                </MenuItem>
                              ) : null}
                              {isRunning ? (
                                <>
                                  <MenuSeparator />
                                  <MenuItem
                                    icon="close"
                                    onSelect={() => void handleQuit(app, false)}
                                  >
                                    {copy.fusionQuitApp}
                                  </MenuItem>
                                  <MenuItem
                                    icon="alert-triangle"
                                    destructive
                                    onSelect={() => void handleQuit(app, true)}
                                  >
                                    {copy.fusionForceQuitApp}
                                  </MenuItem>
                                </>
                              ) : null}
                            </Menu>
                          </div>
                        </div>
                      </ContextMenu>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}
