import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { ClientStore, Locale } from "@linkshell/client-core";
import { createStore } from "zustand/vanilla";
import {
  DESKTOP_LOCAL,
  getActiveDesktopPlatform,
  isElectronRuntime,
  type DesktopPlatform,
} from "../../bridge/desktop-bridge";
import type { SessionSummary } from "@linkshell/wire";
import {
  computerName,
  computerNames,
  connectAndStartComputerFusion,
  dateLocaleTag,
  engine,
  evaluateFusionCapability,
  fusionCapabilityMessage,
  reportActionError,
  routerStore,
  sessionGroup,
  thisComputerLabel,
  translateDesktop,
  useFusionState,
  useI18n,
  waitingLabel,
  type Computer,
  type ComputerSessionInput,
  type Connection,
  type FusionCapabilityEnv,
  type SessionActionDialogs,
  type WorkspaceRoute,
} from "../../core";
import { DesktopIcon, type DesktopIconName } from "../../icons";
import {
  Button,
  IconButton,
  StatusDot,
  Tooltip,
  type BadgeTone,
  type DialogsController,
} from "../../primitives";

export function asSessionActionDialogs(dialogs: DialogsController): SessionActionDialogs {
  return {
    confirm: (message, options) => dialogs.confirm(message, options),
    prompt: (title, initialValue, submitLabel) => dialogs.prompt(title, initialValue, submitLabel),
    choose: <T extends string>(
      message: string,
      choices: { value: T; label: string; destructive?: boolean }[],
    ) => dialogs.choose(message, choices) as Promise<T | null>,
  };
}

export function currentFusionCapabilityEnv(
  platformOverride?: DesktopPlatform,
): FusionCapabilityEnv {
  return {
    electron: isElectronRuntime(),
    localPlatform: platformOverride ?? getActiveDesktopPlatform(),
  };
}

type FallbackClientSnapshot = ReturnType<ClientStore["getState"]>;

const EMPTY_CLIENT_STORE = createStore<FallbackClientSnapshot>(
  () =>
    ({
      status: "idle",
      sessions: {},
      sessionsLoaded: false,
      notices: {},
      interactions: {},
      projects: [],
      views: {},
      open: {},
      ready: {},
      loadingEarlier: {},
      subagents: {},
      workflows: {},
      tasks: {},
      subagentViews: {},
      outbox: {},
      queueing: {},
      promptProgress: {},
      sides: {},
      archivedNextBefore: undefined,
      archivedNextBeforeId: undefined,
    }) as unknown as FallbackClientSnapshot,
);

/**
 * Safely subscribes to an optional `Connection`'s Zustand store without violating Rules of Hooks
 * when the selected computer connection is null or transitioning.
 */
export function useConnectionStore<T>(
  connection: Connection | undefined,
  selector: (state: FallbackClientSnapshot) => T,
): T {
  const store = (connection?.store ?? EMPTY_CLIENT_STORE) as ClientStore;
  return useStore(store, selector);
}

interface RetainedMetadataEntry {
  connection: Connection;
  release: () => void;
  unsub: () => void;
}

function releaseAllRetained(mapRef: Map<string, RetainedMetadataEntry>): void {
  for (const entry of mapRef.values()) {
    entry.unsub();
    entry.release();
  }
  mapRef.clear();
}

/**
 * Retains metadata-only connections for background computers when cross-computer scope is active.
 * Keeps a persistent `Map<string, RetainedMetadataEntry>` across renders so presence/naming/local
 * `computers` array updates NEVER drop `ComputerConnections` refcounts to 0 mid-flight (#74),
 * while subscribing live to every retained connection's `store` (plus `activeConnection`).
 */
