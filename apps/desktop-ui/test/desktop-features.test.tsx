// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ClientState, ClientStore, HostLink, HostStreams } from "@linkshell/client-core";
import {
  SCREEN_AUDIO_CHANNELS,
  SCREEN_AUDIO_CODEC_OPUS,
  SCREEN_AUDIO_CODEC_PCM16,
  SCREEN_AUDIO_SAMPLE_RATE,
  encodeScreenAudioPacket,
} from "@linkshell/wire";
import {
  DESKTOP_LAN_HOSTS_EVENT,
  DESKTOP_NATIVE_SCREEN_EVENT,
  DESKTOP_REPLY_EVENT,
  type LanHostEntry,
} from "../src/bridge/desktop-bridge";
import { hasOpenOverlay } from "../src/bridge/top-layer-registry";
import type { Computer, Connection, SessionSubscriptions } from "../src/core/connections";
import { engine } from "../src/core/engine";
import { I18nProvider, setDesktopLocalePreference } from "../src/core/i18n";
import { routerStore } from "../src/core/router-store";
import { ScreenAudioPlayer } from "../src/core/screen-audio";
import { screenPreferencesStore } from "../src/core/screen-client";
import { resetDesktopStorageForTests } from "../src/core/storage";
import { FileViewerTabPanel } from "../src/features/inspector";
import { FilesPanel } from "../src/features/inspector/FilesPanel";
import { translateInspector } from "../src/features/inspector/i18n-inspector";
import {
  INSPECTOR_FILES_CHANGED_EVENT,
  closeOpenTabsForDeletedPath,
  findDirtyFileTabsForPath,
  getInspectorScopeTabs,
  openFileTabInInspector,
  resetInspectorTabsForTests,
  retargetOpenTabsAfterRename,
  setFileDraft,
} from "../src/features/inspector/inspector-tabs-store";
import { RemoteScreenWorkspace } from "../src/features/remote";
import { getRemoteCopy } from "../src/features/remote/remote-copy";
import {
  resolveScreenUploadDir,
  uploadDroppedFilesToScreen,
} from "../src/features/remote/screen-upload";
import { SignInPairModal } from "../src/features/system";
import { translateSystem } from "../src/features/system/system-i18n";
import { DialogProvider } from "../src/primitives";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMockComputer(
  key: string,
  platform: "darwin" | "win32" | "linux",
  name: string,
  online = true,
): Computer {
  return {
    key,
    gateway: "wss://gateway.itool.tech",
    machine: {
      id: `machine-${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      platform,
      online,
      via: "account",
    },
  };
}

function decodeWsClientFrame(bytes: Uint8Array): string | undefined {
  if (bytes.length < 2) return undefined;
  const masked = (bytes[1]! & 0x80) !== 0;
  let len = bytes[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = (bytes[2]! << 8) | bytes[3]!;
    offset = 4;
  }
  const mask = masked ? bytes.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  const payload = bytes.slice(offset, offset + len);
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]!;
  }
  return new TextDecoder().decode(payload);
}

function encodeWsServerTextFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const header = payload.length < 126 ? [0x81, payload.length] : [0x81, 126, payload.length >> 8, payload.length & 0xff];
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

function makeMockConnection(
  computer: Computer,
  rpcHandler: (method: string, params: unknown) => Promise<unknown>,
  onWsFrameSpy?: (text: string) => void,
): Connection {
  const store = createStore<ClientState>(() => ({
    status: computer.machine.online ? "online" : "offline",
    machine: {
      id: computer.machine.id,
      hostname: computer.machine.name,
      platform: computer.machine.platform ?? "darwin",
      arch: "arm64",
      homedir: "/Users/alice",
      home: "/Users/alice",
      protocolVersion: 3,
    },
    agents: [],
    sessions: {},
    timelines: {},
    connect: () => {},
    disconnect: () => {},
    openSession: () => {},
    closeSession: () => {},
  })) as unknown as ClientStore;

  const link = {
    status: computer.machine.online ? "online" : "offline",
    call: vi.fn((method: string, params: unknown) => rpcHandler(method, params)),
    onStatus: vi.fn(() => () => {}),
    onNotification: vi.fn(() => () => {}),
    onOnline: vi.fn(() => () => {}),
    reconnectNow: vi.fn(),
  } as unknown as HostLink;

  const streams = {
    status: "connected",
    connect: vi.fn(),
    stop: vi.fn(),
    open: vi.fn(async (_port: number, callbacks: { data: (bytes: Uint8Array) => void; closed: () => void }) => {
      let handshook = false;
      return {
        write: vi.fn((chunk: Uint8Array) => {
          if (!handshook) {
            const reqText = new TextDecoder().decode(chunk);
            const match = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(reqText);
            if (!match) return;
            handshook = true;
            const accept = createHash("sha1")
              .update(`${match[1]!.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
              .digest("base64");
            const resp = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
            const cap = encodeWsServerTextFrame(
              JSON.stringify({ session: { t: "capabilities", version: 1, configure: true, pause: true } }),
            );
            const respBytes = new TextEncoder().encode(resp);
            const combined = new Uint8Array(respBytes.length + cap.length);
            combined.set(respBytes, 0);
            combined.set(cap, respBytes.length);
            queueMicrotask(() => callbacks.data(combined));
            return;
          }
          const decoded = decodeWsClientFrame(chunk);
          if (decoded) onWsFrameSpy?.(decoded);
        }),
        close: vi.fn(),
      };
    }),
  } as unknown as HostStreams;

  const sessions = {
    acquire: vi.fn(() => () => {}),
    close: vi.fn(),
  } as unknown as SessionSubscriptions;

  return { computer, link, store, streams, sessions };
}

