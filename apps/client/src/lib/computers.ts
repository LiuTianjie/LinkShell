import Storage from "expo-sqlite/kv-store";
import { Platform } from "react-native";
import * as Device from "expo-device";
import { create } from "zustand";
import { RELAY_PATH, RelayClient, type MachineEntry, type RelaySocket, type RelayStatus } from "@linkshell/wire";
import { useAccount } from "./account";
import { deviceIdentity } from "./identity";
import { DEFAULT_HOST_URL } from "./settings";
import { createSocket } from "./socket";

// Every computer this phone can reach: ones paired through a gateway, ones on
// the signed-in account (no pairing needed), and hosts on the LAN reached
// directly. Actions use the selected computer; project overviews can read several computers.

/** The gateway used for account sign-in. QR codes can name any other gateway. */
export const DEFAULT_GATEWAY = process.env.EXPO_PUBLIC_LINKSHELL_GATEWAY ?? "wss://gateway.itool.tech";

export type Computer =
  | { key: string; kind: "relay"; gateway: string; machine: MachineEntry }
  | { key: string; kind: "direct"; url: string; name: string };

interface Saved {
  relay: { gateway: string; machine: Omit<MachineEntry, "online"> }[];
  direct: { url: string; name: string }[];
  selected?: string;
}

const KEY = "computers.v2";

function load(): Saved {
  try {
    const raw = Storage.getItemSync(KEY);
    if (raw) return JSON.parse(raw) as Saved;
  } catch {
    // Fall through to the default.
  }
  // Development builds start on a host on this Mac; a real install starts with none.
  return { relay: [], direct: __DEV__ ? [{ url: DEFAULT_HOST_URL, name: "本机开发" }] : [] };
}

function persist(saved: Saved): void {
  try {
    Storage.setItemSync(KEY, JSON.stringify(saved));
  } catch {
    // The list is rebuilt from the gateway on the next launch anyway.
  }
}

export function relayKey(gateway: string, machineId: string): string {
  return `${gateway}#${machineId}`;
}

function normalizeGateway(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/^http/, "ws");
}

// ── gateway connections ──────────────────────────────────────────────

const relays = new Map<string, RelayClient>();
const relayAccounts = new Map<string, string | undefined>();
const discoveryRequests = new Map<string, number>();
type DiscoveryStatus = "loading" | "ready" | "failed" | "refused";

function discoveryFailure(code?: string): "failed" | "refused" {
  return !code || ["offline", "timeout", "disconnected", "connect_failed", "closed"].includes(code) ? "failed" : "refused";
}

function deviceName(): string {
  return Device.deviceName ?? Device.modelName ?? (Platform.OS === "ios" ? "iPhone" : "Android");
}

/** The gateway connection for `gateway`, started on first use. */
export function relayFor(gateway: string): RelayClient {
  const url = normalizeGateway(gateway);
  let relay = relays.get(url);
  if (relay) return relay;
  relay = new RelayClient({
    url: url + RELAY_PATH,
    identity: deviceIdentity(),
    role: "device",
    name: deviceName(),
    platform: Platform.OS,
    // The account token only ever goes to the default gateway, never to one a QR code named.
    token: url === normalizeGateway(DEFAULT_GATEWAY) ? () => useAccount.getState().token() : undefined,
    // The same socket choice as direct connections: native, proxy-free for LAN gateways.
    createSocket: (target) => createSocket(target) as unknown as RelaySocket,
  });
  relays.set(url, relay);
  relayAccounts.set(url, url === normalizeGateway(DEFAULT_GATEWAY) ? useAccount.getState().session?.userId : undefined);
  const current = () => relays.get(url) === relay && (url !== normalizeGateway(DEFAULT_GATEWAY) || relayAccounts.get(url) === useAccount.getState().session?.userId);
  const refresh = () => { if (current()) void useComputers.getState().refresh(url); };
  relay.onStatus((status, error) => {
    if (!current()) return;
    useComputers.setState((state) => ({
      relayStatus: { ...state.relayStatus, [url]: status },
      ...(status === "offline" || status === "stopped"
        ? { discovery: { ...state.discovery, [url]: discoveryFailure(error?.code) } }
        : {}),
    }));
    if (status === "online") refresh();
  });
  relay.on("presence", ({ id, online }) => {
    if (!current()) return;
    // A computer that just joined the account is announced before this list knows it.
    if (online && !useComputers.getState().live[url]?.some((machine) => machine.id === id)) refresh();
    else useComputers.getState().setOnline(url, id, online);
  });
  relay.on("machines.changed", refresh);
  relay.start();
  return relay;
}

