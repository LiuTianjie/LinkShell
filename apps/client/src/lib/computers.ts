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
// directly. One is selected at a time; the app shows that computer.

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
  const refresh = () => void useComputers.getState().refresh(url);
  relay.onStatus((status) => {
    useComputers.setState((state) => ({ relayStatus: { ...state.relayStatus, [url]: status } }));
    if (status === "online") refresh();
  });
  relay.on("presence", ({ id, online }) => useComputers.getState().setOnline(url, id, online));
  relay.on("machines.changed", refresh);
  relay.start();
  return relay;
}

export function reconnectRelays(): void {
  for (const relay of relays.values()) relay.reconnectNow();
}

// ── store ────────────────────────────────────────────────────────────

interface ComputersState {
  saved: Saved;
  /** Live entries per gateway, from machines.list: paired and account machines. */
  live: Record<string, MachineEntry[]>;
  relayStatus: Record<string, RelayStatus>;
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
    try {
      const { machines } = await relayFor(gateway).request("machines.list", {});
      set((state) => ({ live: { ...state.live, [gateway]: machines } }));
    } catch {
      // Stays as it was; presence events keep it current.
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

// Signing in or out changes which machines the default gateway offers.
useAccount.subscribe((state, previous) => {
  if (Boolean(state.session) === Boolean(previous.session) && state.session?.userId === previous.session?.userId) return;
  const url = normalizeGateway(DEFAULT_GATEWAY);
  const relay = state.session ? relayFor(url) : relays.get(url);
  if (!relay) return;
  // Reconnect so the gateway sees (or forgets) the account.
  relay.stop();
  relays.delete(url);
  useComputers.setState((current) => ({ live: { ...current.live, [url]: [] } }));
  if (state.session || useComputers.getState().saved.relay.some((entry) => entry.gateway === url)) relayFor(url);
});

/** All computers, merged: saved paired ones (with live status), account ones, and direct hosts. */
export function listComputers(state: Pick<ComputersState, "saved" | "live">): Computer[] {
  const out: Computer[] = [];
  const seen = new Set<string>();
  for (const entry of state.saved.relay) {
    const key = relayKey(entry.gateway, entry.machine.id);
    const live = state.live[entry.gateway]?.find((machine) => machine.id === entry.machine.id);
    out.push({ key, kind: "relay", gateway: entry.gateway, machine: live ?? { ...entry.machine, online: false } });
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