async function flushTicks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("mDNS LAN Discovery, File Rename/Delete, Screen Audio, Drag-Drop Upload & Shortcut Capture", () => {
  let container: HTMLDivElement;
  let root: Root;
  let postedMessages: Record<string, unknown>[];

  function installElectronBridge(
    platform: "darwin" | "win32",
    invokeResponder?: (method: string, params: Record<string, unknown>) => unknown,
  ) {
    postedMessages = [];
    window.linkshellDesktop = {
      shell: "electron",
      platform,
      visible: () => true,
      postMessage: (msg: Record<string, unknown>) => {
        postedMessages.push(msg);
        if (msg.action === "invoke" && typeof msg.id === "string") {
          const method = String(msg.method ?? "");
          const params = (msg.params as Record<string, unknown>) ?? {};
          const result = invokeResponder ? invokeResponder(method, params) : {};
          queueMicrotask(() => {
            window.dispatchEvent(
              new CustomEvent(DESKTOP_REPLY_EVENT, {
                detail: { id: msg.id, result },
              }),
            );
          });
        }
      },
    };
  }

  beforeEach(() => {
    resetDesktopStorageForTests();
    resetInspectorTabsForTests();
    setDesktopLocalePreference("zh");
    routerStore.setState({
      activeRoute: { kind: "home" },
      history: [{ kind: "home" }],
      historyIndex: 0,
      canGoBack: false,
      canGoForward: false,
    });
    screenPreferencesStore.setState({
      width: "auto",
      maxFps: "60",
      codec: "auto",
      pacing: "smooth",
      control: true,
      mode: "view",
      byComputer: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete window.linkshellDesktop;
    engine.state.setState({
      computers: [],
      localComputer: undefined,
      connection: undefined,
    });
    expect(hasOpenOverlay()).toBe(false);
    vi.restoreAllMocks();
  });

  it("keeps 3-locale completeness (zh/en/ja) for all new LAN, file, and remote screen keys", () => {
    for (const locale of ["zh", "en", "ja"] as const) {
      expect(translateSystem(locale, "pair.lanTitle").length).toBeGreaterThan(0);
      expect(translateSystem(locale, "pair.lanConnect").length).toBeGreaterThan(0);
      expect(translateInspector(locale, "rename").length).toBeGreaterThan(0);
      expect(translateInspector(locale, "delete").length).toBeGreaterThan(0);
      expect(translateInspector(locale, "dirtyRenameConfirm", { name: "a.ts" })).toContain("a.ts");
      expect(translateInspector(locale, "dirtyDeleteConfirm", { name: "a.ts" })).toContain("a.ts");
      const copy = getRemoteCopy(locale);
      expect(copy.screenAudioOn.length).toBeGreaterThan(0);
      expect(copy.screenAudioMuted.length).toBeGreaterThan(0);
      expect(copy.screenSystemShortcutEscapeHint).toContain("⌃⌘F");
      expect(copy.screenSystemShortcutEscapeHint).toContain("⌃⌥⌘Esc");
      expect(copy.screenUploadComplete(2, "/Users/a/Desktop")).toContain("2");
    }
    expect(translateSystem("en", "pair.lanConnect")).not.toBe(
      translateSystem("ja", "pair.lanConnect"),
    );
    expect(getRemoteCopy("en").screenAudioOn).not.toBe(getRemoteCopy("ja").screenAudioOn);
  });

  it("surfaces mDNS LAN hosts in SignInPairModal and performs 1-click direct connect + cleanup", async () => {
    installElectronBridge("darwin", (method) => {
      if (method === "startLanDiscovery") return [];
      return {};
    });

    const selectSpy = vi.spyOn(engine, "select").mockImplementation((comp) => {
      engine.state.setState({
        computers: [comp],
      });
    });
    const onOpenChange = vi.fn();

    await act(async () => {
      root.render(
        <I18nProvider>
          <SignInPairModal open initialTab="pair" onOpenChange={onOpenChange} />
        </I18nProvider>,
      );
    });
    await flushTicks();

    expect(
      postedMessages.some((m) => m.action === "invoke" && m.method === "startLanDiscovery"),
    ).toBe(true);

    const lanHost: LanHostEntry = {
      instanceName: "linkshell-11223344._linkshell._tcp.local",
      machineId: "lan-machine-42",
      fingerprint: "1122334455667788",
      name: "Office Mac Mini",
      protocolVersion: 3,
      host: "office-mini.local",
      addresses: ["192.168.10.22"],
      port: 7878,
      hostPort: 7878,
      srvPort: 7878,
      lastSeen: Date.now(),
      ttl: 120,
    };

    await act(async () => {
      window.dispatchEvent(new CustomEvent(DESKTOP_LAN_HOSTS_EVENT, { detail: [lanHost] }));
    });

    expect(document.body.textContent).toContain("Office Mac Mini");
    expect(document.body.textContent).toContain("192.168.10.22:7878");
    expect(document.body.textContent).toContain("11223344");

    const connectBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === translateSystem("zh", "pair.lanConnect"),
    );
    expect(connectBtn).toBeDefined();

    // Unpaired LAN host must NOT open an unencrypted raw `/` WS; it guides LAN gateway pairing and prefills ws://host:port.
    await act(async () => {
      connectBtn!.click();
    });
    expect(selectSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("ws://192.168.10.22:7878");

    // Once paired (with real boxKey), clicking connects over the encrypted LAN gateway `/v2/connect` URL.
    engine.state.setState({
      computers: [
        {
          key: "wss://gateway.itool.tech#lan-machine-42",
          gateway: "wss://gateway.itool.tech",
          machine: {
            id: "lan-machine-42",
            name: "Office Mac Mini",
            signKey: "sign-key-42",
            boxKey: "box-key-42",
            online: false,
            via: "paired",
          },
        },
      ],
    });
    await act(async () => {
      connectBtn!.click();
    });

    expect(selectSpy).toHaveBeenCalledTimes(1);
    const chosen = selectSpy.mock.calls[0]![0];
    expect(chosen.key).toBe("ws://192.168.10.22:7878#lan-machine-42");
    expect(chosen.gateway).toBe("ws://192.168.10.22:7878");
    expect(chosen.machine.id).toBe("lan-machine-42");
    expect(chosen.machine.boxKey).toBe("box-key-42");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      root.render(
        <I18nProvider>
          <SignInPairModal open={false} initialTab="pair" onOpenChange={onOpenChange} />
        </I18nProvider>,
      );
    });
    await flushTicks();

    expect(
      postedMessages.some((m) => m.action === "invoke" && m.method === "stopLanDiscovery"),
    ).toBe(true);
  });

  it("inspector-tabs-store retargets open tabs on rename, tracks dirty files, and closes deleted paths", () => {
    const compKey = "wss://gw#m1";
    openFileTabInInspector(compKey, "sess-1", "/repo/src/old.ts#L12");
    openFileTabInInspector(compKey, "sess-1", "/repo/src/nested/deep.ts");
    setFileDraft(compKey, "sess-1", "file:/repo/src/old.ts", {
      text: "edited",
      baseText: "orig",
    });

    expect(findDirtyFileTabsForPath(compKey, "/repo/src").length).toBe(1);

    retargetOpenTabsAfterRename(compKey, "/repo/src", "/repo/lib");
    const afterRename = getInspectorScopeTabs(compKey, "sess-1");
    expect(afterRename.tabs.map((t) => t.path)).toEqual([
      "/repo/lib/old.ts",
      "/repo/lib/nested/deep.ts",
    ]);
    expect(afterRename.tabs[0]?.lineSpec).toBe("/repo/lib/old.ts#L12");
    expect(findDirtyFileTabsForPath(compKey, "/repo/lib").length).toBe(0);

    closeOpenTabsForDeletedPath(compKey, "/repo/lib");
    const afterDelete = getInspectorScopeTabs(compKey, "sess-1");
    expect(afterDelete.tabs.map((t) => t.id)).toEqual(["new-tab"]);
  });

  it("FilesPanel rename & recursive delete guard dirty tabs, update open tabs, and show errors cleanly", async () => {
    const comp = makeMockComputer("wss://gw#files", "darwin", "Mac", true);
    let entries = [
      { name: "app.ts", path: "/repo/app.ts", file: true, size: 42 },
      { name: "docs", path: "/repo/docs", file: false },
    ];
    let failNextDelete = false;
    const rpcMock = vi.fn(async (method: string, params: unknown) => {
      if (method === "fs.list") {
        return { path: "/repo", parent: "/", entries, truncated: false };
      }
      if (method === "fs.rename") {
        const p = params as { from: string; to: string };
        entries = entries.map((e) =>
          e.path === p.from ? { ...e, name: "main.ts", path: p.to } : e,
        );
        return { path: p.to };
      }
      if (method === "fs.delete") {
        if (failNextDelete) throw new Error("permission denied");
        const p = params as { path: string };
        entries = entries.filter((e) => e.path !== p.path);
        return { ok: true };
      }
      return {};
    });
    const connection = makeMockConnection(comp, rpcMock);

    openFileTabInInspector(comp.key, "sess-a", "/repo/app.ts");
    openFileTabInInspector(comp.key, "sess-a", "/repo/docs/guide.md");
    setFileDraft(comp.key, "sess-a", "file:/repo/app.ts", {
      text: "dirty code",
      baseText: "clean",
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <FilesPanel connection={connection} online cwd="/repo" />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushTicks();

    // Trigger contextmenu on app.ts -> Rename
    const fileRow = Array.from(container.querySelectorAll(".inspector-file-row")).find((el) =>
      el.textContent?.includes("app.ts"),
    ) as HTMLElement;
    expect(fileRow).toBeDefined();

    await act(async () => {
      fileRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const renameMenuItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (el) => el.textContent?.trim() === translateInspector("zh", "rename"),
    ) as HTMLButtonElement;
    expect(renameMenuItem).toBeDefined();

    await act(async () => {
      renameMenuItem.click();
    });

    const input = document.body.querySelector("dialog input") as HTMLInputElement;
    expect(input).toBeDefined();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "main.ts");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const promptSubmit = document.body.querySelector('dialog button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      promptSubmit.click();
    });
    await flushTicks();

    // Dirty guard dialog appeared — cancel first!
    expect(document.body.textContent).toContain("app.ts");
    const cancelDirty = Array.from(document.body.querySelectorAll("dialog button")).find(
      (b) => b.textContent?.trim() === translateInspector("zh", "cancel"),
    ) as HTMLButtonElement;
    await act(async () => {
      cancelDirty.click();
    });
    expect(rpcMock).not.toHaveBeenCalledWith("fs.rename", expect.anything());

    // Clear dirty draft & confirm rename cleanly -> retargets open tab!
    setFileDraft(comp.key, "sess-a", "file:/repo/app.ts", undefined);
    await act(async () => {
      fileRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      (Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
        (el) => el.textContent?.trim() === translateInspector("zh", "rename"),
      ) as HTMLButtonElement).click();
    });
    const input2 = document.body.querySelector("dialog input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input2, "main.ts");
      input2.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (document.body.querySelector('dialog button[type="submit"]') as HTMLButtonElement).click();
    });
    await flushTicks();

    expect(rpcMock).toHaveBeenCalledWith("fs.rename", {
      from: "/repo/app.ts",
      to: "/repo/main.ts",
    });
    expect(
      getInspectorScopeTabs(comp.key, "sess-a").tabs.some((t) => t.path === "/repo/main.ts"),
    ).toBe(true);
    expect(container.textContent).toContain("main.ts");

    // Folder recursive delete error shows alert, then succeeds and closes descendant tab.
    failNextDelete = true;
    const docsRow = Array.from(container.querySelectorAll(".inspector-file-row")).find((el) =>
      el.textContent?.includes("docs"),
    ) as HTMLElement;
    await act(async () => {
      docsRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      (Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
        (el) => el.textContent?.trim() === translateInspector("zh", "delete"),
      ) as HTMLButtonElement).click();
    });
    await act(async () => {
      (Array.from(document.body.querySelectorAll("dialog button")).find(
        (b) => b.textContent?.trim() === translateInspector("zh", "delete"),
      ) as HTMLButtonElement).click();
    });
    await flushTicks();
    expect(document.body.textContent).toContain("permission denied");
    await act(async () => {
      (document.body.querySelector("dialog button") as HTMLButtonElement).click();
    });

    failNextDelete = false;
    await act(async () => {
      docsRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      (Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
        (el) => el.textContent?.trim() === translateInspector("zh", "delete"),
      ) as HTMLButtonElement).click();
    });
    await act(async () => {
      (Array.from(document.body.querySelectorAll("dialog button")).find(
        (b) => b.textContent?.trim() === translateInspector("zh", "delete"),
      ) as HTMLButtonElement).click();
    });
    await flushTicks();

    expect(rpcMock).toHaveBeenCalledWith("fs.delete", {
      path: "/repo/docs",
      recursive: true,
    });
    expect(
      getInspectorScopeTabs(comp.key, "sess-a").tabs.some(
        (t) => t.path === "/repo/docs/guide.md",
      ),
    ).toBe(false);
  });

  it("FileViewerTabPanel action menu supports rename and delete with event notification", async () => {
    const comp = makeMockComputer("wss://gw#viewer", "darwin", "Mac", true);
    const rpcMock = vi.fn(async (method: string, params: unknown) => {
      if (method === "fs.read") {
        const p = params as { path: string };
        return {
          path: p.path,
          kind: "text",
          size: 12,
          modifiedAt: 1000,
          text: "hello world\n",
          truncated: false,
        };
      }
      if (method === "fs.rename") {
        return { path: (params as { to: string }).to };
      }
      if (method === "fs.delete") {
        return { ok: true };
      }
      return {};
    });
    const connection = makeMockConnection(comp, rpcMock);
    openFileTabInInspector(comp.key, "sess-v", "/repo/note.md");

    const onBack = vi.fn();
    let changedCount = 0;
    const onChanged = () => {
      changedCount += 1;
    };
    window.addEventListener(INSPECTOR_FILES_CHANGED_EVENT, onChanged);

    await act(async () => {
      root.render(
        <I18nProvider>
          <DialogProvider>
            <FileViewerTabPanel
              computerKey={comp.key}
              sessionId="sess-v"
              tabId="file:/repo/note.md"
              connection={connection}
              online
              cwd="/repo"
              filePath="/repo/note.md"
              onBack={onBack}
            />
          </DialogProvider>
        </I18nProvider>,
      );
    });
    await flushTicks();

    const menuTrigger = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes(translateInspector("zh", "openShort")),
    ) as HTMLButtonElement;
    expect(menuTrigger).toBeDefined();

    await act(async () => {
      menuTrigger.click();
    });
    const deleteItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (el) => el.textContent?.trim() === translateInspector("zh", "delete"),
    ) as HTMLButtonElement;
    await act(async () => {
      deleteItem.click();
    });
    await act(async () => {
      (Array.from(document.body.querySelectorAll("dialog button")).find(
        (b) => b.textContent?.trim() === translateInspector("zh", "delete"),
      ) as HTMLButtonElement).click();
    });
    await flushTicks();

    expect(rpcMock).toHaveBeenCalledWith("fs.delete", { path: "/repo/note.md" });
    expect(changedCount).toBe(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    window.removeEventListener(INSPECTOR_FILES_CHANGED_EVENT, onChanged);
  });

  it("ScreenAudioPlayer unlocks AudioContext synchronously and decodes PCM16 + Opus @linkshell/wire packets", async () => {
    let ctxState: AudioContextState = "suspended";
    const resumeSpy = vi.fn(async () => {
      ctxState = "running";
    });
    const closeSpy = vi.fn(async () => {
      ctxState = "closed";
    });
    const startSpy = vi.fn();
    const createdBuffers: Float32Array[][] = [];
    const gainNode = {
      gain: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode;
    const fakeCtx = {
      get state() {
        return ctxState;
      },
      sampleRate: SCREEN_AUDIO_SAMPLE_RATE,
      currentTime: 1.0,
      destination: {} as AudioNode,
      resume: resumeSpy,
      close: closeSpy,
      createGain: () => gainNode,
      createBuffer: (ch: number, len: number) => {
        const channels = Array.from({ length: ch }, () => new Float32Array(len));
        createdBuffers.push(channels);
        return {
          getChannelData: (index: number) => channels[index]!,
        } as unknown as AudioBuffer;
      },
      createBufferSource: () =>
        ({
          buffer: null,
          connect: vi.fn(),
          start: startSpy,
        }) as unknown as AudioBufferSourceNode,
    };

    const audioDataCloseSpy = vi.fn();
    let configuredCodec: AudioDecoderConfig | undefined;
    let decoderOutputCb: ((data: AudioData) => void) | undefined;
    class FakeAudioDecoder {
      state: CodecState = "unconfigured";
      constructor(init: { output: (data: AudioData) => void }) {
        decoderOutputCb = init.output;
      }
      configure(config: AudioDecoderConfig) {
        configuredCodec = config;
        this.state = "configured";
      }
      decode(chunk: EncodedAudioChunk) {
        expect(chunk.type).toBe("key");
        decoderOutputCb?.({
          numberOfFrames: 2,
          numberOfChannels: 2,
          sampleRate: 48000,
          copyTo: (dest: Float32Array) => {
            dest.set([0.25, -0.25]);
          },
          close: audioDataCloseSpy,
        } as unknown as AudioData);
      }
      close() {
        this.state = "closed";
      }
    }
    class FakeEncodedAudioChunk {
      type: string;
      timestamp: number;
      data: BufferSource;
      constructor(init: EncodedAudioChunkInit) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.data = init.data;
      }
    }

    const player = new ScreenAudioPlayer({
      createAudioContext: () => fakeCtx,
      AudioDecoderCtor: FakeAudioDecoder as unknown as typeof AudioDecoder,
      EncodedAudioChunkCtor: FakeEncodedAudioChunk as unknown as typeof EncodedAudioChunk,
    });

    // Packets arriving while muted are ignored.
    const pcmPayload = new Uint8Array(8);
    const dv = new DataView(pcmPayload.buffer);
    dv.setInt16(0, 16384, true);
    dv.setInt16(2, -16384, true);
    dv.setInt16(4, 8192, true);
    dv.setInt16(6, -8192, true);
    const pcmPacket = encodeScreenAudioPacket({
      codec: SCREEN_AUDIO_CODEC_PCM16,
      seq: 1,
      timestampMs: 20,
      payload: pcmPayload,
    });
    player.handleMessage(pcmPacket);
    expect(startSpy).not.toHaveBeenCalled();

    // Enabling unmutes and calls AudioContext.resume() synchronously!
    player.setEnabled(true);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(gainNode.gain.value).toBe(1);

    player.handleMessage(pcmPacket);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(createdBuffers[0]![0]![0]).toBeCloseTo(0.5, 4);
    expect(createdBuffers[0]![1]![0]).toBeCloseTo(-0.5, 4);

    // Opus packet triggers AudioDecoder + planar AudioData schedule & close().
    const opusPacket = encodeScreenAudioPacket({
      codec: SCREEN_AUDIO_CODEC_OPUS,
      seq: 2,
      timestampMs: 40,
      payload: new Uint8Array([1, 2, 3, 4]),
    });
    player.handleMessage(opusPacket);
    expect(configuredCodec).toEqual({
      codec: "opus",
      sampleRate: SCREEN_AUDIO_SAMPLE_RATE,
      numberOfChannels: SCREEN_AUDIO_CHANNELS,
    });
    expect(audioDataCloseSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(2);

    // Muting zeroes gain cleanly.
    player.setEnabled(false);
    expect(gainNode.gain.value).toBe(0);
    player.dispose();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves remote Desktop/upload directory and chunks drag-dropped files cleanly", async () => {
    const comp = makeMockComputer("wss://gw#upload", "darwin", "Mac", true);
    const uploadCalls: Array<Record<string, unknown>> = [];
    const rpcMock = vi.fn(async (method: string, params: unknown) => {
      if (method === "fs.list") {
        const p = (params as { path: string }).path;
        if (p === "/Users/alice/Desktop") {
          throw new Error("ENOENT");
        }
        if (p === "/Users/alice/upload") {
          return { path: "/Users/alice/upload", entries: [] };
        }
        return { path: "/Users/alice", entries: [] };
      }
      if (method === "fs.upload") {
        const record = params as Record<string, unknown>;
        uploadCalls.push(record);
        return { path: `/Users/alice/upload/${String(record.name)}`, size: 10 };
      }
      return {};
    });
    const connection = makeMockConnection(comp, rpcMock);

    const dir = await resolveScreenUploadDir(connection, "/Users/alice", "darwin");
    expect(dir).toBe("/Users/alice/upload");

    const small = new File([new Uint8Array(10).fill(65)], "notes.txt", { type: "text/plain" });
    const huge = { name: "huge.iso", size: 999_999_999 } as File;
    const progressEvents: number[] = [];

    const result = await uploadDroppedFilesToScreen({
      connection,
      files: [small, huge],
      remoteHome: "/Users/alice",
      remotePlatform: "darwin",
      chunkBytes: 4,
      maxFileBytes: 1024,
      onProgress: (p) => progressEvents.push(p.index),
    });

    expect(progressEvents).toEqual([1, 2]);
    expect(result.uploadedPaths).toEqual(["/Users/alice/upload/notes.txt"]);
    expect(result.skippedNames).toEqual(["huge.iso"]);
    // 10 bytes split across 3 chunks: 4 + 4 + 2 bytes using appendPath & offset.
    expect(uploadCalls.length).toBe(3);
    expect(uploadCalls[0]?.offset).toBeUndefined();
    expect(uploadCalls[1]?.offset).toBe(4);
    expect(uploadCalls[1]?.appendPath).toBe("/Users/alice/upload/notes.txt");
    expect(uploadCalls[2]?.offset).toBe(8);
  });

  it("RemoteScreenWorkspace manages audio toggle, drag-drop upload overlay cutout, and Mac shortcut capture reset lifecycle", async () => {
    const shortcutCalls: boolean[] = [];
    installElectronBridge("darwin", (method, params) => {
      if (method === "setSystemShortcutCapture") {
        shortcutCalls.push(Boolean(params.enabled));
        return Boolean(params.enabled);
      }
      return {};
    });

    const comp = makeMockComputer("wss://gw#remote-mac", "darwin", "Remote Mac", true);
    const rpcMock = vi.fn(async (method: string, params: unknown) => {
      if (method === "screen.access") {
        return { supported: true, recording: true, control: true };
      }
      if (method === "screen.privacy") {
        return { curtain: false, lockOnDisconnect: false, supported: true };
      }
      if (method === "screen.start") {
        return { port: 9123, token: "tok", displays: [{ index: 0, name: "Built-in" }] };
      }
      if (method === "fs.list") {
        return { path: (params as { path: string }).path || "/Users/alice", entries: [] };
      }
      if (method === "fs.upload") {
        return { path: `/Users/alice/Desktop/${String((params as { name: string }).name)}`, size: 4 };
      }
      return {};
    });
    const wsSendSpy = vi.fn();
    const connection = makeMockConnection(comp, rpcMock, (text) => {
      wsSendSpy(text);
    });

    engine.state.setState({ computers: [comp], connection });
    routerStore.setState({ activeRoute: { kind: "screen", computerKey: comp.key } });

    await act(async () => {
      root.render(
        <I18nProvider>
          <RemoteScreenWorkspace computerKey={comp.key} standaloneChrome={false} />
        </I18nProvider>,
      );
    });
    await flushTicks();

    const copy = getRemoteCopy("zh");

    // 1. Native Metal start received initial audioMuted: true
    const startMsg = postedMessages.find((m) => m.action === "screen" && m.type === "start");
    expect(startMsg?.audioMuted).toBe(true);

    // 2. Toggle audio on -> sends native "audio" message with muted: false and enabled: true
    const audioBtn = container.querySelector(
      `button[aria-label="${copy.screenAudioMuted}"]`,
    ) as HTMLButtonElement;
    expect(audioBtn).toBeDefined();
    await act(async () => {
      audioBtn.click();
    });
    await flushTicks();
    const audioMsg = postedMessages.find((m) => m.action === "screen" && m.type === "audio");
    expect(audioMsg?.muted).toBe(false);
    expect(audioMsg?.enabled).toBe(true);
    expect(wsSendSpy).toHaveBeenCalledWith(JSON.stringify({ t: "audio", enabled: true }));

    // 3. Mac System Shortcut Capture toggle shows escape hint & resets cleanly on blur
    const captureBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(copy.screenSystemShortcutCaptureLabel),
    ) as HTMLButtonElement;
    expect(captureBtn).toBeDefined();
    await act(async () => {
      captureBtn.click();
    });
    await flushTicks();
    expect(shortcutCalls).toContain(true);
    expect(container.textContent).toContain(copy.screenSystemShortcutEscapeHint);

    // Blur resets shortcut capture automatically!
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await flushTicks();
    expect(shortcutCalls.at(-1)).toBe(false);
    expect(container.textContent).not.toContain(copy.screenSystemShortcutEscapeHint);

    // 4. Re-enable and verify Disconnect button also resets capture cleanly
    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(copy.screenSystemShortcutCaptureLabel),
      ) as HTMLButtonElement).click();
    });
    await flushTicks();
    expect(shortcutCalls.at(-1)).toBe(true);

    const disconnectBtn = container.querySelector(
      `button[aria-label="${copy.screenDisconnect}"]`,
    ) as HTMLButtonElement;
    await act(async () => {
      disconnectBtn.click();
    });
    await flushTicks();
    expect(shortcutCalls.at(-1)).toBe(false);

    // 5. Drag-and-drop file upload over stage renders Metal cutout overlay & uploads via fs.upload
    const startAgainBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(copy.screenStart),
    ) as HTMLButtonElement;
    await act(async () => {
      startAgainBtn.click();
    });
    await flushTicks();

    const shell = container.querySelector(".ls-screen-stage-shell") as HTMLElement;
    const dropFile = new File(["data"], "drop.txt", { type: "text/plain" });
    await act(async () => {
      const dragEvt = new Event("dragenter", { bubbles: true, cancelable: true }) as Event & {
        dataTransfer?: unknown;
      };
      dragEvt.dataTransfer = { types: ["Files"], files: [dropFile], dropEffect: "copy" };
      shell.dispatchEvent(dragEvt);
    });
    const overlayEl = container.querySelector(".ls-screen-drop-overlay");
    expect(overlayEl).not.toBeNull();
    expect(overlayEl?.getAttribute("data-native-overlay")).toBe("");

    await act(async () => {
      const dropEvt = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
        dataTransfer?: unknown;
      };
      dropEvt.dataTransfer = { types: ["Files"], files: [dropFile] };
      shell.dispatchEvent(dropEvt);
    });
    await flushTicks();
    expect(container.querySelector(".ls-screen-drop-overlay")).toBeNull();
    expect(rpcMock).toHaveBeenCalledWith(
      "fs.upload",
      expect.objectContaining({ dir: "/Users/alice/Desktop", name: "drop.txt" }),
    );
    expect(container.textContent).toContain("/Users/alice/Desktop");

    // 6. Native event error stops Metal stage gracefully (also emit stop check)
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(DESKTOP_NATIVE_SCREEN_EVENT, {
          detail: { id: startMsg?.id, type: "status", status: { live: false } },
        }),
      );
    });
  });

  it("hides macOS System Shortcut Capture on Windows client and toggles WebRTC audio with synchronous AudioContext.resume()", async () => {
    let ctxState = "suspended";
    const resumeSpy = vi.fn(async () => {
      ctxState = "running";
    });
    const gainNode = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    const prevAudioCtx = (window as unknown as { AudioContext?: unknown }).AudioContext;
    (window as unknown as { AudioContext?: unknown }).AudioContext = class {
      get state() {
        return ctxState;
      }
      sampleRate = 48000;
      currentTime = 0;
      destination = {};
      resume = resumeSpy;
      close = vi.fn(async () => {
        ctxState = "closed";
      });
      createGain = () => gainNode;
      createBuffer = () => ({ getChannelData: () => new Float32Array(0) });
      createBufferSource = () => ({ buffer: null, connect: vi.fn(), start: vi.fn() });
    };

    try {
      installElectronBridge("win32");
      const comp = makeMockComputer("wss://gw#win-remote", "win32", "Windows Box", true);
      const wsSent: string[] = [];
      const connection = makeMockConnection(
        comp,
        async (method) => {
          if (method === "screen.access") return { supported: true, recording: true, control: true };
          if (method === "screen.privacy") return { curtain: false, lockOnDisconnect: false, supported: true };
          return { port: 9123, token: "tok", displays: [{ index: 0, name: "Primary" }] };
        },
        (text) => wsSent.push(text),
      );
      engine.state.setState({ computers: [comp], connection });
      routerStore.setState({ activeRoute: { kind: "screen", computerKey: comp.key } });

      await act(async () => {
        root.render(
          <I18nProvider>
            <RemoteScreenWorkspace computerKey={comp.key} standaloneChrome={false} />
          </I18nProvider>,
        );
      });
      await flushTicks();

      const copy = getRemoteCopy("zh");
      const captureBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(copy.screenSystemShortcutCaptureLabel),
      );
      expect(captureBtn).toBeUndefined();

      const audioBtn = container.querySelector(
        `button[aria-label="${copy.screenAudioMuted}"]`,
      ) as HTMLButtonElement;
      expect(audioBtn).not.toBeNull();

      await act(async () => {
        audioBtn.click();
      });
      // Synchronously invoked inside click handler + WS notification sent.
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      await flushTicks();
      expect(wsSent).toContain(JSON.stringify({ t: "audio", enabled: true }));
    } finally {
      if (prevAudioCtx === undefined) {
        delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      } else {
        (window as unknown as { AudioContext?: unknown }).AudioContext = prevAudioCtx;
      }
    }
  });
});