export function reconnectRelays(): void {
  for (const relay of relays.values()) relay.reconnectNow();
}

/** Back in the foreground: a gateway connection that looks open may have died meanwhile. */
export function probeRelays(): void {
  for (const relay of relays.values()) relay.probe();
}

// ── store ────────────────────────────────────────────────────────────

interface ComputersState {
  saved: Saved;
  /** Live entries per gateway, from machines.list: paired and account machines. */
  live: Record<string, MachineEntry[]>;
  relayStatus: Record<string, RelayStatus>;
  discovery: Record<string, DiscoveryStatus>;
  select(key: string): void;
  addPaired(gateway: string, machine: MachineEntry): string;
  addDirect(url: string, name: string): string;
  /**
   * Removes a computer from this phone's list. A paired one is unpaired; one that is here through
   * the account is taken off the account at the gateway (it comes back if it ever signs in again).
   * False when the gateway kept it: one from before it could forget an account's computer.
   */
  remove(key: string): Promise<boolean>;
  refresh(gateway: string): Promise<void>;
  setOnline(gateway: string, id: string, online: boolean): void;
}

export const useComputers = create<ComputersState>((set, get) => ({
  saved: load(),
  live: {},
  relayStatus: {},
  discovery: {},
  select(key) {
    const saved = { ...get().saved, selected: key };
    persist(saved);
    set({ saved });
  },
  addPaired(gateway, machine) {
    const url = normalizeGateway(gateway);
    const { online: _online, ...rest } = machine;
    const saved: Saved = {
      ...get().saved,
      relay: [...get().saved.relay.filter((entry) => !(entry.gateway === url && entry.machine.id === machine.id)), { gateway: url, machine: rest }],
    };
    persist(saved);
    // Known to be online right now (it just answered the pairing).
    set((state) => ({
      saved,
      live: { ...state.live, [url]: [...(state.live[url] ?? []).filter((entry) => entry.id !== machine.id), machine] },
    }));
    relayFor(url);
    void get().refresh(url);
    return relayKey(url, machine.id);
  },
  addDirect(url, name) {
    const saved: Saved = { ...get().saved, direct: [...get().saved.direct.filter((entry) => entry.url !== url), { url, name }] };
    persist(saved);
    set({ saved });
    return `direct:${url}`;
  },
  async remove(key) {
    const current = get().saved;
    const relayEntry = current.relay.find((entry) => relayKey(entry.gateway, entry.machine.id) === key);
    if (relayEntry) await relayFor(relayEntry.gateway).request("machines.forget", { machineId: relayEntry.machine.id }).catch(() => {});
    const saved: Saved = {
      relay: current.relay.filter((entry) => relayKey(entry.gateway, entry.machine.id) !== key),
      direct: current.direct.filter((entry) => `direct:${entry.url}` !== key),
      selected: current.selected === key ? undefined : current.selected,
    };
    persist(saved);
    set({ saved });
    if (relayEntry) return true;
    // Not paired, so here through the account: only the gateway can forget it.
    for (const [gateway, machines] of Object.entries(get().live)) {
      const machine = machines.find((entry) => relayKey(gateway, entry.id) === key);
      if (!machine) continue;
      await relayFor(gateway).request("machines.forget", { machineId: machine.id }).catch(() => {});
      await get().refresh(gateway);
      return !(get().live[gateway] ?? []).some((entry) => entry.id === machine.id);
    }
    return true;
  },
  async refresh(gateway) {
    gateway = normalizeGateway(gateway);
    const relay = relayFor(gateway);
    const currentAccount = () => gateway !== normalizeGateway(DEFAULT_GATEWAY) || relayAccounts.get(gateway) === useAccount.getState().session?.userId;
    if (!currentAccount()) return;
    const request = (discoveryRequests.get(gateway) ?? 0) + 1;
    discoveryRequests.set(gateway, request);
    const current = () => relays.get(gateway) === relay && discoveryRequests.get(gateway) === request && currentAccount();
    set((state) => ({ discovery: { ...state.discovery, [gateway]: "loading" } }));
    try {
      const { machines } = await relay.request("machines.list", {});
      if (!current()) return;
      const accountId = gateway === normalizeGateway(DEFAULT_GATEWAY) ? useAccount.getState().session?.userId : undefined;
      const accountMatches = !!accountId && relay.account?.userId === accountId;
      // Signing out while offline can leave the gateway's old account binding intact.
      // Only a matching authenticated account may restore its account-only computers.
      const visibleMachines = machines.filter((machine) => machine.via === "paired" || accountMatches);
      set((state) => ({
        live: { ...state.live, [gateway]: visibleMachines },
        discovery: { ...state.discovery, [gateway]: accountId && !accountMatches ? "refused" : "ready" },
      }));
    } catch (error) {
      // Stays as it was; presence events keep it current.
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (current()) set((state) => ({ discovery: { ...state.discovery, [gateway]:
        state.discovery[gateway] === "refused" ? "refused" : discoveryFailure(relay.lastError?.code ?? code),
      } }));
    }
  },
  setOnline(gateway, id, online) {
    set((state) => ({
      live: { ...state.live, [gateway]: (state.live[gateway] ?? []).map((machine) => (machine.id === id ? { ...machine, online } : machine)) },
    }));
  },
}));

