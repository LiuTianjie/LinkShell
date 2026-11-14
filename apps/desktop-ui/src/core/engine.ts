import { createStore } from "zustand/vanilla";
import {
  HostLink,
  HostStreams,
  TunnelSocket,
  createClientStore,
  fetchProMembership,
  fetchReferralSummary,
  pairByCode,
  pairByLink,
  type Locale,
  type ProMembership,
  type ReferralSummary,
  type SocketLike,
} from "@linkshell/client-core";
import {
  RELAY_PATH,
  RelayClient,
  decodePairingLink,
  type Identity,
  type RelaySocket,
} from "@linkshell/wire";
import { desktopHostWsUrl, desktopPlatform, isElectronDesktop } from "../bridge/desktop-bridge";
import {
  ComputerConnections,
  SessionSubscriptions,
  computerAtKey,
  computerNames,
  deduplicateLocalComputer,
  type Computer,
  type Connection,
} from "./connections";
import { browserDirect } from "./direct";
import { sessionPreferences } from "./session-preferences";
import {
  DESKTOP_ACCOUNT_EVENT,
  DESKTOP_ERROR_EVENT,
  DESKTOP_HOST_EVENT,
  DESKTOP_LOCAL,
  DESKTOP_VISIBILITY_EVENT,
  STORAGE_KEYS,
  bootstrapDesktopStorage,
  bootstrappedLocalComputer,
  fetchDesktopAccount,
  fetchDesktopLocalComputer,
  loadDeviceIdentity,
  readLocal,
  retryDesktopStorage,
  saveLocal,
  type DesktopSidecarAccount,
} from "./storage";

export type { Computer, Connection };
export type GatewaySource = "official" | "self-hosted";

export const OFFICIAL_GATEWAY = "wss://gateway.itool.tech";
const SUPABASE_URL = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rYmV1c3p0a3pmZm56amR3bXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5Nzc0NzgsImV4cCI6MjA4MTU1MzQ3OH0.2wlT6q6687Z5rpEYsdp01IQpNNl_XWv0IAfBgwPyDP0";
const ACCOUNT_BINDING_ERROR = "网关未确认当前账号，请退出账号后重新登录。";

export function validateGateway(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的网关地址，例如 wss://gateway.example.com");
  }
  if (!["wss:", "ws:"].includes(url.protocol)) {
    throw new Error("网关地址需要以 wss:// 开头");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("网关地址不能包含账号、密码、查询参数或片段");
  }
  if (url.pathname !== "/" && url.pathname !== "/v2/connect") {
    throw new Error("请输入网关根地址，不需要附加路径");
  }
  const pageHttps = typeof location !== "undefined" && location.protocol === "https:";
  if (
    url.protocol === "ws:" &&
    (pageHttps || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("请使用 wss:// 安全连接；ws:// 仅限本地 HTTP 开发环境");
  }
  return url.origin;
}

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

function relayPlatformLabel(): string {
  if (desktopPlatform === "windows") return "Windows";
  if (desktopPlatform === "macos") return "macOS";
  return "Linux";
}

export interface EngineState {
  source: GatewaySource;
  gateway: string;
  computers: Computer[];
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

export class DesktopEngine {
  readonly state = createStore<EngineState>(() => {
    const savedSource = readLocal<GatewaySource>(STORAGE_KEYS.source, "official");
    const savedGateway =
      savedSource === "official"
        ? OFFICIAL_GATEWAY
        : readLocal<string>(STORAGE_KEYS.gateway, OFFICIAL_GATEWAY);
    return {
      source: savedSource,
      gateway: savedGateway,
      computers: [],
      relayStatus: {},
      locked: false,
      ready: false,
    };
  });

  private identity?: Identity;
  private readonly relays = new Map<string, RelayClient>();
  private readonly relayErrors = new Map<string, string>();
  private paired: Computer[] = readLocal<Computer[]>(STORAGE_KEYS.paired, []);
  private readonly localAliases = new Map<string, Computer>();
  private selected: string = readLocal<string>(STORAGE_KEYS.selected, "");
  private active = false;
  private starting?: Promise<void>;
  private authUser?: string;
  private pendingAccountFrom?: string | null;
  private accountRevision = 0;
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

