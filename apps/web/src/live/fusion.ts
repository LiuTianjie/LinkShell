import type { HostLink, HostStream, HostStreams } from "@linkshell/client-core";
import { computerName, computerNames } from "./computer-names";
import { DESKTOP_LOCAL, desktopInvoke, isElectronDesktop, isWindowsDesktop, postDesktopMessage, reportDesktopError } from "./desktop";
import { engine, type Computer } from "./engine";

const FUSION_TUNNEL_EVENT = "linkshell-fusion-tunnel";

type FusionStartReply =
  | { mode: "direct"; host: string; port: number }
  | { mode: "tunnel"; tunnelId: string; port: number };

interface TunnelEventDetail {
  tunnelId?: string;
  connId?: string;
  type?: "open" | "data" | "close";
  data?: string;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const activeTunnelBridges = new Map<string, { dispose(): void }>();

function attachTunnelBridge(tunnelId: string, remotePort: number, streams: HostStreams, releaseConnection?: () => void) {
  activeTunnelBridges.get(tunnelId)?.dispose();

  type ConnEntry = {
    closed: boolean;
    pending: Uint8Array[];
    stream?: HostStream;
  };
  const conns = new Map<string, ConnEntry>();

  const listener = (raw: Event) => {
    const detail = ((raw as CustomEvent<TunnelEventDetail>).detail ?? {});
    if (detail.tunnelId !== tunnelId || !detail.connId) return;
    const connId = detail.connId;
    if (detail.type === "open") {
      const entry: ConnEntry = { closed: false, pending: [] };
      conns.set(connId, entry);
      void streams.open(remotePort, {
        data(bytes) {
          if (entry.closed) return;
          postDesktopMessage({ action: "fusionTunnel", tunnelId, connId, type: "data", data: encodeBase64(bytes) });
        },
        closed() {
          if (entry.closed) return;
          entry.closed = true;
          conns.delete(connId);
          postDesktopMessage({ action: "fusionTunnel", tunnelId, connId, type: "close" });
        },
      }).then((stream) => {
        if (entry.closed) {
          stream.close();
          return;
        }
        entry.stream = stream;
        for (const chunk of entry.pending) stream.write(chunk);
        entry.pending.length = 0;
      }).catch(() => {
        if (entry.closed) return;
        entry.closed = true;
        conns.delete(connId);
        postDesktopMessage({ action: "fusionTunnel", tunnelId, connId, type: "close" });
      });
      return;
    }
    const entry = conns.get(connId);
    if (!entry || entry.closed) return;
    if (detail.type === "data" && typeof detail.data === "string") {
      const bytes = decodeBase64(detail.data);
      if (entry.stream) entry.stream.write(bytes);
      else if (entry.pending.length < 256) entry.pending.push(bytes);
    } else if (detail.type === "close") {
      entry.closed = true;
      conns.delete(connId);
      entry.stream?.close();
    }
  };

  window.addEventListener(FUSION_TUNNEL_EVENT, listener);
  activeTunnelBridges.set(tunnelId, {
    dispose() {
      window.removeEventListener(FUSION_TUNNEL_EVENT, listener);
      for (const entry of conns.values()) {
        entry.closed = true;
        entry.stream?.close();
      }
      conns.clear();
      releaseConnection?.();
    },
  });
}

export function canUseFusionMode(computerKey: string | undefined, platform?: string): boolean {
  return isElectronDesktop && !isWindowsDesktop && Boolean(computerKey) && computerKey !== DESKTOP_LOCAL && platform === "darwin";
}

export async function startComputerFusion({
  computerKey,
  name,
  link,
  streams,
  launchBundle,
  releaseConnection,
}: {
  computerKey: string;
  name: string;
  link: HostLink;
  streams: HostStreams;
  launchBundle?: string;
  releaseConnection?: () => void;
}): Promise<FusionStartReply> {
  let started: { port: number; token: string; hosts: string[] };
  try {
    started = await link.call("fusion.start", {});
  } catch (error) {
    releaseConnection?.();
    const msg = error instanceof Error ? error.message : String(error);
    if (/method not found|fusion\.start|-32601/i.test(msg)) {
      throw new Error("远端电脑的 LinkShell 版本较旧，请先更新远端 LinkShell 后再开启融合模式", { cause: error });
    }
    throw error;
  }
  try {
    const reply = await desktopInvoke<FusionStartReply>("fusionStart", {
      computerKey,
      name,
      port: started.port,
      token: started.token,
      hosts: started.hosts,
      ...(launchBundle ? { launchBundle } : {}),
    }, 20_000);
    if (reply.mode === "tunnel") {
      attachTunnelBridge(reply.tunnelId, started.port, streams, releaseConnection);
    } else {
      releaseConnection?.();
    }
    return reply;
  } catch (error) {
    releaseConnection?.();
    throw error;
  }
}

function waitForOnlineComputer(computerKey: string, timeoutMs = 12_000): Promise<Computer> {
  const immediate = engine.computerForKey(computerKey);
  if (immediate?.machine.online) return Promise.resolve(immediate);
  return new Promise<Computer>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      const found = engine.computerForKey(computerKey);
      reject(new Error(found ? `「${computerName(found, computerNames.store.getState())}」当前离线，无法打开融合应用` : "未找到对应的远端电脑，请先打开 LinkShell 检查连接"));
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

function waitForConnectionOnline(store: { getState(): { status: string; statusDetail?: string }; subscribe(listener: () => void): () => void }, timeoutMs = 12_000): Promise<void> {
  if (store.getState().status === "online") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      const current = store.getState();
      reject(new Error(current.status === "locked" ? "远端电脑设置了访问密码，请先在 LinkShell 中解锁" : current.statusDetail || "连接远端电脑超时，请检查网络或网关状态"));
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

export async function connectAndStartComputerFusion(computerKey: string, launchBundle?: string): Promise<void> {
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
    await startComputerFusion({
      computerKey: computer.key,
      name,
      link: retained.connection.link,
      streams: retained.connection.streams,
      launchBundle,
      releaseConnection: retained.release,
    });
  } catch (error) {
    reportDesktopError(error);
  }
}