/** Starts the gateway connections this phone needs: saved computers' gateways, and the account's. */
export function startRelays(): void {
  const { saved } = useComputers.getState();
  for (const entry of saved.relay) relayFor(entry.gateway);
  if (useAccount.getState().session) relayFor(DEFAULT_GATEWAY);
}

/** A healthy gateway can still time out on machines.list, so retry the query too. */
export function retryComputerDiscovery(): void {
  startRelays();
  for (const [gateway, relay] of relays) {
    if (relay.status === "online") void useComputers.getState().refresh(gateway);
    else relay.reconnectNow();
  }
}

// Signing in or out changes which machines the default gateway offers.
useAccount.subscribe((state, previous) => {
  if (Boolean(state.session) === Boolean(previous.session) && state.session?.userId === previous.session?.userId) return;
  const url = normalizeGateway(DEFAULT_GATEWAY);
  const relay = relays.get(url);
  // Account-only computers must disappear immediately, before account.leave can wait on the
  // network. Saved pairings still come from their trusted keys and remain available.
  discoveryRequests.set(url, (discoveryRequests.get(url) ?? 0) + 1);
  useComputers.setState((current) => ({ live: { ...current.live, [url]: [] }, discovery: { ...current.discovery, [url]: "loading" } }));
  if (!relay) {
    if (state.session || useComputers.getState().saved.relay.some((entry) => entry.gateway === url)) relayFor(url);
    return;
  }
  // Signed out (or the session ended on the server): the gateway keeps a phone on its account
  // through a missing or failed token, so it is told. Gateways from before `account.leave`
  // answer unknown_method, and keep it as they always did.
  const leaving = previous.session && !state.session ? relay.request("account.leave", {}, 5000).catch(() => undefined) : Promise.resolve(undefined);
  void leaving.then(() => {
    if (relays.get(url) !== relay) return;
    // Reconnect so the gateway sees (or forgets) the account.
    relay.stop();
    relays.delete(url);
    relayAccounts.delete(url);
    if (useAccount.getState().session || useComputers.getState().saved.relay.some((entry) => entry.gateway === url)) relayFor(url);
  });
});

