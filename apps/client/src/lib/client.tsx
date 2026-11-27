import { setHostHome } from "@/lib/format";
import { sessionPreferences } from "./session-preferences";
import { deleteSecret, readSecret, writeSecret } from "./secure";
import { createContext, use, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  createClientStore,
  HostLink,
  HostStreams,
  TunnelSocket,
  type StreamPath,
  type ClientActions,
  type ClientState,
  type ClientStore,
} from "@linkshell/client-core";
import { rememberComputerProfile, probeRelays, relayFor, reconnectRelays, selectedComputer, startRelays, useComputers, type Computer } from "./computers";
import { deviceIdentity } from "./identity";
import { HybridLanGatewaySocket, LanE2eeSocket } from "./lan-socket";
import { DEFAULT_HOST_URL } from "./settings";
import * as socketTransport from "./socket";
import { directConnector } from "./direct";
import { createSessionSubscriptions } from "./session-subscriptions";
import { syncComputerName } from "./computer-names";
import { setAppBackgrounded, useAccount } from "./account";
import { outboxStorage } from "./outbox-db";

type Client = ClientState & ClientActions;

interface Connection {
  /** The selected computer's key. */
  key: string;
  computer: Computer;
  /** Always holds the newest Computer metadata for this key (e.g. updated lanUrl/lanE2ee) without recreating the store. */
  latestComputerRef: { current: Computer };
  /** What to show for where this connection goes. */
  url: string;
  link: HostLink;
  store: ClientStore;
  /** Streams to the computer's ports (previews, the screen), peer to peer when that can be. */
  streams: HostStreams;
  subscribeSession: (id: string) => () => void;
}

interface ConnectionContextValue {
  connection: Connection;
  recovering: boolean;
  /** Points the app at a LAN host directly and reconnects. */
  setUrl(url: string): void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

/** No computer added yet (a new install): nothing to connect to until one is. */
const NO_COMPUTER_KEY = "none";

function temporaryDisconnect(message: string): boolean {
  // Identity, pairing, account and other explicit refusals must remain visible immediately.
  return /^(?:连接已断开|电脑不在线|电脑没有响应|连接电脑超时，请检查网络连接|连接网关超时|网络连接意外中断|网络请求失败，请检查网络连接|连接繁忙，正在重连|与网关的连接断开了|连不上网关|网关没有响应|没有连上网关|网关没有及时响应（[^）]*）|请求超时（[^）]*）|(?:连接已断开|正在重新连接)\s*\([^)]*\)|connection (?:closed|lost)|not connected to the gateway|no answer from the (?:gateway|computer)|(?:.* )?timed out)$/i.test(message);
}

const PENDING_COMPUTER: Computer = { key: NO_COMPUTER_KEY, kind: "direct", url: "", name: "电脑" };

function fallbackComputer(): Computer {
  if (!__DEV__) return PENDING_COMPUTER;
  return { key: `direct:${DEFAULT_HOST_URL}`, kind: "direct", url: DEFAULT_HOST_URL, name: "本机开发" };
}

