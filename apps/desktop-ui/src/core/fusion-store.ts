import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { HostLink, HostStream, HostStreams, Locale } from "@linkshell/client-core";
import {
  DESKTOP_COMMAND_EVENT,
  DESKTOP_FUSION_TUNNEL_EVENT,
  DESKTOP_LOCAL,
  desktopInvoke,
  getActiveDesktopPlatform,
  isElectronRuntime,
  postDesktopMessage,
  type DesktopPlatform,
} from "../bridge/desktop-bridge";
import { computerName, computerNames, type Computer } from "./connections";
import { engine } from "./engine";
import { getDesktopLocale, translateDesktop } from "./i18n";
import { reportDesktopError } from "./storage";

export const FUSION_ICON_BATCH_SIZE = 48;
export const FUSION_TUNNEL_BUFFER_LIMIT = 256;
export const FUSION_START_GRACE_MS = 15_000;
export const FUSION_FAST_POLL_MS = 450;
export const FUSION_STEADY_POLL_MS = 2_000;

export type FusionUnsupportedReason =
  | "not-electron"
  | "windows-client"
  | "local-computer"
  | "non-macos-remote";

export type FusionCapability =
  | { supported: true; reason: "ok" }
  | { supported: false; reason: FusionUnsupportedReason };

export interface FusionCapabilityEnv {
  electron?: boolean;
  localPlatform?: DesktopPlatform;
}

export function evaluateFusionCapability(
  computerKey: string | undefined,
  remotePlatform: string | undefined,
  env?: FusionCapabilityEnv,
): FusionCapability {
  const electron = env?.electron ?? isElectronRuntime();
  const localPlatform = env?.localPlatform ?? getActiveDesktopPlatform();
  if (!electron) return { supported: false, reason: "not-electron" };
  if (localPlatform === "windows") return { supported: false, reason: "windows-client" };
  if (localPlatform !== "macos") return { supported: false, reason: "not-electron" };
  if (!computerKey || computerKey === DESKTOP_LOCAL) {
    return { supported: false, reason: "local-computer" };
  }
  if (remotePlatform !== "darwin" && remotePlatform !== "macos") {
    return { supported: false, reason: "non-macos-remote" };
  }
  return { supported: true, reason: "ok" };
}

export function canUseFusionMode(
  computerKey: string | undefined,
  remotePlatform?: string,
  env?: FusionCapabilityEnv,
): boolean {
  return evaluateFusionCapability(computerKey, remotePlatform, env).supported;
}

export function fusionCapabilityMessage(
  reason: FusionUnsupportedReason,
  locale: Locale = getDesktopLocale(),
): string {
  switch (reason) {
    case "windows-client":
      return translateDesktop(locale, "desktop.fusion.reasonWindows");
    case "local-computer":
      return translateDesktop(locale, "desktop.fusion.reasonLocal");
    case "non-macos-remote":
      return translateDesktop(locale, "desktop.fusion.reasonNonMacRemote");
    case "not-electron":
      return translateDesktop(locale, "desktop.fusion.reasonNotElectron");
  }
}

export type FusionStartReply =
  | { mode: "direct"; host: string; port: number }
  | { mode: "tunnel"; tunnelId: string; port: number };

export interface FusionRemoteApp {
  bundle: string;
  name: string;
  path?: string;
  version?: string;
  running?: boolean;
  windows?: number;
}

export interface FusionIconEntry {
  src: string;
  badged: boolean;
}

/** A problem the hub reports with a specific remedy (see `FusionAlertBanner`). */
export interface FusionAlert {
  kind:
    | "accessibility"
    | "recording"
    | "locked"
    | "webrtc"
    | "launch"
    | "stub"
    | "disconnected"
    | (string & {});
  message: string;
  subject?: string;
  bundle?: string;
  at?: number;
}

export interface FusionExitInfo {
  reason?: string;
  message?: string;
  at?: number;
  wasConnected?: boolean;
}

export interface FusionHubSnapshot {
  hubRunning: boolean;
  connected: boolean;
  rttMs?: number;
  hostLabel: string;
  hostSlug: string;
  appsDir: string;
  statusText?: string;
  activeBundles: string[];
  windowCounts: Record<string, number>;
  iconBundles: string[];
  apps: FusionRemoteApp[];
  alerts?: FusionAlert[];
  lastExit?: FusionExitInfo;
}