/** Account computers are discovered after startup; an empty list before that is not onboarding. */
export function useComputerDiscovery(): DiscoveryStatus {
  const signedIn = useAccount((state) => !!state.session);
  return useComputers((state) => {
    const gateways = new Set(state.saved.relay.map((entry) => entry.gateway));
    if (signedIn) gateways.add(normalizeGateway(DEFAULT_GATEWAY));
    const states = [...gateways].map((gateway) => state.discovery[gateway]);
    if (states.some((status) => status === "refused")) return "refused";
    if (states.some((status) => status === undefined || status === "loading")) return "loading";
    return states.some((status) => status === "failed") ? "failed" : "ready";
  });
}

/** All computers, merged: saved paired ones (with live status), account ones, and direct hosts. */
export function listComputers(state: Pick<ComputersState, "saved" | "live">): Computer[] {
  const out: Computer[] = [];
  const seen = new Set<string>();
  for (const entry of state.saved.relay) {
    const key = relayKey(entry.gateway, entry.machine.id);
    const live = state.live[entry.gateway]?.find((machine) => machine.id === entry.machine.id);
    // The signing key is the one pairing checked against the QR code, never what the gateway lists
    // now: a gateway that swapped it could otherwise stand in for the computer. (The box key may
    // come from the gateway: a wrong one only makes the signed handshake fail.) One listed with
    // another signing key is shown offline.
    const same = live && live.signKey === entry.machine.signKey;
    const machine = live && same ? live : { ...entry.machine, ...(live ? { name: live.name } : {}), online: false };
    out.push({ key, kind: "relay", gateway: entry.gateway, machine });
    seen.add(key);
  }
  for (const [gateway, machines] of Object.entries(state.live)) {
    for (const machine of machines) {
      const key = relayKey(gateway, machine.id);
      if (!seen.has(key)) out.push({ key, kind: "relay", gateway, machine });
      seen.add(key);
    }
  }
  for (const entry of state.saved.direct) out.push({ key: `direct:${entry.url}`, kind: "direct", url: entry.url, name: entry.name });
  return out;
}

/** The selected computer, or the best default: an online one, else the first. */
export function selectedComputer(state: Pick<ComputersState, "saved" | "live">): Computer | undefined {
  const all = listComputers(state);
  return (
    all.find((computer) => computer.key === state.saved.selected) ??
    all.find((computer) => computer.kind === "relay" && computer.machine.online) ??
    all[0]
  );
}

/** Store only display metadata; the paired signing key and selected connection stay intact. */
export function updateComputerName(computer: Computer, name: string, namingConfigured?: boolean): void {
  const state = useComputers.getState();
  let changed = false;
  const updateMachine = <T extends { name: string; namingConfigured?: boolean }>(machine: T): T => {
    if (machine.name === name && (!namingConfigured || machine.namingConfigured)) return machine;
    changed = true;
    return { ...machine, name, ...(namingConfigured || machine.namingConfigured ? { namingConfigured: true } : {}) };
  };
  const saved: Saved = computer.kind === "direct" ? { ...state.saved,
    direct: state.saved.direct.map((entry) => entry.url === computer.url ? updateMachine(entry) : entry),
  } : { ...state.saved,
    relay: state.saved.relay.map((entry) => entry.gateway === computer.gateway && entry.machine.id === computer.machine.id
      ? { ...entry, machine: updateMachine(entry.machine) } : entry),
  };
  const live = computer.kind === "relay" ? { ...state.live,
    [computer.gateway]: (state.live[computer.gateway] ?? []).map((machine) => machine.id === computer.machine.id
      ? updateMachine(machine) : machine),
  } : state.live;
  if (!changed) return;
  persist(saved);
  useComputers.setState({ saved, live });
}