/** The token an access-password unlock returned, per computer: reconnects don't ask again. */
export function accessToken(computer: Computer) {
  const key = `linkshell.access.${computer.key.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  return {
    load: () => readSecret<string>(key),
    save: (token: string | undefined) => {
      if (token) writeSecret(key, token);
      else void deleteSecret(key);
    },
  };
}

/**
 * Identity key for a Connection instance. Intentionally excludes volatile LAN hints
 * (`lanUrl`, `lanE2ee`, mDNS discovery) so Wi-Fi/mDNS flapping never tears down
 * `ClientStore`, `HostLink`, `HostStreams`, or active screens/chats.
 */
export function connectionSignature(computer: Computer): string {
  return computer.key;
}

function readLatestComputer(ref: { current: Computer }): Computer {
  const current = ref.current;
  if (current.kind === "relay") {
    const state = useComputers.getState?.() as
      | { saved?: { lanUrls?: Record<string, { url: string; e2ee?: boolean } | string> } }
      | undefined;
    if (state?.saved) {
      const entry = state.saved.lanUrls?.[current.key] ?? state.saved.lanUrls?.[current.machine.id];
      const lanUrl = typeof entry === "string" ? entry : entry?.url;
      const lanE2ee = typeof entry === "string" ? undefined : entry?.e2ee;
      if (lanUrl !== current.lanUrl || Boolean(lanE2ee) !== Boolean(current.lanE2ee)) {
        return {
          ...current,
          lanUrl,
          lanE2ee: lanE2ee ? true : undefined,
        };
      }
    }
  }
  return current;
}

function createConnection(computer: Computer): Connection {
  const latestComputerRef = { current: computer };
  const openRawSocket = (targetUrl: string) => socketTransport.createSocket(targetUrl);
  const link =
    computer.kind === "direct"
      ? new HostLink({
          url: computer.url,
          createSocket: (targetUrl) => {
            const latest = readLatestComputer(latestComputerRef);
            if (latest.kind === "direct" && latest.machine && latest.fallbackGateway) {
              const machine = latest.machine;
              const fallbackGateway = latest.fallbackGateway;
              return new HybridLanGatewaySocket({
                openLan: () => new LanE2eeSocket(targetUrl, openRawSocket, deviceIdentity(), machine),
                openGateway: () => new TunnelSocket(relayFor(fallbackGateway), deviceIdentity(), machine),
              });
            }
            if (latest.kind === "direct" && latest.machine) {
              return new LanE2eeSocket(targetUrl, openRawSocket, deviceIdentity(), latest.machine);
            }
            return openRawSocket(targetUrl);
          },
          lazyImages: true,
          accessToken: accessToken(computer),
        })
      : // Through a gateway, or RFC 8305 Happy Eyeballs LAN + Gateway race when a LAN fast-path is configured.
        new HostLink({
          url: `${computer.gateway}#${computer.machine.id}`,
          createSocket: () => {
            const latest = readLatestComputer(latestComputerRef);
            const active = latest.kind === "relay" ? latest : computer;
            const openGateway = () => new TunnelSocket(relayFor(active.gateway), deviceIdentity(), active.machine);
            if (!active.lanUrl) return openGateway();
            const lanUrl = active.lanUrl;
            const lanE2ee = Boolean(active.lanE2ee);
            return new HybridLanGatewaySocket({
              openLan: () =>
                lanE2ee
                  ? new LanE2eeSocket(lanUrl, openRawSocket, deviceIdentity(), active.machine)
                  : openRawSocket(lanUrl),
              openGateway,
            });
          },
          lazyImages: true,
          accessToken: accessToken(computer),
        });
  const url = computer.kind === "direct" ? computer.url : computer.lanUrl ?? computer.gateway;
  // Pictures in history come as references and load when shown (`useImage`).
  const store = createClientStore(link, {
    newId: randomUUID,
    lazyImages: true,
    sessionPreferences,
    ...(computer.key !== NO_COMPUTER_KEY ? { outboxStorage, outboxKey: computer.key } : {}),
  });
  // Paths render as ~/… with this computer's home, set before anything renders them.
  setHostHome(undefined);
  const streams = new HostStreams(link, { connector: directConnector, iceServers: () => store.getState().machine?.direct?.iceServers });
  const subscribeSession = createSessionSubscriptions((id) => store.getState().openSession(id), (id) => store.getState().closeSession(id));
  return { key: computer.key, computer, latestComputerRef, url, link, store, streams, subscribeSession };
}

const EMPTY_LAN_HOSTS: never[] = [];

function isAwaitingAccountSelection(
  saved: { selected?: string } | undefined,
  discovery: Record<string, string> | undefined,
  signedIn: boolean,
): boolean {
  const key = saved?.selected;
  if (!key || !signedIn || !discovery || key.startsWith("direct:")) return false;
  const hash = key.indexOf("#");
  if (hash <= 0) return false;
  const gateway = key.slice(0, hash).trim().replace(/\/+$/, "").replace(/^http/, "ws");
  const status = discovery[gateway];
  return status === undefined || status === "loading";
}