export interface FusionComputerState {
  phase: "idle" | "starting" | "connected" | "reconnecting" | "stopping" | "error";
  mode?: "direct" | "tunnel";
  tunnelId?: string;
  remoteHost?: string;
  localPort?: number;
  hubRunning: boolean;
  connected: boolean;
  rttMs?: number;
  hostLabel: string;
  hostSlug: string;
  appsDir: string;
  statusText?: string;
  activeBundles: string[];
  windowCounts: Record<string, number>;
  apps: FusionRemoteApp[];
  icons: Record<string, FusionIconEntry>;
  busyBundles: Record<string, boolean>;
  error?: string;
  updatedAt?: number;
  /** The user pressed Disconnect: nothing restarts Fusion until they start it again. */
  paused?: boolean;
  alerts?: FusionAlert[];
  lastExit?: FusionExitInfo;
  /** Automatic reconnects since the hub last dropped (resets once connected). */
  reconnectAttempt?: number;
  reconnectAt?: number;
}

export interface FusionStoreState {
  byComputer: Record<string, FusionComputerState>;
}

const EMPTY_FUSION_STATE: FusionComputerState = {
  phase: "idle",
  hubRunning: false,
  connected: false,
  hostLabel: "",
  hostSlug: "",
  appsDir: "",
  activeBundles: [],
  windowCounts: {},
  apps: [],
  icons: {},
  busyBundles: {},
};

export const FUSION_MAX_RECONNECTS = 5;

/** 1 s, 2 s, 4 s, 8 s, 16 s: a blip recovers fast, a dead remote does not spin. */
export function fusionReconnectDelay(attempt: number): number {
  return 1_000 * 2 ** Math.max(0, Math.min(attempt - 1, 4));
}

interface TunnelEventDetail {
  tunnelId?: string;
  connId?: string;
  type?: "open" | "data" | "close";
  data?: string;
}

export function encodeFusionBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function decodeFusionBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface FusionRetained {
  streams: Pick<HostStreams, "open">;
  release(): void;
}

export interface FusionControllerDeps {
  invoke?<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  postMessage?(message: Record<string, unknown>): boolean;
  eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Holds the computer's connection open for as long as a tunnel runs through it. */
  retain?(computerKey: string): FusionRetained | undefined;
  /** Starts Fusion again after the hub dropped (default: `connectAndStartComputerFusion`). */
  restart?(computerKey: string): Promise<void>;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  now?(): number;
}

export interface StartFusionOptions {
  computerKey: string;
  name: string;
  link: Pick<HostLink, "call">;
  streams: Pick<HostStreams, "open">;
  launchBundle?: string;
  releaseConnection?: () => void;
  /** Set by automatic reconnects, so their failures count toward the retry limit. */
  reconnect?: boolean;
}

/**
 * App-lifetime Fusion Mode controller & Zustand state store.
 * Keeps tunnel bridges alive across route transitions, watches running hubs (so a drop is noticed
 * with no Fusion page open) and reconnects with backoff unless the user disconnected.
 */
