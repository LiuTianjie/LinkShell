import { setHostHome } from "@/lib/format";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  createClientStore,
  HostLink,
  TunnelSocket,
  type ClientActions,
  type ClientState,
  type ClientStore,
} from "@linkshell/client-core";
import { relayFor, reconnectRelays, selectedComputer, startRelays, useComputers, type Computer } from "./computers";
import { deviceIdentity } from "./identity";
import { DEFAULT_HOST_URL } from "./settings";
import { createSocket } from "./socket";

type Client = ClientState & ClientActions;

interface Connection {
  /** The selected computer's key. */
  key: string;
  computer: Computer;
  /** What to show for where this connection goes. */
  url: string;
  link: HostLink;
  store: ClientStore;
}

interface ConnectionContextValue {
  connection: Connection;
  /** Points the app at a LAN host directly and reconnects. */
  setUrl(url: string): void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

function fallbackComputer(): Computer {
  return { key: `direct:${DEFAULT_HOST_URL}`, kind: "direct", url: DEFAULT_HOST_URL, name: "本机开发" };
}

function createConnection(computer: Computer): Connection {
  const link =
    computer.kind === "direct"
      ? new HostLink({ url: computer.url, createSocket })
      : // Through a gateway: an end-to-end encrypted channel that behaves like a WebSocket.
        new HostLink({
          url: `${computer.gateway}#${computer.machine.id}`,
          createSocket: () => new TunnelSocket(relayFor(computer.gateway), deviceIdentity(), computer.machine),
        });
  const url = computer.kind === "direct" ? computer.url : computer.gateway;
  const store = createClientStore(link, { newId: randomUUID });
  // Paths render as ~/… with this computer's home, set before anything renders them.
  setHostHome(undefined);
  store.subscribe((state, previous) => {
    if (state.machine !== previous.machine) setHostHome(state.machine?.home);
  });
  return { key: computer.key, computer, url, link, store };
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
    store.getState().connect();
    // Sockets die quietly in the background; come back as soon as the app does.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      reconnectRelays();
      link.reconnectNow();
    });
    return () => {
      subscription.remove();
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

export function useConnection() {
  const { connection, setUrl } = useConnectionContext();
  return { url: connection.url, computer: connection.computer, link: connection.link, setUrl };
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