export function ClientProvider({ children }: { children: ReactNode }) {
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const lanHosts = useComputers((state) => state.lanHosts) ?? EMPTY_LAN_HOSTS;
  const discovery = useComputers((state) => state.discovery);
  const signedIn = useSyncExternalStore(
    useAccount.subscribe,
    () => Boolean(useAccount.getState?.()?.session),
    () => false,
  );
  const selected = useMemo(() => {
    const resolved = selectedComputer({ saved, live, lanHosts, discovery }, { signedIn });
    if (resolved) return resolved;
    // Wait for account-only computer resolution instead of jumping to a fallback computer on cold start.
    if (isAwaitingAccountSelection(saved, discovery, signedIn)) return PENDING_COMPUTER;
    return fallbackComputer();
  }, [saved, live, lanHosts, discovery, signedIn]);
  const [connection, setConnection] = useState(() => createConnection(selected));
  const [recovering, setRecovering] = useState(true);
  const initialRecovery = useRef(true);

  if (selected.key === connection.key) {
    connection.latestComputerRef.current = selected;
  }

  useEffect(() => {
    startRelays();
  }, []);

  // Replace the old store before a newly selected computer can paint or accept input.
  useLayoutEffect(() => {
    if (connectionSignature(selected) !== connectionSignature(connection.computer)) {
      setConnection(createConnection(selected));
    } else {
      connection.latestComputerRef.current = selected;
    }
  }, [selected, connection]);

  useEffect(() => {
    const { store, link } = connection;
    const unwatchMachine = store.subscribe((state, previous) => {
      if (state.machine === previous.machine) return;
      setHostHome(state.machine?.home);
      if (state.machine) {
        rememberComputerProfile(connection.latestComputerRef.current, state.machine);
        syncComputerName(connection.latestComputerRef.current, state.machine);
      }
      // The computer just said whether it can go direct, and how.
      connection.streams.connect();
    });
    const hasComputer = connection.key !== NO_COMPUTER_KEY;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const clearRecovering = () => {
      clearTimeout(recoveryTimer);
      setRecovering(false);
    };
    const recoveringNow = () => {
      clearTimeout(recoveryTimer);
      setRecovering(true);
      // Reconnection is expected after suspension. A bounded grace period keeps a real
      // outage visible without briefly calling the old, suspended socket a failure.
      recoveryTimer = setTimeout(() => setRecovering(false), 12_000);
    };
    // Never burn the cold-start recovery grace period while waiting for the first real computer.
    if (hasComputer && initialRecovery.current) {
      initialRecovery.current = false;
      recoveringNow();
    } else {
      clearRecovering();
    }
    const unwatchStatus = link.onStatus((status, error) => {
      if (status === "online" || status === "locked" || status === "stopped" || (status === "reconnecting" && error && !temporaryDisconnect(error))) {
        clearRecovering();
      }
    });
    const unwatchAccount = useAccount.subscribe((state, previous) => {
      if (state.session?.userId === previous.session?.userId) return;
      clearRecovering();
    });
    if (hasComputer) {
      store.getState().connect();
      connection.streams.start();
    }
    // Keep the socket alive in the background while active sessions are running or waiting,
    // and reconnect immediately when returning to the foreground.
    const hasActiveWork = () => {
      const st = store.getState();
      return Object.values(st.sessions).some(
        (s) =>
          !s.archived &&
          (s.state === "running" ||
            s.state === "waiting" ||
            s.pendingPermissions > 0 ||
            Boolean(s.asyncQuestions?.length)),
      );
    };
    let latestTimer: ReturnType<typeof setTimeout> | undefined;
    const bgWatchdog = setInterval(() => {
      if (!hasComputer) return;
      if (AppState.currentState !== "active" && !hasActiveWork()) return;
      if (store.getState().status !== "online") {
        reconnectRelays();
        link.reconnectNow();
      }
    }, 12_000);
    setAppBackgrounded(AppState.currentState !== "active");
    const subscription = AppState.addEventListener("change", (state) => {
      setAppBackgrounded(state !== "active");
      if (state === "active") {
        // Back from the background, sessions show their latest turns at once; earlier ones load
        // on scroll. Only for this return: a reconnect later (a network blip while reading)
        // catches up in place.
        clearTimeout(latestTimer);
        latestTimer = setTimeout(() => link.resumeLatest(false), 45_000);
        if (!hasComputer) {
          clearRecovering();
          reconnectRelays();
          probeRelays();
        } else if (link.status === "online") {
          recoveringNow();
          // While suspended the sockets may have died without a word: probe with a 2.5s deadline
          // instead of waiting a heartbeat (up to 35 s) or tearing down a live socket.
          probeRelays();
          void Promise.resolve(link.probe(2500)).then((alive) => {
            if (alive === false) reconnectRelays();
            else clearRecovering();
          });
          connection.streams.connect();
        } else if (link.status === "locked") {
          clearRecovering();
          probeRelays();
        } else {
          recoveringNow();
          reconnectRelays();
          link.reconnectNow(true);
          connection.streams.connect();
        }
      } else if (state === "background") {
        clearTimeout(recoveryTimer);
        setRecovering(true);
        if (hasComputer) link.resumeLatest();
      }
      if (state === "background" && hasComputer && hasActiveWork() && store.getState().status !== "online") {
        reconnectRelays();
        link.reconnectNow();
      }
    });
    let lastNetworkInterface: string | undefined;
    const subscribeNetwork = Object.prototype.hasOwnProperty.call(socketTransport, "subscribeNetworkPathChange")
      ? socketTransport.subscribeNetworkPathChange
      : undefined;
    const restartLan = Object.prototype.hasOwnProperty.call(socketTransport, "restartLanDiscovery")
      ? socketTransport.restartLanDiscovery
      : undefined;
    const unwatchNetwork =
      typeof subscribeNetwork === "function"
        ? subscribeNetwork((event) => {
            const prevInterface = lastNetworkInterface;
            lastNetworkInterface = event.interface;
            if (event.status === "unsatisfied") return;
            // Wi-Fi <-> 5G / interface transition: wake relays, restart mDNS discovery, and roam immediately.
            reconnectRelays();
            if (typeof restartLan === "function") restartLan();
            if (!hasComputer) return;
            const switchedInterface = prevInterface !== undefined && prevInterface !== event.interface;
            if (link.status === "online" && !switchedInterface) {
              void Promise.resolve(link.probe(2500)).then((alive) => {
                if (alive === false) {
                  reconnectRelays();
                  link.reconnectNow(true);
                } else {
                  clearRecovering();
                }
              });
            } else if (link.status !== "locked") {
              recoveringNow();
              link.reconnectNow(true);
            }
            connection.streams.connect();
          })
        : () => {};
    return () => {
      clearTimeout(latestTimer);
      clearTimeout(recoveryTimer);
      clearInterval(bgWatchdog);
      unwatchMachine();
      unwatchStatus();
      unwatchAccount();
      unwatchNetwork();
      subscription.remove();
      connection.streams.stop();
      store.getState().disconnect();
    };
  }, [connection]);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      connection,
      recovering,
      setUrl(url) {
        const computers = useComputers.getState();
        computers.select(computers.addDirect(url, "局域网电脑"));
      },
    }),
    [connection, recovering],
  );

  return <ConnectionContext value={value}>{children}</ConnectionContext>;
}