export function createFusionController(deps: FusionControllerDeps = {}) {
  const invoke = deps.invoke ?? desktopInvoke;
  const postMessage = deps.postMessage ?? postDesktopMessage;
  const getTarget = (): Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined =>
    deps.eventTarget ?? (typeof window !== "undefined" ? window : undefined);
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unschedule = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());
  const retain =
    deps.retain ??
    ((computerKey: string): FusionRetained | undefined => {
      try {
        const computer = engine.computerForKey(computerKey);
        if (!computer) return undefined;
        const retained = engine.retainComputer(computer);
        return { streams: retained.connection.streams, release: retained.release };
      } catch {
        return undefined;
      }
    });

  const store = createStore<FusionStoreState>(() => ({ byComputer: {} }));
  const activeTunnelBridges = new Map<string, { computerKey: string; dispose(): void }>();
  const computerTunnels = new Map<string, string>();
  const loadingIcons = new Set<string>();
  const startingUntil = new Map<string, number>();
  const inFlightStarts = new Map<string, Promise<FusionStartReply>>();
  /** Computers with a hub expected to be running: their drops trigger a reconnect. */
  const expected = new Map<string, string>();
  const watchers = new Map<string, () => void>();
  const reconnectTimers = new Map<string, unknown>();

  const stateOf = (computerKey: string): FusionComputerState =>
    store.getState().byComputer[computerKey] ?? EMPTY_FUSION_STATE;

  const updateComputer = (
    computerKey: string,
    patch:
      | Partial<FusionComputerState>
      | ((prev: FusionComputerState) => Partial<FusionComputerState>),
  ) => {
    store.setState((current) => {
      const prev = current.byComputer[computerKey] ?? EMPTY_FUSION_STATE;
      const resolved = typeof patch === "function" ? patch(prev) : patch;
      return {
        byComputer: {
          ...current.byComputer,
          [computerKey]: { ...prev, ...resolved, updatedAt: Date.now() },
        },
      };
    });
  };

  function disposeComputerTunnel(computerKey: string): void {
    const existingTunnelId = computerTunnels.get(computerKey);
    if (!existingTunnelId) return;
    computerTunnels.delete(computerKey);
    const bridge = activeTunnelBridges.get(existingTunnelId);
    activeTunnelBridges.delete(existingTunnelId);
    bridge?.dispose();
  }

  function attachTunnelBridge(
    computerKey: string,
    tunnelId: string,
    remotePort: number,
    streams: Pick<HostStreams, "open">,
    releaseConnection?: () => void,
  ): void {
    // The same tunnel again (Electron reuses a listening one): its connections are live, keep them.
    const existing = activeTunnelBridges.get(tunnelId);
    if (existing && existing.computerKey === computerKey && computerTunnels.get(computerKey) === tunnelId) {
      releaseConnection?.();
      return;
    }
    disposeComputerTunnel(computerKey);
    activeTunnelBridges.get(tunnelId)?.dispose();

    type ConnEntry = {
      closed: boolean;
      pending: Uint8Array[];
      stream?: HostStream;
    };
    const conns = new Map<string, ConnEntry>();
    const target = getTarget();
    const postClose = (connId: string) =>
      postMessage({ action: "fusionTunnel", tunnelId, connId, type: "close" });

    const listener = (raw: Event) => {
      const detail = ((raw as CustomEvent<TunnelEventDetail>).detail ?? {});
      if (detail.tunnelId !== tunnelId || !detail.connId) return;
      const connId = detail.connId;
      if (detail.type === "open") {
        const entry: ConnEntry = { closed: false, pending: [] };
        conns.set(connId, entry);
        void streams
          .open(remotePort, {
            data(bytes) {
              if (entry.closed) return;
              postMessage({
                action: "fusionTunnel",
                tunnelId,
                connId,
                type: "data",
                data: encodeFusionBase64(bytes),
              });
            },
            closed() {
              if (entry.closed) return;
              entry.closed = true;
              conns.delete(connId);
              postClose(connId);
            },
          })
          .then((stream) => {
            if (entry.closed) {
              stream.close();
              return;
            }
            entry.stream = stream;
            for (const chunk of entry.pending) stream.write(chunk);
            entry.pending.length = 0;
          })
          .catch(() => {
            if (entry.closed) return;
            entry.closed = true;
            conns.delete(connId);
            postClose(connId);
          });
        return;
      }

      const entry = conns.get(connId);
      if (!entry) {
        // Bytes for a connection this bridge never opened: tell main, so FusionLocal sees a close
        // instead of writing into a void forever.
        if (detail.type === "data") postClose(connId);
        return;
      }
      if (entry.closed) return;
      if (detail.type === "data" && typeof detail.data === "string") {
        const bytes = decodeFusionBase64(detail.data);
        if (entry.stream) entry.stream.write(bytes);
        else if (entry.pending.length < FUSION_TUNNEL_BUFFER_LIMIT) {
          entry.pending.push(bytes);
        }
      } else if (detail.type === "close") {
        entry.closed = true;
        conns.delete(connId);
        entry.stream?.close();
      }
    };

    target?.addEventListener(DESKTOP_FUSION_TUNNEL_EVENT, listener);
    let released = false;
    computerTunnels.set(computerKey, tunnelId);
    activeTunnelBridges.set(tunnelId, {
      computerKey,
      dispose() {
        target?.removeEventListener(DESKTOP_FUSION_TUNNEL_EVENT, listener);
        for (const [connId, entry] of conns) {
          if (entry.closed) continue;
          entry.closed = true;
          entry.stream?.close();
          postClose(connId);
        }
        conns.clear();
        if (!released) {
          released = true;
          releaseConnection?.();
        }
      },
    });
  }

  function cancelReconnect(computerKey: string): void {
    const timer = reconnectTimers.get(computerKey);
    if (timer !== undefined) {
      unschedule(timer);
      reconnectTimers.delete(computerKey);
    }
  }

  function exitMessage(state: FusionComputerState, fallback?: string): string {
    // An exit note from an earlier session says nothing about this one.
    const fresh = state.lastExit?.at === undefined || now() - state.lastExit.at < 10 * 60_000;
    return (fresh ? state.lastExit?.message : undefined) || fallback || "与远端 Mac 的融合连接已断开";
  }

  /** The hub dropped (or a start failed) while Fusion was meant to be on. */
  function handleDrop(computerKey: string, reason?: string): void {
    const current = stateOf(computerKey);
    if (current.paused || !expected.has(computerKey)) return;
    const attempt = (current.reconnectAttempt ?? 0) + 1;
    if (attempt > FUSION_MAX_RECONNECTS) {
      expected.delete(computerKey);
      stopWatch(computerKey);
      updateComputer(computerKey, {
        phase: "error",
        hubRunning: false,
        connected: false,
        reconnectAt: undefined,
        error: `融合模式多次重连失败：${exitMessage(current, reason)}`,
      });
      return;
    }
    const delay = fusionReconnectDelay(attempt);
    updateComputer(computerKey, {
      phase: "reconnecting",
      connected: false,
      reconnectAttempt: attempt,
      reconnectAt: now() + delay,
    });
    cancelReconnect(computerKey);
    reconnectTimers.set(
      computerKey,
      schedule(() => {
        reconnectTimers.delete(computerKey);
        if (stateOf(computerKey).paused || !expected.has(computerKey)) return;
        const restart = deps.restart ?? ((key: string) => connectAndStartComputerFusion(key, undefined, { reconnect: true }));
        void restart(computerKey).catch((error: unknown) =>
          handleDrop(computerKey, error instanceof Error ? error.message : String(error)),
        );
      }, delay),
    );
  }

  function stopWatch(computerKey: string): void {
    watchers.get(computerKey)?.();
    watchers.delete(computerKey);
  }

  /** One poller per computer while a hub is expected, independent of any page being open. */
  function ensureWatch(computerKey: string, name: string): void {
    if (watchers.has(computerKey)) return;
    watchers.set(computerKey, pollFusionState(computerKey, name));
  }

  async function startFusion({
    computerKey,
    name,
    link,
    streams,
    launchBundle,
    releaseConnection,
    reconnect = false,
  }: StartFusionOptions): Promise<FusionStartReply> {
    if (!launchBundle) {
      const existing = inFlightStarts.get(computerKey);
      if (existing) {
        releaseConnection?.();
        return existing;
      }
    }

    const run = (async (): Promise<FusionStartReply> => {
      startingUntil.set(computerKey, now() + FUSION_START_GRACE_MS);
      expected.set(computerKey, name);
      cancelReconnect(computerKey);
      updateComputer(computerKey, (prev) => ({
        phase: reconnect ? "reconnecting" : "starting",
        hubRunning: true,
        error: undefined,
        paused: false,
        reconnectAttempt: reconnect ? prev.reconnectAttempt : 0,
        hostLabel: name || prev.hostLabel,
      }));

      let started: { port: number; token: string; hosts: string[] };
      try {
        started = await link.call("fusion.start", {});
      } catch (error) {
        startingUntil.delete(computerKey);
        releaseConnection?.();
        const rawMessage = error instanceof Error ? error.message : String(error);
        const translated = /method not found|fusion\.start|-32601/i.test(rawMessage)
          ? new Error(
              "远端电脑的 LinkShell 版本较旧，请先更新远端 LinkShell 后再开启融合模式",
              { cause: error },
            )
          : error instanceof Error
            ? error
            : new Error(rawMessage);
        if (!reconnect) expected.delete(computerKey);
        updateComputer(computerKey, {
          phase: reconnect ? "reconnecting" : "error",
          hubRunning: false,
          connected: false,
          error: reconnect ? undefined : translated.message,
        });
        throw translated;
      }

      try {
        const reply = await invoke<FusionStartReply>(
          "fusionStart",
          {
            computerKey,
            name,
            port: started.port,
            token: started.token,
            hosts: started.hosts,
            ...(launchBundle ? { launchBundle } : {}),
          },
          20_000,
        );
        startingUntil.set(computerKey, now() + FUSION_START_GRACE_MS);
        if (reply?.mode === "tunnel") {
          // The tunnel runs through this computer's connection: hold it for the tunnel's lifetime,
          // whichever page (or none) started Fusion.
          let bridgeStreams = streams;
          let release = releaseConnection;
          if (!release) {
            const held = retain(computerKey);
            if (held) {
              bridgeStreams = held.streams;
              release = held.release;
            }
          }
          attachTunnelBridge(computerKey, reply.tunnelId, started.port, bridgeStreams, release);
          updateComputer(computerKey, (prev) => ({
            phase: prev.connected ? "connected" : prev.phase === "reconnecting" ? "reconnecting" : "starting",
            mode: "tunnel",
            tunnelId: reply.tunnelId,
            remoteHost: undefined,
            localPort: reply.port,
            hubRunning: true,
            error: undefined,
          }));
        } else {
          disposeComputerTunnel(computerKey);
          releaseConnection?.();
          updateComputer(computerKey, (prev) => ({
            phase: prev.connected ? "connected" : prev.phase === "reconnecting" ? "reconnecting" : "starting",
            mode: "direct",
            tunnelId: undefined,
            remoteHost: reply?.host,
            localPort: reply?.port,
            hubRunning: true,
            error: undefined,
          }));
        }
        ensureWatch(computerKey, name);
        void refreshFusionState(computerKey, name).catch(() => undefined);
        return reply;
      } catch (error) {
        startingUntil.delete(computerKey);
        releaseConnection?.();
        const message = error instanceof Error ? error.message : String(error);
        if (!reconnect) expected.delete(computerKey);
        updateComputer(computerKey, {
          phase: reconnect ? "reconnecting" : "error",
          hubRunning: false,
          connected: false,
          error: reconnect ? undefined : message,
        });
        throw error;
      }
    })();

    if (!launchBundle) {
      inFlightStarts.set(computerKey, run);
      const clearInFlight = () => {
        if (inFlightStarts.get(computerKey) === run) {
          inFlightStarts.delete(computerKey);
        }
      };
      void run.then(clearInFlight, clearInFlight);
    }

    return run;
  }

  async function loadFusionIcons(
    computerKey: string,
    hostSlug: string,
    bundles: readonly string[],
  ): Promise<Record<string, FusionIconEntry>> {
    if (!hostSlug || bundles.length === 0) return {};
    const existing = stateOf(computerKey).icons;
    const missing = bundles.filter((bundle) => {
      const token = `${computerKey}:${hostSlug}:${bundle}`;
      return Boolean(bundle) && !existing[bundle] && !loadingIcons.has(token);
    });
    if (missing.length === 0) return existing;

    const merged: Record<string, FusionIconEntry> = {};
    for (let offset = 0; offset < missing.length; offset += FUSION_ICON_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + FUSION_ICON_BATCH_SIZE);
      for (const bundle of batch) loadingIcons.add(`${computerKey}:${hostSlug}:${bundle}`);
      try {
        const reply = await invoke<{ icons?: Record<string, FusionIconEntry> }>(
          "fusionIcons",
          { computerKey, hostSlug, bundles: batch },
          20_000,
        );
        if (reply?.icons) {
          Object.assign(merged, reply.icons);
          updateComputer(computerKey, (prev) => ({
            icons: { ...prev.icons, ...reply.icons },
          }));
        }
      } finally {
        for (const bundle of batch) {
          loadingIcons.delete(`${computerKey}:${hostSlug}:${bundle}`);
        }
      }
    }
    return { ...stateOf(computerKey).icons, ...merged };
  }

  async function refreshFusionState(
    computerKey: string,
    name: string,
  ): Promise<FusionComputerState> {
    const snapshot = await invoke<FusionHubSnapshot & { running?: boolean }>(
      "fusionState",
      { name, computerKey },
      15_000,
    );
    const inGrace = now() < (startingUntil.get(computerKey) ?? 0);
    const snapshotHubRunning = Boolean(snapshot?.hubRunning ?? snapshot?.running);
    const snapshotConnected = snapshot?.connected === true;
    const incomingApps = Array.isArray(snapshot?.apps) ? snapshot.apps : [];
    if (snapshotConnected) {
      startingUntil.delete(computerKey);
      // A hub found running (e.g. LinkShell restarted while it stayed up) is watched like one we started.
      if (!expected.has(computerKey) && !stateOf(computerKey).paused) expected.set(computerKey, name);
    }
    const before = stateOf(computerKey);
    const dropped =
      expected.has(computerKey) &&
      !before.paused &&
      before.phase !== "stopping" &&
      !snapshotHubRunning &&
      !snapshotConnected &&
      !inGrace &&
      (before.phase === "connected" || before.phase === "starting" || (before.phase === "reconnecting" && !reconnectTimers.has(computerKey)));

    updateComputer(computerKey, (prev) => {
      if (prev.phase === "stopping" && !snapshotConnected) {
        return {};
      }
      const effectiveHubRunning = snapshotHubRunning || snapshotConnected || inGrace;
      const nextPhase: FusionComputerState["phase"] = snapshotConnected
        ? "connected"
        : inGrace
          ? prev.phase === "reconnecting"
            ? "reconnecting"
            : "starting"
          : prev.phase === "reconnecting"
            ? "reconnecting"
            : prev.phase === "error" && !snapshotHubRunning
              ? "error"
              : snapshotHubRunning
                ? "starting"
                : "idle";
      return {
        phase: nextPhase,
        hubRunning: effectiveHubRunning,
        connected: snapshotConnected,
        rttMs: snapshot?.rttMs,
        hostLabel: snapshot?.hostLabel || name || prev.hostLabel,
        hostSlug: snapshot?.hostSlug || prev.hostSlug,
        appsDir: snapshot?.appsDir || prev.appsDir,
        statusText: snapshot?.statusText,
        activeBundles: Array.isArray(snapshot?.activeBundles) ? snapshot.activeBundles : [],
        windowCounts:
          snapshot?.windowCounts && typeof snapshot.windowCounts === "object"
            ? snapshot.windowCounts
            : {},
        apps: incomingApps.length > 0 ? incomingApps : prev.apps,
        alerts: Array.isArray(snapshot?.alerts) ? snapshot.alerts : snapshotHubRunning ? [] : prev.alerts,
        lastExit: snapshot?.lastExit ?? (snapshotHubRunning ? undefined : prev.lastExit),
        ...(snapshotConnected ? { error: undefined, reconnectAttempt: 0, reconnectAt: undefined } : {}),
      };
    });

    if (snapshotHubRunning || snapshotConnected) ensureWatch(computerKey, name);
    if (dropped) handleDrop(computerKey);

    const iconCandidates = [
      ...(Array.isArray(snapshot?.iconBundles) ? snapshot.iconBundles : []),
      ...incomingApps.map((app) => app.bundle),
    ];
    const resolvedSlug = snapshot?.hostSlug || stateOf(computerKey).hostSlug;
    if (resolvedSlug && iconCandidates.length > 0) {
      void loadFusionIcons(computerKey, resolvedSlug, iconCandidates).catch(
        () => undefined,
      );
    }
    return stateOf(computerKey);
  }

  function pollFusionState(
    computerKey: string,
    name: string,
    overrideIntervalMs?: number,
  ): () => void {
    let disposed = false;
    let timer: unknown;

    const resolveDelay = (): number => {
      if (typeof overrideIntervalMs === "number" && overrideIntervalMs > 0) {
        return overrideIntervalMs;
      }
      const cur = stateOf(computerKey);
      const inGrace = now() < (startingUntil.get(computerKey) ?? 0);
      if (
        inGrace ||
        cur.phase === "starting" ||
        ((cur.hubRunning || cur.connected) && cur.apps.length === 0)
      ) {
        return FUSION_FAST_POLL_MS;
      }
      return FUSION_STEADY_POLL_MS;
    };

    const tick = async () => {
      if (disposed) return;
      await refreshFusionState(computerKey, name).catch(() => undefined);
      if (disposed) return;
      timer = schedule(() => {
        void tick();
      }, resolveDelay());
    };

    void tick();
    return () => {
      disposed = true;
      if (timer !== undefined) unschedule(timer);
    };
  }

  async function launchFusionApp(
    computerKey: string,
    bundle: string,
    options?: { hostSlug?: string; name?: string; force?: boolean },
  ): Promise<void> {
    const current = stateOf(computerKey);
    updateComputer(computerKey, (prev) => ({
      busyBundles: { ...prev.busyBundles, [bundle]: true },
      error: undefined,
    }));
    try {
      await invoke(
        "fusionLaunchApp",
        {
          computerKey,
          ...(options?.hostSlug ? { hostSlug: options.hostSlug } : {}),
          ...(options?.name ? { name: options.name } : {}),
          bundle,
          ...(options?.force ? { force: true } : {}),
        },
        20_000,
      );
      if (options?.name || current.hostLabel) {
        await refreshFusionState(computerKey, options?.name ?? current.hostLabel).catch(
          () => undefined,
        );
      }
    } finally {
      updateComputer(computerKey, (prev) => {
        const nextBusy = { ...prev.busyBundles };
        delete nextBusy[bundle];
        return { busyBundles: nextBusy };
      });
    }
  }

  async function quitFusionApp(
    computerKey: string,
    bundle: string,
    options?: { hostSlug?: string; name?: string; force?: boolean },
  ): Promise<void> {
    const current = stateOf(computerKey);
    updateComputer(computerKey, (prev) => ({
      busyBundles: { ...prev.busyBundles, [bundle]: true },
      error: undefined,
    }));
    try {
      await invoke(
        "fusionQuitApp",
        {
          computerKey,
          ...(options?.hostSlug ? { hostSlug: options.hostSlug } : {}),
          ...(options?.name ? { name: options.name } : {}),
          bundle,
          ...(options?.force ? { force: true } : {}),
        },
        20_000,
      );
      if (options?.name || current.hostLabel) {
        await refreshFusionState(computerKey, options?.name ?? current.hostLabel).catch(
          () => undefined,
        );
      }
    } finally {
      updateComputer(computerKey, (prev) => {
        const nextBusy = { ...prev.busyBundles };
        delete nextBusy[bundle];
        return { busyBundles: nextBusy };
      });
    }
  }

  /** The user's Disconnect: sticky until they start Fusion again. */
  async function stopFusion(computerKey: string, name?: string): Promise<void> {
    const current = stateOf(computerKey);
    startingUntil.delete(computerKey);
    inFlightStarts.delete(computerKey);
    expected.delete(computerKey);
    cancelReconnect(computerKey);
    stopWatch(computerKey);
    updateComputer(computerKey, { phase: "stopping", error: undefined, paused: true });
    disposeComputerTunnel(computerKey);
    try {
      await invoke(
        "fusionStop",
        {
          computerKey,
          ...(current.hostSlug ? { hostSlug: current.hostSlug } : {}),
          ...(name ?? current.hostLabel ? { name: name ?? current.hostLabel } : {}),
        },
        20_000,
      );
    } finally {
      startingUntil.delete(computerKey);
      updateComputer(computerKey, {
        phase: "idle",
        mode: undefined,
        tunnelId: undefined,
        hubRunning: false,
        connected: false,
        activeBundles: [],
        windowCounts: {},
        alerts: [],
        reconnectAttempt: 0,
        reconnectAt: undefined,
        paused: true,
      });
    }
  }

  function disposeAll(): void {
    startingUntil.clear();
    inFlightStarts.clear();
    expected.clear();
    for (const key of [...reconnectTimers.keys()]) cancelReconnect(key);
    for (const key of [...watchers.keys()]) stopWatch(key);
    for (const key of [...computerTunnels.keys()]) {
      disposeComputerTunnel(key);
    }
    for (const bridge of activeTunnelBridges.values()) {
      bridge.dispose();
    }
    activeTunnelBridges.clear();
  }

  return {
    store,
    stateOf,
    startFusion,
    refreshFusionState,
    pollFusionState,
    loadFusionIcons,
    launchFusionApp,
    quitFusionApp,
    stopFusion,
    disposeAll,
    isPaused: (computerKey: string) => stateOf(computerKey).paused === true,
  };
}