export function useRetainedMetadataConnections(
  computers: readonly Computer[],
  enabled: boolean,
): Record<string, Connection> {
  const activeConnection = useStore(engine.state, (s) => s.connection);
  const retainedByKeyRef = useRef<Map<string, RetainedMetadataEntry>>(new Map());
  const mountedRef = useRef(true);
  const [map, setMap] = useState<Record<string, Connection>>({});

  useEffect(() => {
    mountedRef.current = true;
    const retainedMap = retainedByKeyRef.current;
    return () => {
      mountedRef.current = false;
      releaseAllRetained(retainedMap);
    };
  }, []);

  useEffect(() => {
    const retainedMap = retainedByKeyRef.current;
    if (!enabled || computers.length === 0) {
      if (retainedMap.size > 0) {
        releaseAllRetained(retainedMap);
      }
      setMap({});
      return;
    }

    const desiredByKey = new Map<string, Computer>();
    for (const computer of computers) {
      if (computer.machine.online || computer.key === DESKTOP_LOCAL) {
        desiredByKey.set(computer.key, computer);
      }
    }

    // 1. Release + unsub only keys that went offline or were forgotten
    for (const [key, existing] of retainedMap.entries()) {
      if (!desiredByKey.has(key)) {
        existing.unsub();
        existing.release();
        retainedMap.delete(key);
      }
    }

    // 2. Acquire + subscribe only newly added online keys
    for (const [key, computer] of desiredByKey.entries()) {
      if (retainedMap.has(key)) continue;
      try {
        const retained = engine.retainComputer(computer, { metadataOnly: true });
        const unsub = retained.connection.store.subscribe((state, prev) => {
          if (!mountedRef.current) return;
          if (
            state.status !== prev.status ||
            state.sessionsLoaded !== prev.sessionsLoaded ||
            state.sessions !== prev.sessions ||
            state.projects !== prev.projects ||
            state.archivedNextBefore !== prev.archivedNextBefore ||
            state.archivedNextBeforeId !== prev.archivedNextBeforeId
          ) {
            setMap((curr) => ({ ...curr }));
          }
        });
        retainedMap.set(key, {
          connection: retained.connection,
          release: retained.release,
          unsub,
        });
      } catch {
        // Engine may still be booting its identity in early lifecycle or standalone tests.
      }
    }

    const next: Record<string, Connection> = {};
    for (const [key, entry] of retainedMap.entries()) {
      next[key] = entry.connection;
    }
    if (activeConnection && !next[activeConnection.computer.key]) {
      next[activeConnection.computer.key] = activeConnection;
    }
    setMap(next);
  }, [computers, enabled, activeConnection]);

  // Also subscribe to activeConnection when it is not already tracked in retainedByKeyRef
  useEffect(() => {
    if (!enabled || !activeConnection) return undefined;
    const retainedEntry = retainedByKeyRef.current.get(activeConnection.computer.key);
    if (retainedEntry && retainedEntry.connection === activeConnection) {
      return undefined;
    }
    return activeConnection.store.subscribe((state, prev) => {
      if (!mountedRef.current) return;
      if (
        state.status !== prev.status ||
        state.sessionsLoaded !== prev.sessionsLoaded ||
        state.sessions !== prev.sessions ||
        state.projects !== prev.projects ||
        state.archivedNextBefore !== prev.archivedNextBefore ||
        state.archivedNextBeforeId !== prev.archivedNextBeforeId
      ) {
        setMap((curr) => ({
          ...curr,
          [activeConnection.computer.key]: activeConnection,
        }));
      }
    });
  }, [enabled, activeConnection]);

  return map;
}

/**
 * Switches the selected computer AND synchronizes any computer-pinned active route (#73 C.1)
 * so switching back to `本机` (or another computer) from `new-session`, `session`, `screen`,
 * `fusion`, or standalone tool routes immediately updates the workspace without snapping back.
 */
export function switchToComputer(computer: Computer): void {
  engine.select(computer);
  const route = routerStore.getState().activeRoute;
  if (route.kind === "new-session") {
    if ((route.computerKey ?? DESKTOP_LOCAL) !== computer.key) {
      routerStore.getState().openNewSession(computer.key);
    }
    return;
  }
  if (
    (route.kind === "session" ||
      route.kind === "screen" ||
      route.kind === "fusion" ||
      route.kind === "terminals" ||
      route.kind === "files" ||
      route.kind === "ports" ||
      route.kind === "worktrees") &&
    route.computerKey !== computer.key
  ) {
    routerStore.getState().navigate({ kind: "home" });
  }
}

/** Opens a session on any computer, selecting that computer first so every pane agrees on it. */
export function openSessionOnComputer(computerKey: string, sessionId: string): void {
  const computer = engine.computerForKey(computerKey);
  if (computer && computer.key !== engine.state.getState().connection?.computer.key) {
    engine.select(computer);
  }
  routerStore.getState().openSession(computerKey, sessionId);
}

/**
 * History entries can outlive what they point at. Only what we can actually know is rejected:
 * a computer that is gone, or a session missing from a computer whose list has loaded.
 */
