import { createStore } from "zustand/vanilla";
import {
  createClientStore,
  HostLink,
  HostStreams,
  TunnelSocket,
  pairByCode,
  pairByLink,
  type ClientStore,
} from "@linkshell/client-core";
import {
  RelayClient,
  RELAY_PATH,
  decodePairingLink,
  type Identity,
  type MachineEntry,
  type RelaySocket,
} from "@linkshell/wire";
import {
  deployment,
  initialGateway,
  officialGateway,
  validateGateway,
  type Source,
} from "../config";
import { accountClient, accountToken } from "./account";
import { browserIdentity, readLocal, saveLocal } from "./storage";
import { browserDirect } from "./direct";

export interface Computer {
  key: string;
  gateway: string;
  machine: MachineEntry;
}
export interface Connection {
  computer: Computer;
  link: HostLink;
  streams: HostStreams;
  store: ClientStore;
}
interface EngineState {
  source: Source;
  gateway: string;
  computers: Computer[];
  connection?: Connection;
  relayStatus: Record<string, string>;
  error?: string;
  account?: string;
  locked: boolean;
  ready: boolean;
}
const savedSource = readLocal<Source>("source", deployment);
const source = deployment === "self-hosted" ? "self-hosted" : savedSource;
const savedGateway =
  source === "official"
    ? officialGateway
    : readLocal("gateway", initialGateway);