export const fusionController = createFusionController();
export const fusionStore = fusionController.store;

export const startComputerFusion = fusionController.startFusion;
export const refreshFusionState = fusionController.refreshFusionState;
export const pollFusionState = fusionController.pollFusionState;
export const loadFusionIcons = fusionController.loadFusionIcons;
export const launchFusionApp = fusionController.launchFusionApp;
export const quitFusionApp = fusionController.quitFusionApp;
export const stopComputerFusion = fusionController.stopFusion;
export const isFusionPaused = fusionController.isPaused;

export function useFusionState(computerKey: string | undefined): FusionComputerState {
  return useStore(fusionStore, (state) =>
    computerKey ? (state.byComputer[computerKey] ?? EMPTY_FUSION_STATE) : EMPTY_FUSION_STATE,
  );
}

function waitForOnlineComputer(computerKey: string, timeoutMs = 12_000): Promise<Computer> {
  const immediate = engine.computerForKey(computerKey);
  if (immediate?.machine.online) return Promise.resolve(immediate);
  return new Promise<Computer>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      const found = engine.computerForKey(computerKey);
      const displayName = found
        ? computerName(found, computerNames.store.getState())
        : undefined;
      reject(
        new Error(
          displayName
            ? `「${displayName}」当前离线，无法打开融合应用`
            : "未找到对应的远端电脑，请先打开 LinkShell 检查连接",
        ),
      );
    }, timeoutMs);
    const unsubscribe = engine.state.subscribe(() => {
      const next = engine.computerForKey(computerKey);
      if (next?.machine.online) {
        clearTimeout(timer);
        unsubscribe();
        resolve(next);
      }
    });
  });
}