export function isRouteStillValid(route: WorkspaceRoute): boolean {
  const computerKey = "computerKey" in route ? route.computerKey : undefined;
  if (!computerKey) return true;
  const state = engine.state.getState();
  if (
    computerKey !== DESKTOP_LOCAL &&
    state.computers.length > 0 &&
    !engine.computerForKey(computerKey)
  ) {
    return false;
  }
  if (route.kind === "session") {
    const connection = state.connection;
    if (connection && connection.computer.key === computerKey) {
      const client = connection.store.getState();
      if (client.sessionsLoaded && !client.sessions[route.sessionId]) return false;
    }
  }
  return true;
}

export interface SidebarSessionRef {
  computerKey: string;
  sessionId: string;
}

/**
 * The sidebar's visible session order, read from the docked sidebar so ⌘1…9 and ⇧⌘[ / ] follow
 * exactly what the user sees (collapsed groups are `inert` and skipped; pinned duplicates collapse).
 */
export function visibleSidebarSessions(root: ParentNode = document): SidebarSessionRef[] {
  const rows = root.querySelectorAll<HTMLElement>(
    ".desktop-sidebar .tree-session[data-row-session-id]",
  );
  const seen = new Set<string>();
  const result: SidebarSessionRef[] = [];
  for (const row of rows) {
    if (row.closest("[inert]")) continue;
    const sessionId = row.dataset.rowSessionId;
    const computerKey = row.dataset.computerKey;
    if (!sessionId || !computerKey) continue;
    const id = `${computerKey}\n${sessionId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ computerKey, sessionId });
  }
  return result;
}

/** Reports a failed user action through the shell's notice host, in words rather than RPC codes. */
export function reportShellError(error: unknown, locale?: Locale): void {
  reportActionError(error, locale);
}

/** Re-renders once a minute so relative times ("3 分钟前") do not freeze. */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  return tick;
}

export type SessionActivity =
  | { kind: "waiting"; label: string }
  | { kind: "running"; label: string }
  | { kind: "danger"; label: string }
  | undefined;

/** One source for the waiting / running indicator, so sidebar rows and the home hub never disagree. */
export function sessionActivity(session: SessionSummary, locale: Locale): SessionActivity {
  const group = sessionGroup(session);
  if (group === "waiting") return { kind: "waiting", label: waitingLabel(session, locale) };
  if (group === "running") {
    return { kind: "running", label: translateDesktop(locale, "desktop.shell.running") };
  }
  // A session that stopped on an error is the third thing worth a colour in a list.
  if (session.state === "error") {
    return { kind: "danger", label: translateDesktop(locale, "desktop.shell.sessionFailed") };
  }
  return undefined;
}

export type SessionListState = "ready" | "loading" | "offline";

/**
 * What an empty session list actually means: still connecting, a computer that is away, or truly
 * nothing yet. Without this the sidebar claims "no sessions" while it is merely connecting.
 */
export function sessionListState(
  computer: Computer | undefined,
  status: string,
  sessionsLoaded: boolean,
): SessionListState {
  if (sessionsLoaded) return "ready";
  if (computer && computer.key !== DESKTOP_LOCAL && !computer.machine.online) return "offline";
  if (status === "stopped") return "offline";
  return "loading";
}

export function sessionRecency(session: SessionSummary): number {
  return session.updatedAt ?? session.createdAt;
}

export function buildComputerSessionInputs(
  computers: readonly Computer[],
  activeConnection: Connection | undefined,
  retainedMap: Record<string, Connection>,
  names: Record<string, string>,
  locale: Locale,
): ComputerSessionInput[] {
  return computers.map((comp) => {
    const conn =
      comp.key === activeConnection?.computer.key
        ? activeConnection
        : retainedMap[comp.key];
    const state = conn?.store.getState();
    const isLocal = comp.key === DESKTOP_LOCAL;
    const online = Boolean(
      comp.machine.online || isLocal || state?.status === "online",
    );
    const loaded = Boolean(state?.sessionsLoaded);
    return {
      key: comp.key,
      isLocal,
      online,
      loaded,
      orderLabel: displayComputerName(comp, names, locale),
      projects: state?.projects ?? [],
      sessions: state ? Object.values(state.sessions) : [],
    };
  });
}

export function isLocalComputer(computer: Computer | undefined): boolean {
  return Boolean(computer && computer.key === DESKTOP_LOCAL);
}

export function computerPlatformIcon(platform?: string): DesktopIconName {
  if (!platform) return "computer-pc";
  const lower = platform.toLowerCase();
  if (lower.includes("darwin") || lower.includes("mac")) return "computer-mac";
  if (lower.includes("win")) return "computer-pc";
  if (lower.includes("linux")) return "computer-linux";
  return "computer-pc";
}

export function formatPlatformLabel(platform?: string): string {
  if (!platform) return "";
  const lower = platform.trim().toLowerCase();
  if (!lower || lower === "unknown") return "";
  if (lower.includes("darwin") || lower.includes("mac")) return "macOS";
  if (lower.includes("win")) return "Windows";
  if (lower.includes("linux")) return "Linux";
  return platform;
}

export function shortenHomePath(pathValue: string): string {
  if (!pathValue) return "";
  const unixMatch = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(pathValue);
  if (unixMatch) {
    return `~${unixMatch[1] ?? ""}`;
  }
  const winMatch = /^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/.exec(pathValue);
  if (winMatch) {
    return `~${winMatch[1] ?? ""}`;
  }
  return pathValue;
}

export function relativeSubdirLabel(projectRoot: string, cwd: string): string | undefined {
  const cleanRoot = projectRoot.replace(/[\\/]+$/, "");
  const cleanCwd = cwd.replace(/[\\/]+$/, "");
  if (!cleanCwd || cleanCwd === cleanRoot) return undefined;
  if (cleanRoot && (cleanCwd.startsWith(`${cleanRoot}/`) || cleanCwd.startsWith(`${cleanRoot}\\`))) {
    return cleanCwd.slice(cleanRoot.length + 1);
  }
  return folderBasename(cleanCwd);
}

export function formatSessionCountLabel(count: number, locale: Locale = "zh"): string {
  return count === 1
    ? translateDesktop(locale, "desktop.shell.sessionCountOne")
    : translateDesktop(locale, "desktop.shell.sessionCount", { count });
}

export function formatProjectCountLabel(count: number, locale: Locale = "zh"): string {
  return count === 1
    ? translateDesktop(locale, "desktop.shell.projectCountOne")
    : translateDesktop(locale, "desktop.shell.projectCount", { count });
}

export function displayComputerName(
  computer: Computer | undefined,
  names: Record<string, string>,
  locale: Locale,
): string {
  if (!computer) return thisComputerLabel(locale);
  if (computer.key === DESKTOP_LOCAL) {
    const custom = computerName(computer, names);
    if (custom && custom !== "本机" && custom !== "This Mac" && custom !== "This PC") {
      return custom;
    }
    return thisComputerLabel(locale);
  }
  return computerName(computer, names);
}

export interface RouteBadgeDescriptor {
  label: string;
  icon: DesktopIconName;
  tone: BadgeTone;
}

export function connectionRouteBadge(
  computer: Computer | undefined,
  directState?: string,
  locale: Locale = "zh",
): RouteBadgeDescriptor {
  if (!computer || computer.key === DESKTOP_LOCAL) {
    return {
      label: translateDesktop(locale, "desktop.shell.routeLocal"),
      icon: "host-daemon",
      tone: "neutral",
    };
  }
  if (directState === "connected" || computer.gateway === "direct" || computer.gateway.startsWith("ws://127.")) {
    return {
      label: translateDesktop(locale, "desktop.shell.routeDirect"),
      icon: "direct-p2p",
      tone: "ok",
    };
  }
  return {
    label: translateDesktop(locale, "desktop.shell.routeRelay"),
    icon: "gateway-relay",
    tone: "neutral",
  };
}

export function formatBytesCompact(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${Math.round(mb)} MB`;
}

export function formatRelativeTimestamp(timestamp: number | undefined, locale: Locale = "zh"): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return translateDesktop(locale, "desktop.shell.justNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return translateDesktop(locale, "desktop.shell.minutesAgo", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return translateDesktop(locale, "desktop.shell.hoursAgo", { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return translateDesktop(locale, "desktop.shell.daysAgo", { count: diffDay });
  return new Date(timestamp).toLocaleDateString(dateLocaleTag(locale));
}

export function folderBasename(pathValue: string): string {
  const trimmed = pathValue.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

export interface ShellRenderSlots {
  renderSessionWorkspace?: (props: { computerKey: string; sessionId: string }) => ReactNode;
  renderNewSessionWorkspace?: (props: { computerKey: string; initialCwd?: string }) => ReactNode;
  renderSessionHeaderActions?: (props: { computerKey: string; sessionId: string }) => ReactNode;
  renderInspector?: (props: { computerKey: string; sessionId?: string; cwd?: string }) => ReactNode;
  renderBottomTerminal?: (props: {
    computerKey: string;
    sessionId?: string;
    cwd?: string;
  }) => ReactNode;
  renderStandaloneTool?: (props: {
    mode: "terminals" | "files" | "ports" | "worktrees";
    computerKey: string;
  }) => ReactNode;
  renderFusionWorkspace?: (props: { computerKey: string }) => ReactNode;
  renderRemoteScreenWorkspace?: (props: { computerKey: string }) => ReactNode;
  renderFusionStatusBadge?: (props: { computerKey: string; onClick?: () => void }) => ReactNode;
  renderFusionQuickTrigger?: (props: { computerKey: string; compact?: boolean }) => ReactNode;
  onOpenLocalPairingQr?: () => void;
}

/**
 * Default shell-level Fusion Status Badge used when `renderFusionStatusBadge` slot is not injected
 * (e.g. standalone shell unit tests) — reads live `fusionStore`.
 */
export function DefaultFusionStatusBadge({
  computerKey,
  onClick,
}: {
  computerKey: string;
  onClick?: () => void;
}) {
  const state = useFusionState(computerKey);
  const { t } = useI18n();
  if (state.phase === "idle" && !state.connected) return null;

  const windowTotal = Object.values(state.windowCounts).reduce((sum, count) => sum + count, 0);
  const handleClick = onClick ?? (() => routerStore.getState().openFusion(computerKey));

  return (
    <button
      type="button"
      data-phase={state.phase}
      className="shell-fusion-badge"
      onClick={handleClick}
    >
      <StatusDot
        tone={
          state.phase === "connected"
            ? "ok"
            : state.phase === "error"
              ? "danger"
              : "running"
        }
        size="sm"
      />
      <DesktopIcon name="fusion-mode" size="xs" />
      <span>
        {state.phase === "starting"
          ? t("desktop.fusion.starting")
          : state.phase === "error"
            ? t("desktop.fusion.title")
            : windowTotal > 0
              ? `${t("desktop.fusion.title")} · ${t("desktop.fusion.windowCount", { count: windowTotal })}`
              : t("desktop.fusion.title")}
      </span>
    </button>
  );
}

/**
 * Default shell-level Fusion Quick Trigger used when `renderFusionQuickTrigger` slot is not injected.
 */
export function DefaultFusionQuickTrigger({
  computerKey,
  compact = false,
}: {
  computerKey: string;
  compact?: boolean;
}) {
  const { locale, t } = useI18n();
  const computer = useStore(engine.state, (s) =>
    s.computers.find((entry) => entry.key === computerKey),
  );
  const fusion = useFusionState(computerKey);
  const capability = evaluateFusionCapability(
    computerKey,
    computer?.machine.platform,
    currentFusionCapabilityEnv(),
  );
  if (
    !capability.supported &&
    (capability.reason === "local-computer" ||
      capability.reason === "not-electron" ||
      capability.reason === "windows-client")
  ) {
    return null;
  }
  const disabledReason = !capability.supported
    ? fusionCapabilityMessage(capability.reason, locale)
    : !computer?.machine.online
      ? t("desktop.fusion.offlineHost", {
          name: displayComputerName(computer, computerNames.store.getState(), locale),
        })
      : undefined;

  const handleTrigger = () => {
    routerStore.getState().openFusion(computerKey);
    if (fusion.phase === "idle") {
      void connectAndStartComputerFusion(computerKey);
    }
  };

  if (compact) {
    return (
      <IconButton
        variant={fusion.connected ? "subtle" : "ghost"}
        aria-pressed={fusion.connected}
        icon="fusion-mode"
        loading={fusion.phase === "starting"}
        disabled={Boolean(disabledReason)}
        disabledReason={disabledReason}
        label={t("desktop.fusion.title")}
        tooltip={disabledReason ?? t("desktop.fusion.start")}
        onClick={handleTrigger}
      />
    );
  }

  return (
    <Tooltip content={disabledReason} wrapDisabled={Boolean(disabledReason)}>
      <Button
        size="sm"
        variant={fusion.connected ? "subtle" : "secondary"}
        leadingIcon="fusion-mode"
        loading={fusion.phase === "starting"}
        disabled={Boolean(disabledReason)}
        onClick={handleTrigger}
      >
        {t("desktop.fusion.title")}
      </Button>
    </Tooltip>
  );
}