export class BrowserEngine {
  readonly state = createStore<EngineState>(() => ({
    source,
    gateway: savedGateway,
    computers: [],
    relayStatus: {},
    locked: false,
    ready: false,
  }));
  private identity?: Identity;
  private relays = new Map<string, RelayClient>();
  private paired = readLocal<Computer[]>("paired", []);
  private selected = readLocal<string>("selected", "");
  private releaseLock?: () => void;
  private starting?: Promise<void>;
  private authUser?: string;
  private authSubscribed = false;
  private generation = 0;
  private readonly channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("linkshell.web.owner")
      : undefined;
  constructor() {
    this.channel?.addEventListener("message", (event) => {
      if (event.data === "yield") {
        this.stop();
        this.state.setState({ locked: true });
      }
    });
    window.addEventListener("pagehide", () => this.stop());
    window.addEventListener("pageshow", () => {
      void this.start();
    });
    window.addEventListener("online", () => this.reconnect());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.reconnect();
    });
  }
  report(error: unknown) {
    this.state.setState({
      error: error instanceof Error ? error.message : String(error),
    });
  }
  async start() {
    if (this.releaseLock || this.starting) return this.starting;
    this.starting = this.acquire(false).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async claim() {
    this.channel?.postMessage("yield");
    await this.acquire(true);
  }
  private async acquire(wait: boolean) {
    if (!navigator.locks) {
      this.report(
        new Error(
          "此浏览器不支持设备连接锁，请使用最新版 Chrome、Edge、Safari 或 Firefox",
        ),
      );
      return;
    }
    // One persisted identity has one gateway connection. Do not let tabs replace each other.
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(
          "linkshell.web.connection",
          { ifAvailable: !wait },
          async (lock) => {
            if (!lock) {
              this.state.setState({ locked: true, ready: true });
              resolve();
              return;
            }
            await new Promise<void>((release) => {
              this.releaseLock = release;
              this.state.setState({ locked: false });
              void this.boot().then(resolve, reject);
            });
          },
        )
        .catch(reject);
    }).catch((error) => this.report(error));
  }
  private async boot() {
    const generation = ++this.generation;
    this.identity = await browserIdentity();
    if (generation !== this.generation) return;
    this.state.setState({
      computers: this.paired.map((item) => ({
        ...item,
        machine: { ...item.machine, online: false },
      })),
      ready: true,
    });
    for (const item of this.paired) this.relay(item.gateway);
    if (this.state.getState().source === "official")
      await this.connectAccount();
    else if (this.state.getState().gateway)
      this.relay(validateGateway(this.state.getState().gateway));
  }
  async connectAccount() {
    if (deployment === "self-hosted") throw new Error("私有部署使用设备配对");
    const auth = accountClient().auth;
    const { data, error } = await auth.getSession();
    if (error) throw error;
    this.authUser = data.session?.user.id;
    this.state.setState({
      account: data.session?.user.email,
      source: "official",
      gateway: officialGateway,
    });
    if (!this.authSubscribed) {
      this.authSubscribed = true;
      auth.onAuthStateChange((_event, session) => {
        const changed = this.authUser !== session?.user.id;
        this.authUser = session?.user.id;
        this.state.setState({ account: session?.user.email });
        if (changed && this.releaseLock)
          setTimeout(() => {
            this.relays.get(officialGateway)?.reauthenticate();
            if (session) this.relay(officialGateway);
          }, 0);
      });
    }
    saveLocal("source", "official");
    if (data.session) this.relay(officialGateway).reauthenticate();
  }
  relay(address: string): RelayClient {
    if (!this.identity || !this.releaseLock)
      throw new Error("请先在本标签页启用连接");
    const gateway = validateGateway(address);
    const existing = this.relays.get(gateway);
    if (existing) return existing;
    const useAccount =
      gateway === officialGateway && deployment !== "self-hosted";
    const relay = new RelayClient({
      url: gateway + RELAY_PATH,
      identity: this.identity,
      role: "device",
      name: "LinkShell Web",
      platform: "web",
      token: useAccount
        ? async () => {
            try {
              return await accountToken();
            } catch (error) {
              this.report(error);
              throw error;
            }
          }
        : undefined,
      createSocket: (url) => {
        const socket = new WebSocket(url);
        const send = socket.send.bind(socket);
        // RelayClient currently treats token provider errors as anonymous auth. For a signed-in
        // browser, reject that downgrade and let the existing reconnect loop retry instead.
        socket.send = (data) => {
          if (typeof data === "string" && useAccount && this.authUser) {
            const frame = JSON.parse(data) as { t?: string; token?: string };
            if (frame.t === "auth" && !frame.token) {
              socket.close(4001, "账号续期失败，正在重试");
              return;
            }
          }
          send(data);
        };
        return socket as unknown as RelaySocket;
      },
    });
    this.relays.set(gateway, relay);
    relay.onStatus((status, error) => {
      this.state.setState((state) => ({
        relayStatus: { ...state.relayStatus, [gateway]: status },
        ...(error ? { error: error.message } : {}),
      }));
      if (status === "online")
        void this.refresh(gateway).catch((error) => this.report(error));
    });
    relay.on("machines.changed", () => {
      void this.refresh(gateway).catch((error) => this.report(error));
    });
    relay.on("presence", ({ id, online }) =>
      this.state.setState((state) => ({
        computers: state.computers.map((item) =>
          item.gateway === gateway && item.machine.id === id
            ? { ...item, machine: { ...item.machine, online } }
            : item,
        ),
      })),
    );
    relay.start();
    return relay;
  }
  async refresh(gateway: string) {
    const relay = this.relays.get(gateway);
    if (!relay) return;
    const { machines } = await relay.request("machines.list", {});
    const found = machines.map((machine) => ({
      gateway,
      machine,
      key: `${gateway}#${machine.id}`,
    }));
    this.state.setState((state) => ({
      computers: [
        ...state.computers.filter((item) => item.gateway !== gateway),
        ...found,
      ],
    }));
    const state = this.state.getState();
    if (!state.connection) {
      const chosen =
        state.computers.find((item) => item.key === this.selected) ??
        state.computers.find((item) => item.machine.online);
      if (chosen) this.select(chosen);
    }
  }
  select(computer: Computer) {
    if (!this.identity) throw new Error("设备身份尚未就绪");
    this.disconnect();
    const identity = this.identity;
    const relay = this.relay(computer.gateway);
    const link = new HostLink({
      url: computer.key,
      createSocket: () => new TunnelSocket(relay, identity, computer.machine),
      lazyImages: true,
    });
    const store = createClientStore(link, { lazyImages: true });
    const streams = new HostStreams(link, {
      connector: browserDirect,
      iceServers: () => store.getState().machine?.direct?.iceServers,
    });
    store.subscribe((state, previous) => {
      if (state.machine !== previous.machine) streams.connect();
    });
    this.state.setState({
      connection: { computer, link, store, streams },
      error: undefined,
    });
    this.selected = computer.key;
    saveLocal("selected", computer.key);
    store.getState().connect();
    streams.start();
  }
  async pair(address: string, codeOrLink: string) {
    const link = codeOrLink.trim().startsWith("linkshell:")
      ? decodePairingLink(codeOrLink.trim())
      : undefined;
    if (codeOrLink.trim().startsWith("linkshell:") && !link)
      throw new Error("配对链接格式不正确");
    if (!link && !/^\d{6}$/.test(codeOrLink.trim()))
      throw new Error("请输入 6 位配对码");
    const gateway = validateGateway(
      (link?.gateway ?? address).replace(/^http/, "ws"),
    );
    const relay = this.relay(gateway);
    const machine = link
      ? await pairByLink(relay, this.identity!, link)
      : await pairByCode(relay, this.identity!, codeOrLink.trim());
    const computer = { key: `${gateway}#${machine.id}`, gateway, machine };
    this.paired = [
      ...this.paired.filter((item) => item.key !== computer.key),
      computer,
    ];
    saveLocal("paired", this.paired);
    saveLocal("source", "self-hosted");
    saveLocal("gateway", gateway);
    this.state.setState({ source: "self-hosted", gateway });
    await this.refresh(gateway);
    this.select(computer);
  }
  async forget(computer: Computer) {
    await this.relay(computer.gateway).request("machines.forget", {
      machineId: computer.machine.id,
    });
    this.paired = this.paired.filter((item) => item.key !== computer.key);
    saveLocal("paired", this.paired);
    if (this.state.getState().connection?.computer.key === computer.key)
      this.disconnect();
    this.state.setState((state) => ({
      computers: state.computers.filter((item) => item.key !== computer.key),
    }));
  }
  reconnect() {
    if (!this.releaseLock) return;
    for (const relay of this.relays.values()) relay.reconnectNow();
    this.state.getState().connection?.link.reconnectNow();
  }
  disconnect() {
    const connection = this.state.getState().connection;
    connection?.streams.stop();
    connection?.store.getState().disconnect();
    this.state.setState({ connection: undefined });
  }
  stop() {
    this.generation++;
    this.disconnect();
    for (const relay of this.relays.values()) relay.stop();
    this.relays.clear();
    this.releaseLock?.();
    this.releaseLock = undefined;
  }
}
export const engine = new BrowserEngine();

if (import.meta.hot) import.meta.hot.dispose(() => engine.stop());
