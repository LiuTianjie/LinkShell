import { createStore } from "zustand/vanilla";
import {
  createClientStore,
  HostLink,
  HostStreams,
  TunnelSocket,
  pairByCode,
  pairByLink,
  type ClientStore,
  type SocketLike,
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
import { ComputerConnections } from "./computer-connections";
import { computerNames } from "./computer-names";
import { computerAtKey, deduplicateLocalComputer } from "./computer-identity";
import {
  DESKTOP_ACCOUNT_EVENT, DESKTOP_ERROR_EVENT, DESKTOP_LOCAL, DESKTOP_VISIBILITY_EVENT,
  desktopAccount, desktopHostSocket, desktopLocalComputer, desktopRequest, isDesktop, isWindowsDesktop,
  retryDesktopStorage, type DesktopAccount,
} from "./desktop";

export interface Computer {
  key: string;
  gateway: string;
  machine: MachineEntry;
  /** The local host's public gateway identity, learned over its trusted local socket. */
  relayId?: string;
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
  /** Kept while its reachable relay alias is the visible row. */
  localComputer?: Computer;
  connection?: Connection;
  relayStatus: Record<string, string>;
  error?: string;
  account?: string;
  accountUserId?: string;
  locked: boolean;
  ready: boolean;
  localError?: string;
}
const savedSource = readLocal<Source>("source", deployment);
const source = deployment === "self-hosted" ? "self-hosted" : savedSource;
const savedGateway =
  source === "official"
    ? officialGateway
    : readLocal("gateway", initialGateway);
const accountBindingError = "网关未确认当前账号，请退出账号后重新登录。";

function relayErrorMessage(error: { code: string; message: string }): string {
  switch (error.code) {
    case "disconnected":
    case "connect_failed":
      return "与网关的连接断开了，正在自动重连…";
    case "replaced":
      return "这台设备已在别处连上网关";
    default:
      return error.message;
  }
}

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
  /** The banner each gateway last raised, taken down again once that gateway is back online. */
  private relayErrors = new Map<string, string>();
  private paired = readLocal<Computer[]>("paired", []);
  private localAliases = new Map<string, Computer>();
  private selected = readLocal<string>("selected", "");
  private releaseLock?: () => void;
  private starting?: Promise<void>;
  private authUser?: string;
  private accountRevision = 0;
  private authSubscribed = false;
  private generation = 0;
  private desktopPoll?: ReturnType<typeof setInterval>;
  private accountAuthTimer?: ReturnType<typeof setTimeout>;
  private desktopRefresh?: Promise<void>;
  private desktopLocalRequest?: Promise<void>;
  private desktopLocalAbort?: AbortController;
  private desktopLocalRetry?: ReturnType<typeof setTimeout>;
  private desktopLocalAttempt?: number;
  private readonly connections = new ComputerConnections((computer) => this.openComputer(computer));
  private releaseSelected?: () => void;
  private readonly channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("linkshell.web.owner")
      : undefined;
  constructor() {
    if (isDesktop) {
      window.addEventListener(DESKTOP_ERROR_EVENT, (event) => this.report((event as CustomEvent<string>).detail));
      window.addEventListener(DESKTOP_ACCOUNT_EVENT, (event) => this.applyAccount((event as CustomEvent<DesktopAccount>).detail));
      window.addEventListener(DESKTOP_VISIBILITY_EVENT, (event) => {
        if ((event as CustomEvent<{ visible: boolean }>).detail?.visible) this.reconnect();
      });
    }
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
    if (isDesktop) {
      // The native app owns one workspace. Its changing loopback origin must not create
      // another device identity or depend on browser-wide Web Locks support.
      this.releaseLock = () => {};
      this.state.setState({ locked: false });
      await this.boot().catch((error) => this.report(error));
      return;
    }
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
    this.localAliases.clear();
    this.state.setState({
      localComputer: undefined,
      computers: this.paired.map((item) => ({
        ...item,
        machine: { ...item.machine, online: false },
      })),
      ready: true,
    });
    if (isDesktop) {
      const local = desktopLocalComputer();
      if (local) this.setLocalComputer(local);
      else this.desktopLocalAttempt = 0;
      this.desktopPoll = setInterval(() => { void this.refreshDesktop(); }, 30_000);
      void this.refreshDesktop();
    }
    for (const item of this.paired) this.relay(item.gateway);
    if (this.state.getState().source === "official")
      await this.connectAccount();
    else if (this.state.getState().gateway)
      this.relay(validateGateway(this.state.getState().gateway));
  }
  async connectAccount() {
    if (deployment === "self-hosted") throw new Error("私有部署使用设备配对");
    if (isDesktop) {
      const account = await desktopAccount();
      this.applyAccount(account);
      this.state.setState({ source: "official", gateway: officialGateway });
      saveLocal("source", "official");
      return;
    }
    const auth = accountClient().auth;
    const revision = this.accountRevision;
    const { data, error } = await auth.getSession();
    if (revision === this.accountRevision) {
      if (error) throw error;
      this.applyAccount({ userId: data.session?.user.id, email: data.session?.user.email });
    }
    this.state.setState({
      source: "official",
      gateway: officialGateway,
    });
    if (!this.authSubscribed) {
      this.authSubscribed = true;
      auth.onAuthStateChange((_event, session) => {
        this.applyAccount({ userId: session?.user.id, email: session?.user.email });
      });
    }
    saveLocal("source", "official");
  }
  private applyAccount(account: Pick<DesktopAccount, "userId" | "email">) {
    const changed = this.authUser !== account.userId;
    this.authUser = account.userId;
    if (changed) {
      this.accountRevision++;
      // A running relay connection can outlive its merged local row until the user navigates.
      const known = [...this.state.getState().computers, ...this.connections.values().map((connection) => connection.computer)];
      for (const computer of known) {
        if (computer.gateway !== officialGateway || computer.machine.via !== "account") continue;
        if (this.state.getState().connection?.computer.key === computer.key) this.disconnect();
        this.connections.remove(computer.key);
      }
      for (const [key, computer] of this.localAliases) {
        if (computer.gateway === officialGateway && computer.machine.via === "account") this.localAliases.delete(key);
      }
    }
    this.state.setState((state) => ({
      account: account.email,
      accountUserId: account.userId,
      computers: changed ? this.mergeComputers(state.computers.filter((computer) =>
        computer.gateway !== officialGateway || computer.machine.via !== "account",
      ), state.localComputer) : state.computers,
    }));
    if (!this.releaseLock) return;
    // A duplicate INITIAL_SESSION/TOKEN_REFRESHED event must not cancel a pending account switch.
    if (!changed && (this.accountAuthTimer || this.relays.has(officialGateway))) return;
    if (this.accountAuthTimer) clearTimeout(this.accountAuthTimer);
    const generation = this.generation;
    // Account changes may arrive while RelayClient awaits its token provider. Let that
    // authentication finish before replacing its socket, so an old nonce cannot escape
    // onto the new connection. Coalesce boot/login notifications into one reconnect.
    // Only a different account needs a new gateway connection. A refreshed token for the same
    // one (hourly) is fetched on the next connect anyway; reconnecting for it would drop every
    // open tunnel while they still look online.
    this.accountAuthTimer = setTimeout(() => {
      this.accountAuthTimer = undefined;
      if (!this.releaseLock || generation !== this.generation || account.userId !== this.authUser) return;
      if (changed) this.relays.get(officialGateway)?.reauthenticate();
      if (account.userId) this.relay(officialGateway);
    }, 0);
  }
  private setLocalComputer(computer?: Computer) {
    if (computer) {
      if (this.desktopLocalRetry) clearTimeout(this.desktopLocalRetry);
      this.desktopLocalRetry = undefined;
      this.desktopLocalAttempt = undefined;
    }
    this.state.setState((state) => {
      const previous = state.localComputer ?? state.computers.find((item) => item.key === DESKTOP_LOCAL);
      const local = computer
        ? { ...computer, relayId: computer.relayId ?? (computer.machine.id === previous?.machine.id ? previous.relayId : undefined) }
        : previous ? { ...previous, machine: { ...previous.machine, online: false } } : undefined;
      return {
        localComputer: local,
        computers: this.mergeComputers(state.computers.filter((item) => item.key !== DESKTOP_LOCAL), local),
        localError: computer ? undefined : "本机服务未运行，请在本机服务中启动。",
      };
    });
    if (computer && !this.state.getState().connection && (!this.selected || this.computerForKey(this.selected)?.key === DESKTOP_LOCAL))
      this.select(computer);
  }
  private mergeComputers(computers: Computer[], local: Computer | undefined): Computer[] {
    // Keep the alternate route's presence while it is hidden, so a stopped local socket does
    // not remove the only reachable entry. Pairing records themselves remain untouched.
    for (const [key, alias] of this.localAliases) {
      if (!local?.relayId || alias.machine.id !== local.relayId) this.localAliases.delete(key);
    }
    for (const computer of computers) {
      if (computer.key !== DESKTOP_LOCAL && local?.relayId === computer.machine.id) this.localAliases.set(computer.key, computer);
    }
    const byKey = new Map([...this.localAliases.values(), ...computers].map((computer) => [computer.key, computer]));
    byKey.delete(DESKTOP_LOCAL);
    return deduplicateLocalComputer([...(local ? [local] : []), ...byKey.values()]);
  }
  refreshLocal(): Promise<void> {
    if (!isDesktop || !this.releaseLock) return Promise.resolve();
    if (this.desktopLocalRequest) return this.desktopLocalRequest;
    const generation = this.generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    this.desktopLocalAbort = controller;
    const request = desktopRequest<{ computer?: Computer }>("/desktop/local", {
      signal: controller.signal,
    }).then(({ computer }) => {
      if (generation === this.generation) this.setLocalComputer(computer);
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      this.setLocalComputer(undefined);
      this.state.setState({ localError: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      clearTimeout(timeout);
      if (this.desktopLocalRequest === request) {
        this.desktopLocalRequest = undefined;
        this.desktopLocalAbort = undefined;
      }
      this.retryInitialLocalDiscovery(generation);
    });
    this.desktopLocalRequest = request;
    return request;
  }
  private retryInitialLocalDiscovery(generation: number) {
    if (!this.releaseLock || generation !== this.generation || this.desktopLocalRetry || this.desktopLocalAttempt === undefined) return;
    // A standalone Host starts alongside the workspace and may open its socket a little later.
    const delay = [500, 1_000, 2_000, 4_000, 8_000][this.desktopLocalAttempt++];
    if (delay === undefined) { this.desktopLocalAttempt = undefined; return; }
    this.desktopLocalRetry = setTimeout(() => {
      this.desktopLocalRetry = undefined;
      if (this.releaseLock && generation === this.generation) void this.refreshLocal();
    }, delay);
  }
  private refreshDesktop(): Promise<void> {
    if (this.desktopRefresh) return this.desktopRefresh;
    this.desktopRefresh = Promise.all([
      this.refreshLocal(),
      desktopAccount().then(() => {}, (error) => this.report(error)),
    ]).then(() => {}).finally(() => { this.desktopRefresh = undefined; });
    return this.desktopRefresh;
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
      name: isDesktop ? "LinkShell Desktop" : "LinkShell Web",
      platform: isWindowsDesktop ? "Windows" : isDesktop ? "macOS" : "web",
      token: useAccount
        ? async () => {
            const accountRevision = this.accountRevision;
            const userId = this.authUser;
            try {
              const token = await accountToken(userId);
              if (accountRevision !== this.accountRevision || userId !== this.authUser)
                throw new Error("账号已更新，正在重新连接");
              return token;
            } catch (error) {
              if (accountRevision === this.accountRevision) this.report(error);
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
      const message = error ? relayErrorMessage(error) : undefined;
      const raised = this.relayErrors.get(gateway);
      if (message) this.relayErrors.set(gateway, message);
      else if (status === "online") this.relayErrors.delete(gateway);
      this.state.setState((state) => ({
        relayStatus: { ...state.relayStatus, [gateway]: status },
        ...(message
          ? { error: message }
          : status === "online" && raised !== undefined && state.error === raised
            ? { error: undefined }
            : {}),
      }));
      if (status === "online")
        void this.refresh(gateway).catch((error) => this.report(error));
    });
    relay.on("machines.changed", () => {
      void this.refresh(gateway).catch((error) => this.report(error));
    });
    relay.on("presence", ({ id, online }) => {
      const aliasKey = `${gateway}#${id}`;
      const alias = this.localAliases.get(aliasKey);
      if (alias) this.localAliases.set(aliasKey, { ...alias, machine: { ...alias.machine, online } });
      // A computer that just joined the account is announced before this list knows it.
      if (online && !alias && !this.state.getState().computers.some((item) => item.gateway === gateway && item.machine.id === id)) {
        void this.refresh(gateway).catch((error) => this.report(error));
        return;
      }
      this.state.setState((state) => ({
        computers: this.mergeComputers(state.computers.map((item) =>
          item.gateway === gateway && item.machine.id === id
            ? { ...item, machine: { ...item.machine, online } }
            : item,
        ), state.localComputer),
      }));
    });
    relay.start();
    return relay;
  }
  async refresh(gateway: string) {
    const relay = this.relays.get(gateway);
    if (!relay) return;
    const generation = this.generation;
    const accountUser = this.authUser;
    const accountRevision = this.accountRevision;
    const { machines } = await relay.request("machines.list", {});
    if (generation !== this.generation || relay !== this.relays.get(gateway) ||
        (gateway === officialGateway && (accountUser !== this.authUser || accountRevision !== this.accountRevision))) return;
    const usesAccount = gateway === officialGateway && deployment !== "self-hosted";
    const accountMatches = usesAccount && !!accountUser && relay.account?.userId === accountUser;
    // An offline sign-out can leave the gateway's old account binding intact.
    // Pairings remain usable, but account-only computers require the current authenticated user.
    const found = machines.filter((machine) => machine.via === "paired" || accountMatches).map((machine) => ({
      gateway,
      machine,
      key: `${gateway}#${machine.id}`,
    }));
    for (const [key, alias] of this.localAliases) if (alias.gateway === gateway) this.localAliases.delete(key);
    for (const computer of found) computerNames.remember(computer);
    this.state.setState((state) => ({
      computers: this.mergeComputers([
        ...state.computers.filter((item) => item.gateway !== gateway),
        ...found,
      ], state.localComputer),
    }));
    const state = this.state.getState();
    if (!state.connection) {
      const chosen =
        computerAtKey(state.computers, this.selected, state.localComputer) ??
        state.computers.find((item) => item.machine.online);
      if (chosen) this.select(chosen);
    }
    if (usesAccount && accountUser && !accountMatches)
      this.state.setState({ error: accountBindingError });
    else if (usesAccount && this.state.getState().error === accountBindingError)
      this.state.setState({ error: undefined });
  }
  select(computer: Computer) {
    computer = this.computerForKey(computer.key) ?? computer;
    const selected = this.retainComputer(computer);
    this.disconnect();
    this.releaseSelected = selected.release;
    this.state.setState({ connection: selected.connection, error: undefined });
    this.selected = computer.key;
    saveLocal("selected", computer.key);
  }
  computerForKey(key: string): Computer | undefined {
    const state = this.state.getState();
    return computerAtKey(state.computers, key, state.localComputer);
  }
  retainComputer(computer: Computer, options?: { metadataOnly?: boolean }) {
    if (!this.identity || !this.releaseLock) throw new Error("请先在本标签页启用连接");
    return this.connections.acquire(this.computerForKey(computer.key) ?? computer, options);
  }
  private openComputer(computer: Computer) {
    if (!this.identity) throw new Error("设备身份尚未就绪");
    const identity = this.identity;
    const local = isDesktop && computer.key === DESKTOP_LOCAL && computer.gateway === DESKTOP_LOCAL;
    const relay = local ? undefined : this.relay(computer.gateway);
    const link = new HostLink({
      url: computer.key,
      createSocket: () => local ? desktopHostSocket() as unknown as SocketLike : new TunnelSocket(relay!, identity, computer.machine),
      lazyImages: true,
    });
    const store = createClientStore(link, { lazyImages: true });
    const streams = new HostStreams(link, {
      connector: local ? undefined : browserDirect,
      iceServers: () => store.getState().machine?.direct?.iceServers,
    });
    streams.stop();
    const connection: Connection = { computer, link, store, streams };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.machine === previous.machine) return;
      if (state.machine?.naming) {
        computerNames.sync(computer, state.machine);
        const updated = { ...connection.computer, machine: { ...connection.computer.machine,
          name: state.machine.hostname, namingConfigured: state.machine.naming.configured } };
        connection.computer = updated;
        this.state.setState((current) => ({
          computers: current.computers.map((item) => item.key === computer.key ? { ...item, machine: { ...item.machine,
            name: updated.machine.name, namingConfigured: updated.machine.namingConfigured } } : item),
          connection: current.connection?.computer.key === computer.key ? { ...current.connection, computer: updated } : current.connection,
          localComputer: current.localComputer?.key === computer.key ? { ...current.localComputer,
            machine: { ...current.localComputer.machine, name: updated.machine.name, namingConfigured: updated.machine.namingConfigured } } : current.localComputer,
        }));
      }
      streams.connect();
    });
    store.getState().connect();
    return { connection, close: () => {
      unsubscribe(); streams.stop(); store.getState().disconnect();
    } };
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
    if (computer.key === DESKTOP_LOCAL) throw new Error("本机无需配对，请在本机服务中管理连接");
    await this.relay(computer.gateway).request("machines.forget", {
      machineId: computer.machine.id,
    });
    this.paired = this.paired.filter((item) => item.key !== computer.key);
    saveLocal("paired", this.paired);
    if (this.state.getState().connection?.computer.key === computer.key)
      this.disconnect();
    this.connections.remove(computer.key);
    this.localAliases.delete(computer.key);
    this.state.setState((state) => ({
      computers: this.mergeComputers(state.computers.filter((item) => item.key !== computer.key), state.localComputer),
    }));
  }
  /** Asks every gateway again for its computers (and the desktop for this one), now. */
  async refreshComputers() {
    if (!this.releaseLock) return;
    const work: Promise<unknown>[] = [];
    if (isDesktop) work.push(this.refreshDesktop());
    for (const [gateway, relay] of this.relays) {
      if (relay.status === "online") work.push(this.refresh(gateway));
      else relay.reconnectNow();
    }
    const failed = (await Promise.allSettled(work)).find((result) => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }
  reconnect() {
    if (!this.releaseLock) return;
    if (isDesktop) {
      void retryDesktopStorage();
      void this.refreshDesktop();
    }
    for (const relay of this.relays.values()) relay.reconnectNow();
    for (const connection of this.connections.values()) connection.link.reconnectNow();
  }
  disconnect() {
    this.releaseSelected?.();
    this.releaseSelected = undefined;
    this.state.setState({ connection: undefined });
  }
  stop() {
    this.generation++;
    if (this.desktopLocalRetry) clearTimeout(this.desktopLocalRetry);
    this.desktopLocalRetry = undefined;
    this.desktopLocalAttempt = undefined;
    this.desktopLocalAbort?.abort();
    this.desktopLocalAbort = undefined;
    this.desktopLocalRequest = undefined;
    if (this.desktopPoll) clearInterval(this.desktopPoll);
    this.desktopPoll = undefined;
    if (this.accountAuthTimer) clearTimeout(this.accountAuthTimer);
    this.accountAuthTimer = undefined;
    this.disconnect();
    this.connections.clear();
    for (const relay of this.relays.values()) relay.stop();
    this.relays.clear();
    this.releaseLock?.();
    this.releaseLock = undefined;
  }
}
export const engine = new BrowserEngine();

if (import.meta.hot) import.meta.hot.dispose(() => engine.stop());