  constructor(options?: { attachWindowListeners?: boolean }) {
    if (options?.attachWindowListeners !== false && typeof window !== "undefined") {
      window.addEventListener(DESKTOP_ERROR_EVENT, (event) =>
        this.report((event as CustomEvent<string>).detail),
      );
      window.addEventListener(DESKTOP_ACCOUNT_EVENT, (event) =>
        this.applyAccount((event as CustomEvent<DesktopSidecarAccount>).detail),
      );
      window.addEventListener(DESKTOP_HOST_EVENT, () => this.onDesktopHostChanged());
      window.addEventListener(DESKTOP_VISIBILITY_EVENT, (event) => {
        if ((event as CustomEvent<{ visible?: boolean }>).detail?.visible) this.reconnect();
      });
      window.addEventListener("pagehide", () => this.stop());
      window.addEventListener("pageshow", () => {
        void this.start();
      });
      window.addEventListener("online", () => this.reconnect());
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) this.reconnect();
        });
      }
    }
  }

  report(error: unknown): void {
    this.state.setState({
      error: error instanceof Error ? error.message : String(error),
    });
  }

  clearError(): void {
    this.state.setState({ error: undefined });
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (this.starting) return this.starting;
    this.starting = this.boot()
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private async boot(): Promise<void> {
    const generation = ++this.generation;
    await bootstrapDesktopStorage();
    this.identity = await loadDeviceIdentity();
    if (generation !== this.generation) return;

    this.active = true;
    this.paired = readLocal<Computer[]>(STORAGE_KEYS.paired, []);
    this.selected = readLocal<string>(STORAGE_KEYS.selected, "");
    const savedSource = readLocal<GatewaySource>(STORAGE_KEYS.source, "official");
    const savedGateway =
      savedSource === "official"
        ? OFFICIAL_GATEWAY
        : readLocal<string>(STORAGE_KEYS.gateway, OFFICIAL_GATEWAY);

    this.localAliases.clear();
    this.state.setState({
      source: savedSource,
      gateway: savedGateway,
      localComputer: undefined,
      computers: this.paired.map((item) => ({
        ...item,
        machine: { ...item.machine, online: false },
      })),
      locked: false,
      ready: true,
    });

    const initialLocal = bootstrappedLocalComputer();
    if (initialLocal) this.setLocalComputer(initialLocal);
    else this.desktopLocalAttempt = 0;

    if (isElectronDesktop) {
      this.desktopPoll = setInterval(() => {
        void this.refreshDesktop();
      }, 30_000);
      void this.refreshDesktop();
    }

    for (const item of this.paired) this.relay(item.gateway);
    if (savedSource === "official") {
      await this.connectAccount();
    } else if (savedGateway) {
      this.relay(validateGateway(savedGateway));
    }
  }

  async connectAccount(): Promise<void> {
    const account = await fetchDesktopAccount();
    this.applyAccount(account);
    this.state.setState({ source: "official", gateway: OFFICIAL_GATEWAY });
    saveLocal(STORAGE_KEYS.source, "official");
  }

  private applyAccount(account: Pick<DesktopSidecarAccount, "userId" | "email">): void {
    const previousUser = this.authUser;
    const changed = previousUser !== account.userId;
    this.authUser = account.userId;
    if (changed) {
      if (this.pendingAccountFrom === undefined) this.pendingAccountFrom = previousUser ?? null;
      this.accountRevision++;
      const known = [
        ...this.state.getState().computers,
        ...this.connections.values().map((connection) => connection.computer),
      ];
      for (const computer of known) {
        if (computer.gateway !== OFFICIAL_GATEWAY || computer.machine.via !== "account") continue;
        if (this.state.getState().connection?.computer.key === computer.key) this.disconnect();
        this.connections.remove(computer.key);
      }
      for (const [key, computer] of this.localAliases) {
        if (computer.gateway === OFFICIAL_GATEWAY && computer.machine.via === "account") {
          this.localAliases.delete(key);
        }
      }
    }
    this.state.setState((state) => ({
      account: account.email,
      accountUserId: account.userId,
      computers: changed
        ? this.mergeComputers(
            state.computers.filter(
              (computer) => computer.gateway !== OFFICIAL_GATEWAY || computer.machine.via !== "account",
            ),
            state.localComputer,
          )
        : state.computers,
    }));
    if (!this.active) return;
    if (!changed && (this.accountAuthTimer || this.relays.has(OFFICIAL_GATEWAY))) return;
    if (this.accountAuthTimer) clearTimeout(this.accountAuthTimer);
    const generation = this.generation;
    this.accountAuthTimer = setTimeout(() => {
      this.accountAuthTimer = undefined;
      const fromUser = this.pendingAccountFrom;
      this.pendingAccountFrom = undefined;
      if (!this.active || generation !== this.generation || account.userId !== this.authUser) return;
      const relay = this.relays.get(OFFICIAL_GATEWAY);
      if (fromUser !== undefined && relay) {
        const revision = this.accountRevision;
        const leaving =
          fromUser && !account.userId && relay.status === "online"
            ? relay.request("account.leave", {}, 5_000).catch(() => undefined)
            : Promise.resolve(undefined);
        void leaving.then(() => {
          if (!this.active || generation !== this.generation || revision !== this.accountRevision) return;
          if (this.relays.get(OFFICIAL_GATEWAY) === relay) relay.reauthenticate();
          if (account.userId) this.relay(OFFICIAL_GATEWAY);
        });
        return;
      }
      if (account.userId) this.relay(OFFICIAL_GATEWAY);
    }, 0);
  }

  private onDesktopHostChanged(): void {
    if (!this.active) return;
    if (this.desktopLocalRetry) clearTimeout(this.desktopLocalRetry);
    this.desktopLocalRetry = undefined;
    this.desktopLocalAttempt = 0;
    void this.refreshDesktop();
    for (const connection of this.connections.values()) {
      connection.link.reconnectNow();
    }
  }

  private setLocalComputer(computer?: Computer): void {
    if (computer) {
      if (this.desktopLocalRetry) clearTimeout(this.desktopLocalRetry);
      this.desktopLocalRetry = undefined;
      this.desktopLocalAttempt = undefined;
    }
    const localOnline =
      !computer &&
      this.connections
        .values()
        .some((connection) => connection.computer.key === DESKTOP_LOCAL && connection.link.status === "online");
    this.state.setState((state) => {
      const previous = state.localComputer ?? state.computers.find((item) => item.key === DESKTOP_LOCAL);
      const local = computer
        ? {
            ...computer,
            relayId:
              computer.relayId ?? (computer.machine.id === previous?.machine.id ? previous.relayId : undefined),
          }
        : previous
          ? { ...previous, machine: { ...previous.machine, online: Boolean(localOnline) } }
          : undefined;
      return {
        localComputer: local,
        computers: this.mergeComputers(
          state.computers.filter((item) => item.key !== DESKTOP_LOCAL),
          local,
        ),
        localError: computer || localOnline ? undefined : "本机服务未运行，请在本机管理中启动。",
      };
    });
    if (
      computer &&
      !this.state.getState().connection &&
      (!this.selected || this.computerForKey(this.selected)?.key === DESKTOP_LOCAL)
    ) {
      this.select(computer);
    }
  }

  private mergeComputers(computers: Computer[], local: Computer | undefined): Computer[] {
    for (const [key, alias] of this.localAliases) {
      if (!local?.relayId || alias.machine.id !== local.relayId) this.localAliases.delete(key);
    }
    for (const computer of computers) {
      if (computer.key !== DESKTOP_LOCAL && local?.relayId === computer.machine.id) {
        this.localAliases.set(computer.key, computer);
      }
    }
    const byKey = new Map(
      [...this.localAliases.values(), ...computers].map((computer) => [computer.key, computer]),
    );
    byKey.delete(DESKTOP_LOCAL);
    return deduplicateLocalComputer([...(local ? [local] : []), ...byKey.values()]);
  }

  refreshLocal(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.desktopLocalRequest) return this.desktopLocalRequest;
    const generation = this.generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    this.desktopLocalAbort = controller;
    const request = fetchDesktopLocalComputer(controller.signal)
      .then((computer) => {
        if (generation === this.generation) this.setLocalComputer(computer);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.setLocalComputer(undefined);
        this.state.setState({ localError: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
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

  private retryInitialLocalDiscovery(generation: number): void {
    if (
      !this.active ||
      generation !== this.generation ||
      this.desktopLocalRetry ||
      this.desktopLocalAttempt === undefined
    ) {
      return;
    }
    const delay = [500, 1_000, 2_000, 4_000, 8_000][this.desktopLocalAttempt++];
    if (delay === undefined) {
      this.desktopLocalAttempt = undefined;
      return;
    }
    this.desktopLocalRetry = setTimeout(() => {
      this.desktopLocalRetry = undefined;
      if (this.active && generation === this.generation) void this.refreshLocal();
    }, delay);
  }

  private refreshDesktop(): Promise<void> {
    if (this.desktopRefresh) return this.desktopRefresh;
    this.desktopRefresh = Promise.all([
      this.refreshLocal(),
      fetchDesktopAccount().then(
        () => {},
        (error: unknown) => this.report(error),
      ),
    ])
      .then(() => {})
      .finally(() => {
        this.desktopRefresh = undefined;
      });
    return this.desktopRefresh;
  }

  private async resolveAccountToken(expectedUserId?: string): Promise<string | undefined> {
    const account = await fetchDesktopAccount();
    if (expectedUserId !== undefined) {
      if (!account.userId) throw new Error("登录已失效，请重新登录");
      if (account.userId !== expectedUserId) throw new Error("账号已切换，请在当前账户下重新操作");
    }
    return account.accessToken;
  }

  relay(address: string): RelayClient {
    if (!this.identity || !this.active) {
      throw new Error("桌面连接引擎尚未就绪");
    }
    const gateway = validateGateway(address);
    const existing = this.relays.get(gateway);
    if (existing) return existing;
    const useAccount = gateway === OFFICIAL_GATEWAY;
    const relay = new RelayClient({
      url: gateway + RELAY_PATH,
      identity: this.identity,
      role: "device",
      name: "LinkShell Desktop",
      platform: relayPlatformLabel(),
      token: useAccount
        ? async () => {
            const accountRevision = this.accountRevision;
            const userId = this.authUser;
            try {
              const token = await this.resolveAccountToken(userId);
              if (accountRevision !== this.accountRevision || userId !== this.authUser) {
                throw new Error("账号已更新，正在重新连接");
              }
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
      if (status === "online") {
        for (const connection of this.connections.values()) {
          if (connection.computer.gateway === gateway) connection.link.reconnectNow();
        }
        void this.refresh(gateway).catch((err: unknown) => this.report(err));
      }
    });

    relay.on("machines.changed", () => {
      void this.refresh(gateway).catch((err: unknown) => this.report(err));
    });

    relay.on("presence", ({ id, online }) => {
      if (online) {
        for (const connection of this.connections.values()) {
          if (connection.computer.gateway === gateway && connection.computer.machine.id === id) {
            connection.link.reconnectNow();
          }
        }
      }
      const aliasKey = `${gateway}#${id}`;
      const alias = this.localAliases.get(aliasKey);
      if (alias) this.localAliases.set(aliasKey, { ...alias, machine: { ...alias.machine, online } });
      if (
        online &&
        !alias &&
        !this.state.getState().computers.some((item) => item.gateway === gateway && item.machine.id === id)
      ) {
        void this.refresh(gateway).catch((err: unknown) => this.report(err));
        return;
      }
      this.state.setState((state) => ({
        computers: this.mergeComputers(
          state.computers.map((item) =>
            item.gateway === gateway && item.machine.id === id
              ? { ...item, machine: { ...item.machine, online } }
              : item,
          ),
          state.localComputer,
        ),
      }));
    });

    relay.start();
    return relay;
  }

  async refresh(gateway: string): Promise<void> {
    const relay = this.relays.get(gateway);
    if (!relay) return;
    const generation = this.generation;
    const accountUser = this.authUser;
    const accountRevision = this.accountRevision;
    const { machines } = await relay.request("machines.list", {});
    if (
      generation !== this.generation ||
      relay !== this.relays.get(gateway) ||
      (gateway === OFFICIAL_GATEWAY && (accountUser !== this.authUser || accountRevision !== this.accountRevision))
    ) {
      return;
    }
    const usesAccount = gateway === OFFICIAL_GATEWAY;
    const accountMatches = usesAccount && Boolean(accountUser) && relay.account?.userId === accountUser;
    const found = machines
      .filter((machine) => machine.via === "paired" || accountMatches)
      .map((machine) => ({
        gateway,
        machine,
        key: `${gateway}#${machine.id}`,
      }));
    for (const [key, alias] of this.localAliases) {
      if (alias.gateway === gateway) this.localAliases.delete(key);
    }
    for (const computer of found) computerNames.remember(computer);
    this.state.setState((state) => ({
      computers: this.mergeComputers(
        [...state.computers.filter((item) => item.gateway !== gateway), ...found],
        state.localComputer,
      ),
    }));
    const current = this.state.getState();
    if (!current.connection) {
      const chosen =
        computerAtKey(current.computers, this.selected, current.localComputer) ??
        current.computers.find((item) => item.machine.online);
      if (chosen) this.select(chosen);
    }
    if (usesAccount && accountUser && !accountMatches) {
      this.state.setState({ error: ACCOUNT_BINDING_ERROR });
    } else if (usesAccount && this.state.getState().error === ACCOUNT_BINDING_ERROR) {
      this.state.setState({ error: undefined });
    }
  }

  select(computer: Computer): void {
    const resolved = this.computerForKey(computer.key) ?? computer;
    const active = this.state.getState().connection;
    if (active?.computer.key === resolved.key) {
      this.selected = resolved.key;
      saveLocal(STORAGE_KEYS.selected, resolved.key);
      saveLocal(STORAGE_KEYS.currentComputer, resolved.key);
      this.state.setState({ error: undefined });
      active.link.reconnectNow();
      return;
    }
    const retained = this.retainComputer(resolved);
    this.disconnect();
    this.releaseSelected = retained.release;
    this.state.setState({ connection: retained.connection, error: undefined });
    this.selected = resolved.key;
    saveLocal(STORAGE_KEYS.selected, resolved.key);
    saveLocal(STORAGE_KEYS.currentComputer, resolved.key);
  }

  computerForKey(key: string): Computer | undefined {
    const state = this.state.getState();
    return computerAtKey(state.computers, key, state.localComputer);
  }

  retainComputer(computer: Computer, options?: { metadataOnly?: boolean }) {
    if (!this.identity || !this.active) throw new Error("桌面连接引擎尚未就绪");
    return this.connections.acquire(this.computerForKey(computer.key) ?? computer, options);
  }

  private openComputer(computer: Computer): { connection: Connection; close: () => void } {
    if (!this.identity) throw new Error("设备身份尚未就绪");
    const identity = this.identity;
    const local = computer.key === DESKTOP_LOCAL && computer.gateway === DESKTOP_LOCAL;
    const relay = local ? undefined : this.relay(computer.gateway);
    const tokenKey = STORAGE_KEYS.accessToken(computer.key);
    const link = new HostLink({
      url: computer.key,
      createSocket: () => {
        if (local) {
          const wsUrl = desktopHostWsUrl();
          if (!wsUrl) throw new Error("桌面连接已失效，请重新打开窗口");
          return new WebSocket(wsUrl) as unknown as SocketLike;
        }
        return new TunnelSocket(relay!, identity, computer.machine);
      },
      lazyImages: true,
      accessToken: local
        ? undefined
        : {
            load: () => {
              const saved = readLocal<string>(tokenKey, "");
              return saved || undefined;
            },
            save: (token) => {
              saveLocal(tokenKey, token ?? undefined);
            },
          },
    });
    const store = createClientStore(link, { lazyImages: true, sessionPreferences });
    const sessions = new SessionSubscriptions(store);
    const streams = new HostStreams(link, {
      connector: local ? undefined : browserDirect,
      iceServers: () => store.getState().machine?.direct?.iceServers,
    });
    streams.stop();
    const connection: Connection = { computer, link, store, streams, sessions };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.machine === previous.machine) return;
      if (state.machine?.naming) {
        computerNames.sync(computer, state.machine);
        const updated: Computer = {
          ...connection.computer,
          machine: {
            ...connection.computer.machine,
            name: state.machine.hostname,
            namingConfigured: state.machine.naming.configured,
          },
        };
        connection.computer = updated;
        this.state.setState((current) => ({
          computers: current.computers.map((item) =>
            item.key === computer.key
              ? {
                  ...item,
                  machine: {
                    ...item.machine,
                    name: updated.machine.name,
                    namingConfigured: updated.machine.namingConfigured,
                  },
                }
              : item,
          ),
          connection:
            current.connection?.computer.key === computer.key
              ? { ...current.connection, computer: updated }
              : current.connection,
          localComputer:
            current.localComputer?.key === computer.key
              ? {
                  ...current.localComputer,
                  machine: {
                    ...current.localComputer.machine,
                    name: updated.machine.name,
                    namingConfigured: updated.machine.namingConfigured,
                  },
                }
              : current.localComputer,
        }));
      }
      streams.connect();
    });
    store.getState().connect();
    return {
      connection,
      close: () => {
        sessions.close();
        unsubscribe();
        streams.stop();
        store.getState().disconnect();
      },
    };
  }

  async pair(address: string, codeOrLink: string): Promise<Computer> {
    const trimmed = codeOrLink.trim();
    const link = trimmed.startsWith("linkshell:") ? decodePairingLink(trimmed) : undefined;
    if (trimmed.startsWith("linkshell:") && !link) {
      throw new Error("配对链接格式不正确");
    }
    if (!link && !/^\d{6}$/.test(trimmed)) {
      throw new Error("请输入 6 位配对码");
    }
    const gateway = validateGateway((link?.gateway ?? address).replace(/^http/, "ws"));
    const relay = this.relay(gateway);
    const machine = link
      ? await pairByLink(relay, this.identity!, link)
      : await pairByCode(relay, this.identity!, trimmed);
    const computer: Computer = { key: `${gateway}#${machine.id}`, gateway, machine };
    this.paired = [...this.paired.filter((item) => item.key !== computer.key), computer];
    saveLocal(STORAGE_KEYS.paired, this.paired);
    saveLocal(STORAGE_KEYS.source, "self-hosted");
    saveLocal(STORAGE_KEYS.gateway, gateway);
    this.state.setState({ source: "self-hosted", gateway });
    await this.refresh(gateway);
    this.select(computer);
    return computer;
  }

  async forget(computer: Computer): Promise<void> {
    if (computer.key === DESKTOP_LOCAL) {
      throw new Error("本机无需配对，请在本机管理中查看或停止服务");
    }
    await this.relay(computer.gateway).request("machines.forget", {
      machineId: computer.machine.id,
    });
    this.paired = this.paired.filter((item) => item.key !== computer.key);
    saveLocal(STORAGE_KEYS.paired, this.paired);
    saveLocal(STORAGE_KEYS.accessToken(computer.key), undefined);
    if (this.state.getState().connection?.computer.key === computer.key) {
      this.disconnect();
    }
    this.connections.remove(computer.key);
    this.localAliases.delete(computer.key);
    this.state.setState((state) => ({
      computers: this.mergeComputers(
        state.computers.filter((item) => item.key !== computer.key),
        state.localComputer,
      ),
    }));
  }

  async refreshComputers(): Promise<void> {
    if (!this.active) return;
    const work: Promise<unknown>[] = [];
    if (isElectronDesktop) work.push(this.refreshDesktop());
    for (const [gateway, relay] of this.relays) {
      if (relay.status === "online") work.push(this.refresh(gateway));
      else relay.reconnectNow();
    }
    const failed = (await Promise.allSettled(work)).find((result) => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  reconnect(): void {
    if (!this.active) return;
    if (isElectronDesktop) {
      void retryDesktopStorage();
      void this.refreshDesktop();
    }
    for (const relay of this.relays.values()) {
      relay.probe?.();
      relay.reconnectNow();
    }
    for (const connection of this.connections.values()) {
      void connection.link.probe?.();
      connection.link.reconnectNow();
      connection.streams.connect();
    }
  }

  disconnect(): void {
    this.releaseSelected?.();
    this.releaseSelected = undefined;
    this.state.setState({ connection: undefined });
  }

  stop(): void {
    this.generation++;
    this.active = false;
    this.pendingAccountFrom = undefined;
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
  }
}

export const engine = new DesktopEngine();

export async function fetchDesktopProMembership(expectedUserId: string): Promise<ProMembership> {
  const account = await fetchDesktopAccount();
  if (!account.userId || account.userId !== expectedUserId || !account.accessToken) {
    throw new Error("登录已失效，请重新登录");
  }
  const membership = await fetchProMembership({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    accessToken: account.accessToken,
    userId: expectedUserId,
  });
  const after = await fetchDesktopAccount();
  if (!after.userId || after.userId !== expectedUserId) {
    throw new Error("账号已切换，请在当前账户下重新操作");
  }
  return membership;
}

export async function fetchDesktopReferralSummary(
  expectedUserId: string,
  locale?: Locale,
): Promise<ReferralSummary> {
  const account = await fetchDesktopAccount();
  if (!account.userId || account.userId !== expectedUserId || !account.accessToken) {
    throw new Error("登录已失效，请重新登录");
  }
  const referral = await fetchReferralSummary({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    accessToken: account.accessToken,
    userId: expectedUserId,
    locale,
  });
  const after = await fetchDesktopAccount();
  if (!after.userId || after.userId !== expectedUserId) {
    throw new Error("账号已切换，请在当前账户下重新操作");
  }
  return referral;
}
