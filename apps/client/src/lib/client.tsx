import { setHostHome } from "@/lib/format";
import { deleteSecret, readSecret, writeSecret } from "./secure";
import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { probeRelays, relayFor, reconnectRelays, selectedComputer, startRelays, useComputers, type Computer } from "./computers";
import { deviceIdentity } from "./identity";
import { DEFAULT_HOST_URL } from "./settings";
import { createSocket } from "./socket";
import { directConnector } from "./direct";
import { createSessionSubscriptions } from "./session-subscriptions";

type Client = ClientState & ClientActions;

interface Connection {
  /** The selected computer's key. */
  key: string;
  computer: Computer;
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
  /** Points the app at a LAN host directly and reconnects. */
  setUrl(url: string): void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

/** No computer added yet (a new install): nothing to connect to until one is. */
const NO_COMPUTER_KEY = "none";

function fallbackComputer(): Computer {
  if (!__DEV__) return { key: NO_COMPUTER_KEY, kind: "direct", url: "", name: "电脑" };
  return { key: `direct:${DEFAULT_HOST_URL}`, kind: "direct", url: DEFAULT_HOST_URL, name: "本机开发" };
}

/** The token an access-password unlock returned, per computer: reconnects don't ask again. */
function accessToken(computer: Computer) {
  const key = `linkshell.access.${computer.key.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  return {
    load: () => readSecret<string>(key),
    save: (token: string | undefined) => {
      if (token) writeSecret(key, token);
      else void deleteSecret(key);
    },
  };
}

function createConnection(computer: Computer): Connection {
  const link =
    computer.kind === "direct"
      ? new HostLink({ url: computer.url, createSocket, lazyImages: true, accessToken: accessToken(computer) })
      : // Through a gateway: an end-to-end encrypted channel that behaves like a WebSocket.
        new HostLink({
          url: `${computer.gateway}#${computer.machine.id}`,
          createSocket: () => new TunnelSocket(relayFor(computer.gateway), deviceIdentity(), computer.machine),
          lazyImages: true,
          accessToken: accessToken(computer),
        });
  const url = computer.kind === "direct" ? computer.url : computer.gateway;
  // Pictures in history come as references and load when shown (`useImage`).
  const store = createClientStore(link, { newId: randomUUID, lazyImages: true });
  // Paths render as ~/… with this computer's home, set before anything renders them.
  setHostHome(undefined);
  const streams = new HostStreams(link, { connector: directConnector, iceServers: () => store.getState().machine?.direct?.iceServers });
  store.subscribe((state, previous) => {
    if (state.machine === previous.machine) return;
    setHostHome(state.machine?.home);
    // The computer just said whether it can go direct, and how.
    streams.connect();
  });
  const subscribeSession = createSessionSubscriptions((id) => store.getState().openSession(id), (id) => store.getState().closeSession(id));
  return { key: computer.key, computer, url, link, store, streams, subscribeSession };
}

export function ClientProvider({ children }: { children: ReactNode }) {
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const selected = useMemo(() => selectedComputer({ saved, live }) ?? fallbackComputer(), [saved, live]);
  const [connection, setConnection] = useState(() => createConnection(selected));

  useEffect(() => {
    startRelays();
  }, []);

  // A different computer selected: a new connection. (Live status updates of
  // the same computer don't reconnect.)
  useEffect(() => {
    if (selected.key !== connection.key) setConnection(createConnection(selected));
  }, [selected, connection.key]);

  useEffect(() => {
    const { store, link } = connection;
    if (connection.key === NO_COMPUTER_KEY) return;
    store.getState().connect();
    connection.streams.start();
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
      if (AppState.currentState !== "active" && !hasActiveWork()) return;
      if (store.getState().status !== "online") {
        reconnectRelays();
        link.reconnectNow();
      }
    }, 12_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Back from the background, sessions show their latest turns at once; earlier ones load
        // on scroll. Only for this return: a reconnect later (a network blip while reading)
        // catches up in place.
        clearTimeout(latestTimer);
        latestTimer = setTimeout(() => link.resumeLatest(false), 45_000);
        reconnectRelays();
        link.reconnectNow();
        // While suspended the sockets may have died without a word: ask, instead of waiting a
        // heartbeat (up to 35 s) to find out.
        probeRelays();
        link.probe();
        connection.streams.connect();
      } else if (state === "background") link.resumeLatest();
      if (state === "background" && hasActiveWork() && store.getState().status !== "online") {
        reconnectRelays();
        link.reconnectNow();
      }
    });
    return () => {
      clearTimeout(latestTimer);
      clearInterval(bgWatchdog);
      subscription.remove();
      connection.streams.stop();
      store.getState().disconnect();
    };
  }, [connection]);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      connection,
      setUrl(url) {
        const computers = useComputers.getState();
        computers.select(computers.addDirect(url, "局域网电脑"));
      },
    }),
    [connection],
  );

  return <ConnectionContext value={value}>{children}</ConnectionContext>;
}

function useConnectionContext(): ConnectionContextValue {
  const value = use(ConnectionContext);
  if (!value) throw new Error("ClientProvider is missing");
  return value;
}

/** False until the first computer is added (pairing or a Pro account). */
export function useHasComputer(): boolean {
  return useConnectionContext().connection.key !== NO_COMPUTER_KEY;
}

export function useConnection() {
  const { connection, setUrl } = useConnectionContext();
  return { url: connection.url, computer: connection.computer, link: connection.link, streams: connection.streams, setUrl };
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