function waitForConnectionOnline(
  store: {
    getState(): { status: string; statusDetail?: string };
    subscribe(listener: () => void): () => void;
  },
  timeoutMs = 12_000,
): Promise<void> {
  if (store.getState().status === "online") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      const current = store.getState();
      reject(
        new Error(
          current.status === "locked"
            ? "远端电脑设置了访问密码，请先在 LinkShell 中解锁"
            : current.statusDetail || "连接远端电脑超时，请检查网络或网关状态",
        ),
      );
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      const current = store.getState();
      if (current.status === "online") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      } else if (current.status === "locked") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error("远端电脑设置了访问密码，请先在 LinkShell 中解锁"));
      }
    });
  });
}

/**
 * Headless entry point invoked by `--fusion-connect` / `--fusion-launch` Dock stubs via `main.ts`,
 * executing reliably even when the main Electron window is hidden (`document.hidden === true`).
 */
export async function connectAndStartComputerFusion(
  computerKey: string,
  launchBundle?: string,
  options: { explicit?: boolean; reconnect?: boolean } = {},
): Promise<void> {
  // After Disconnect, entry points (sidebar, command center, Dock stubs) do not undo it: only the
  // Fusion page's own start button (`explicit`) or opening a fused app does.
  if (fusionController.isPaused(computerKey) && !options.explicit && !launchBundle) return;
  try {
    await engine.start();
    const computer = await waitForOnlineComputer(computerKey);
    const retained = engine.retainComputer(computer);
    try {
      await waitForConnectionOnline(retained.connection.store);
    } catch (error) {
      retained.release();
      throw error;
    }
    const name = computerName(computer, computerNames.store.getState());
    await fusionController.startFusion({
      computerKey: computer.key,
      name,
      link: retained.connection.link,
      streams: retained.connection.streams,
      launchBundle,
      releaseConnection: retained.release,
      reconnect: options.reconnect,
    });
  } catch (error) {
    if (options.reconnect) throw error;
    reportDesktopError(error);
  }
}

let commandListenerAttached = false;

export function attachFusionCommandListener(): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = ((event as CustomEvent<Record<string, unknown>>).detail ?? {});
    const command = detail.command;
    if (
      (command === "fusion" || command === "fusion-start") &&
      typeof detail.computerKey === "string" &&
      detail.computerKey.length > 0
    ) {
      const launchBundle =
        typeof detail.launchBundle === "string" && detail.launchBundle.length > 0
          ? detail.launchBundle
          : undefined;
      void connectAndStartComputerFusion(detail.computerKey, launchBundle);
    }
  };
  if (!commandListenerAttached) {
    commandListenerAttached = true;
    window.addEventListener(DESKTOP_COMMAND_EVENT, handler);
  }
  return () => {
    commandListenerAttached = false;
    window.removeEventListener(DESKTOP_COMMAND_EVENT, handler);
  };
}
