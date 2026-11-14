import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { ClientState } from "@linkshell/client-core";
import type { MachineInfo } from "@linkshell/wire";
import {
  DESKTOP_VISIBILITY_EVENT,
  getActiveDesktopPlatform,
  getShellVisible,
  isElectronRuntime,
} from "../../bridge/desktop-bridge";
import type { FusionCapabilityEnv } from "../../core/fusion-store";

export function resolveLocalDesktopEnv(): Required<FusionCapabilityEnv> {
  return {
    electron: isElectronRuntime(),
    localPlatform: getActiveDesktopPlatform(),
  };
}
import {
  computerAtKey,
  computerName,
  computerNames,
  type Computer,
  type Connection,
} from "../../core/connections";
import { engine } from "../../core/engine";
import { thisComputerLabel, useI18n } from "../../core/i18n";
import { DESKTOP_LOCAL } from "../../core/storage";
import type { DesktopIconName } from "../../icons";
import type { StatusDotTone } from "../../primitives";

export interface ResolvedRemoteComputer {
  computer?: Computer;
  connection?: Connection;
  displayName: string;
  remotePlatform?: string;
  platformIcon: DesktopIconName;
  online: boolean;
  linkStatus: string;
  statusTone: StatusDotTone;
  machineInfo?: MachineInfo;
}

export function platformIconFor(platform?: string): DesktopIconName {
  if (platform === "darwin" || platform === "macos") return "computer-mac";
  if (platform === "win32" || platform === "windows") return "computer-pc";
  if (platform === "linux") return "computer-linux";
  return "computer-pc";
}

function subscribeConnectionStore(
  connection: Connection | undefined,
  onStoreChange: () => void,
): () => void {
  if (!connection) return () => {};
  return connection.store.subscribe(onStoreChange);
}

export function useRemoteComputer(
  computerKey: string,
  options?: { retainStreams?: boolean },
): ResolvedRemoteComputer {
  const { locale } = useI18n();
  const engineState = useStore(engine.state);
  const names = useStore(computerNames.store);
  const retainStreams = options?.retainStreams ?? false;

  const computer = useMemo(() => {
    const matched = computerAtKey(
      engineState.computers,
      computerKey,
      engineState.localComputer,
    );
    if (matched) return matched;
    if (engineState.connection?.computer.key === computerKey) {
      return engineState.connection.computer;
    }
    return undefined;
  }, [
    computerKey,
    engineState.computers,
    engineState.localComputer,
    engineState.connection,
  ]);

  const computerRef = useRef<Computer | undefined>(computer);
  computerRef.current = computer;
  const resolvedComputerKey = computer?.key;
  const hasComputer = Boolean(computer);

  const [retainedConnection, setRetainedConnection] = useState<
    Connection | undefined
  >(undefined);

  useEffect(() => {
    const target = computerRef.current;
    if (!retainStreams || !hasComputer || !target) {
      setRetainedConnection(undefined);
      return undefined;
    }
    try {
      const retained = engine.retainComputer(target, { metadataOnly: false });
      setRetainedConnection(retained.connection);
      return () => {
        retained.release();
      };
    } catch {
      // Engine may not be booted when unit tests populate `engine.state` directly.
      setRetainedConnection(undefined);
      return undefined;
    }
  }, [resolvedComputerKey, hasComputer, retainStreams]);

  const activeMatchingConnection =
    engineState.connection &&
    (engineState.connection.computer.key === computerKey ||
      (computer && engineState.connection.computer.key === computer.key))
      ? engineState.connection
      : undefined;

  const connection = retainedConnection ?? activeMatchingConnection;

  const clientState = useSyncExternalStore<ClientState | undefined>(
    (listener) => subscribeConnectionStore(connection, listener),
    () => connection?.store.getState(),
    () => undefined,
  );

  const displayName = useMemo(() => {
    if (!computer) {
      return computerKey === DESKTOP_LOCAL
        ? thisComputerLabel(locale)
        : computerKey;
    }
    if (computer.key === DESKTOP_LOCAL && !computer.machine.namingConfigured) {
      return computer.machine.name || thisComputerLabel(locale);
    }
    return computerName(computer, names);
  }, [computer, computerKey, locale, names]);

  const remotePlatform =
    clientState?.machine?.platform ?? computer?.machine.platform;
  const linkStatus = clientState?.status ?? (computer?.machine.online ? "online" : "offline");
  const online = Boolean(
    clientState?.status === "online" || computer?.machine.online,
  );
  const statusTone: StatusDotTone =
    clientState?.status === "connecting"
      ? "waiting"
      : online
        ? "ok"
        : "offline";

  return {
    computer,
    connection,
    displayName,
    remotePlatform,
    platformIcon: platformIconFor(remotePlatform),
    online,
    linkStatus,
    statusTone,
    machineInfo: clientState?.machine,
  };
}

/** Tracks whether the desktop window & document are currently visible so remote video pauses cleanly when hidden. */
export function useRemoteWindowVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof document !== "undefined" && document.hidden) return false;
    return getShellVisible();
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = (shellVis?: boolean) => {
      const docVis = typeof document === "undefined" ? true : !document.hidden;
      const nextShell = shellVis ?? getShellVisible();
      setVisible(docVis && nextShell);
    };
    const onShellVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
      sync(detail?.visible);
    };
    const onDocVisibility = () => sync();

    window.addEventListener(DESKTOP_VISIBILITY_EVENT, onShellVisibility);
    document.addEventListener("visibilitychange", onDocVisibility);
    return () => {
      window.removeEventListener(DESKTOP_VISIBILITY_EVENT, onShellVisibility);
      document.removeEventListener("visibilitychange", onDocVisibility);
    };
  }, []);

  return visible;
}