function useConnectionContext(): ConnectionContextValue {
  const value = use(ConnectionContext);
  if (!value) throw new Error("ClientProvider is missing");
  return value;
}

/** Returns the active connection if inside `ClientProvider`, or undefined in isolated previews/tests. */
export function useOptionalConnection(): Connection | undefined {
  return use(ConnectionContext)?.connection;
}

/** False until the first computer is added (pairing or a member account). */
export function useHasComputer(): boolean {
  return useConnectionContext().connection.key !== NO_COMPUTER_KEY;
}

export function useConnectionRecovering(): boolean {
  return useConnectionContext().recovering;
}

/** Presentation only: permissions and actions continue to use the actual link status. */
export function useConnectionStatus(): ClientState["status"] {
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const recovering = useConnectionRecovering();
  const hasComputer = useHasComputer();
  return hasComputer && recovering && (status === "idle" || (status === "reconnecting" && (!detail || temporaryDisconnect(detail)))) ? "connecting" : status;
}

export function useConnection() {
  const { connection, setUrl } = useConnectionContext();
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const lanHosts = useComputers((state) => state.lanHosts) ?? EMPTY_LAN_HOSTS;
  const discovery = useComputers((state) => state.discovery);
  const signedIn = useSyncExternalStore(
    useAccount.subscribe,
    () => Boolean(useAccount.getState?.()?.session),
    () => false,
  );
  const selected = useMemo(
    () => selectedComputer({ saved, live, lanHosts, discovery }, { signedIn }),
    [saved, live, lanHosts, discovery, signedIn],
  );
  const computer = selected?.key === connection.key ? selected : connection.latestComputerRef.current;
  const url = computer.kind === "direct" ? computer.url : computer.lanUrl ?? computer.gateway;
  return { url, computer, link: connection.link, streams: connection.streams, setUrl };
}

/** The path streams opened now would take: peer to peer, or through the gateway. */
export function useStreamPath(): StreamPath {
  const { streams } = useConnectionContext().connection;
  return useSyncExternalStore(
    (notify) => streams.onPath(notify),
    () => streams.path,
  );
}

/** Selects from the client store; the selector must return stable values. */
export function useClient<T>(selector: (state: Client) => T): T {
  return useStore(useConnectionContext().connection.store, selector);
}

/** Like `useClient`, for selectors that build arrays or objects. */
export function useClientShallow<T>(selector: (state: Client) => T): T {
  return useStore(useConnectionContext().connection.store, useShallow(selector));
}

/**
 * Store actions, as one object that stays the same for the lifetime of a
 * connection (the state object itself is replaced on every update).
 */
export function useActions(): ClientActions {
  const { store } = useConnectionContext().connection;
  return useMemo(() => {
    const state = store.getState() as unknown as Record<string, unknown>;
    const actions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) if (typeof value === "function") actions[key] = value;
    return actions as unknown as ClientActions;
  }, [store]);
}

/** The refcounted subscribe, for holders that aren't one screen (the watch follows several sessions). */
export function useSessionSubscriber(): (sessionId: string) => () => void {
  return useConnectionContext().connection.subscribeSession;
}

/** Detail routes also work when opened directly, without stealing the parent screen's subscription. */
export function useSessionSubscription(sessionId: string, enabled = true) {
  const { subscribeSession } = useConnectionContext().connection;
  useEffect(() => {
    if (enabled) return subscribeSession(sessionId);
  }, [subscribeSession, sessionId, enabled]);
}
