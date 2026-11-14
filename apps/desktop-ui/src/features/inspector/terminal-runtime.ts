import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import { toBase64, type TerminalInfo } from "@linkshell/wire";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Connection } from "../../core/connections";
import { STORAGE_KEYS, readLocal, saveLocal } from "../../core/storage";
import {
  MAX_WARM_TERMINALS,
  clampTerminalFontSize,
  readTerminalFontSize,
  replayTerminal,
  saveTerminalFontSize,
  touchTerminalLru,
  writeTerminal,
  type ReplayTerminal,
} from "../../core/terminal-replay";
import { moveNodeAtomic } from "../../primitives/utils";
import { getResolvedTheme, getTerminalAnsiPalette } from "../../theme";

export const MAX_TERMINAL_QUEUE_BYTES = 4 * 1024 * 1024;

const MIN_FIT_WIDTH_PX = 40;
const MIN_FIT_HEIGHT_PX = 24;

const TERMINAL_FONT_FAMILY =
  '"SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';

function ensureMatchMediaShim(): void {
  if (typeof window === "undefined") return;
  if (typeof window.matchMedia === "function") return;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function hasWorkingCanvas2d(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    return false;
  }
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("2d"));
  } catch {
    return false;
  }
}

let stageParkingEl: HTMLDivElement | null = null;

function ensureStageParkingRoot(): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (stageParkingEl && stageParkingEl.isConnected) {
    return stageParkingEl;
  }
  const el = document.createElement("div");
  el.dataset.terminalParking = "true";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;inset-block-start:-9999px;inset-inline-start:-9999px;inline-size:0;block-size:0;overflow:clip;pointer-events:none;content-visibility:hidden;";
  document.body.appendChild(el);
  stageParkingEl = el;
  return el;
}

/**
 * Safely moves `node` into `parent` using Chromium's atomic `Element.prototype.moveBefore()`
 * ONLY when both `node` and `parent` are connected in the same document, falling back to
 * `appendChild` on initial mount so Chromium never throws `HierarchyRequestError` / `NotFoundError`.
 */
function safeMoveOrAppend(parent: HTMLElement, node: HTMLElement): void {
  if (node.parentElement === parent) return;
  if (
    node.isConnected &&
    parent.isConnected &&
    node.ownerDocument === parent.ownerDocument
  ) {
    try {
      moveNodeAtomic(parent, node);
      return;
    } catch {
      // Fallback to standard insertion if atomic move rejects transient DOM state.
    }
  }
  parent.appendChild(node);
}

export function shellQuotePath(filePath: string, platform?: string): string {
  const isWindows =
    platform === "win32" ||
    platform === "windows" ||
    /^[A-Za-z]:[\\/]|^\\\\/.test(filePath);
  if (isWindows) {
    if (/^[A-Za-z0-9_./:\\-]+$/.test(filePath)) {
      return filePath;
    }
    return `"${filePath.replace(/"/g, '""')}"`;
  }
  if (/^[a-zA-Z0-9_./:-]+$/.test(filePath)) {
    return filePath;
  }
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

function canMeasureTerminalHost(hostEl: HTMLElement): boolean {
  return (
    hostEl.isConnected &&
    hostEl.clientWidth >= MIN_FIT_WIDTH_PX &&
    hostEl.clientHeight >= MIN_FIT_HEIGHT_PX
  );
}

interface MountedTerminalSurface {
  replayTarget: ReplayTerminal;
  getDims: () => { cols: number; rows: number };
  fit: () => { cols: number; rows: number } | null;
  setFontSize: (fontSize: number) => void;
  focus: () => void;
  paste: (text: string) => void;
  dispose: () => void;
}

function subscribeTerminalThemeSync(onSync: () => void): () => void {
  const observer =
    typeof MutationObserver !== "undefined" && typeof document !== "undefined"
      ? new MutationObserver(() => {
          onSync();
        })
      : undefined;

  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-mode"],
  });

  const mql =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : undefined;
  const handleMediaChange = () => {
    onSync();
  };
  if (mql && typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handleMediaChange);
  }

  return () => {
    observer?.disconnect();
    if (mql && typeof mql.removeEventListener === "function") {
      mql.removeEventListener("change", handleMediaChange);
    }
  };
}

function mountXtermOrHeadless(
  hostEl: HTMLDivElement,
  initialFontSize: number,
  onUserInput: (data: string) => void,
): MountedTerminalSurface {
  ensureMatchMediaShim();

  if (hasWorkingCanvas2d()) {
    try {
      const term = new Xterm({
        allowProposedApi: true,
        cursorBlink: true,
        fontSize: initialFontSize,
        fontFamily: TERMINAL_FONT_FAMILY,
        lineHeight: 1.25,
        scrollback: 5000,
        theme: { ...getTerminalAnsiPalette(getResolvedTheme()) },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(hostEl);
      const dataSub = term.onData(onUserInput);
      const unsubTheme = subscribeTerminalThemeSync(() => {
        term.options.theme = { ...getTerminalAnsiPalette(getResolvedTheme()) };
        if (term.rows > 0) {
          try {
            term.refresh(0, term.rows - 1);
          } catch {
            // Ignore transient refresh errors if detached.
          }
        }
      });

      if (canMeasureTerminalHost(hostEl)) {
        try {
          fitAddon.fit();
        } catch {
          // Container layout still settling.
        }
      }

      return {
        replayTarget: {
          reset: () => term.reset(),
          resize: (cols, rows) => {
            if (cols >= 10 && rows >= 4) {
              term.resize(cols, rows);
            }
          },
          write: (data, cb) => term.write(data, cb),
        },
        getDims: () => ({
          cols: Math.max(10, term.cols || 80),
          rows: Math.max(4, term.rows || 24),
        }),
        fit: () => {
          if (!canMeasureTerminalHost(hostEl)) {
            return null;
          }
          try {
            fitAddon.fit();
            if (term.rows > 0) {
              term.refresh(0, term.rows - 1);
            }
            return {
              cols: Math.max(10, term.cols || 80),
              rows: Math.max(4, term.rows || 24),
            };
          } catch {
            return null;
          }
        },
        setFontSize: (size) => {
          term.options.fontSize = size;
          if (canMeasureTerminalHost(hostEl)) {
            try {
              fitAddon.fit();
            } catch {
              // Ignore when detached or hidden.
            }
          }
        },
        focus: () => {
          try {
            term.focus();
          } catch {
            // Ignore focus error on hidden panels.
          }
        },
        paste: (text) => term.paste(text),
        dispose: () => {
          unsubTheme();
          dataSub.dispose();
          term.dispose();
        },
      };
    } catch {
      // Fall through to accessible DOM surface when headless test DOM lacks full xterm APIs.
    }
  }

  // Headless DOM-backed terminal mirror for non-canvas environments (e.g. Vitest JSDOM)
  const screenEl = document.createElement("pre");
  screenEl.className = "xterm xterm-headless-screen";
  screenEl.tabIndex = 0;
  screenEl.style.margin = "0";
  screenEl.style.fontSize = `${initialFontSize}px`;
  screenEl.style.fontFamily = TERMINAL_FONT_FAMILY;
  screenEl.style.whiteSpace = "pre-wrap";
  const applyHeadlessTheme = () => {
    const resolved = getResolvedTheme();
    const pal = getTerminalAnsiPalette(resolved);
    screenEl.dataset.terminalTheme = resolved;
    screenEl.style.backgroundColor = pal.background;
    screenEl.style.color = pal.foreground;
  };
  applyHeadlessTheme();
  const unsubHeadlessTheme = subscribeTerminalThemeSync(applyHeadlessTheme);
  hostEl.replaceChildren(screenEl);

  let cols = 80;
  let rows = 24;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      onUserInput(event.key);
    } else if (event.key === "Enter") {
      onUserInput("\r");
    }
  };
  screenEl.addEventListener("keydown", onKeyDown);

  return {
    replayTarget: {
      reset: () => {
        screenEl.textContent = "";
      },
      resize: (nextCols, nextRows) => {
        cols = Math.max(10, nextCols);
        rows = Math.max(4, nextRows);
      },
      write: (data, cb) => {
        screenEl.textContent = (screenEl.textContent ?? "") + data;
        cb();
      },
    },
    getDims: () => ({ cols, rows }),
    fit: () => ({ cols, rows }),
    setFontSize: (size) => {
      screenEl.style.fontSize = `${size}px`;
    },
    focus: () => screenEl.focus(),
    paste: (text) => onUserInput(text),
    dispose: () => {
      unsubHeadlessTheme();
      screenEl.removeEventListener("keydown", onKeyDown);
      screenEl.remove();
    },
  };
}

interface WarmTerminalSession {
  terminalId: string;
  hostEl: HTMLDivElement;
  surface: MountedTerminalSurface;
  lastSeq: number;
  lastSentCols: number;
  lastSentRows: number;
  replaying: boolean;
  queuedChunks: Array<{ seq: number; data: string }>;
  queuedBytes: number;
  disposed: boolean;
  detachListeners: () => void;
}

export interface TerminalStageSnapshot {
  terminals: TerminalInfo[];
  activeId?: string;
  warmIds: string[];
  fontSize: number;
  loading: boolean;
}

export class TerminalStageController {
  readonly stageKey: string;
  readonly computerKey: string;
  readonly stageEl: HTMLDivElement;
  readonly store: StoreApi<TerminalStageSnapshot>;

  private connection?: Connection;
  private warmSessions = new Map<string, WarmTerminalSession>();
  private connectionUnsub?: () => void;
  private resizeObserver?: ResizeObserver;
  private fitRafId = 0;
  private autoOpenedCwds = new Set<string>();
  private refreshInFlight?: Promise<void>;

  constructor(stageKey: string, computerKey: string) {
    this.stageKey = stageKey;
    this.computerKey = computerKey;
    this.stageEl = document.createElement("div");
    this.stageEl.className = "inspector-terminal-stage ls-terminal-well";
    this.stageEl.dataset.stageKey = stageKey;

    const savedSelected = readLocal<string | undefined>(
      STORAGE_KEYS.selectedTerminal(stageKey),
      undefined,
    );

    this.store = createStore<TerminalStageSnapshot>(() => ({
      terminals: [],
      activeId: savedSelected,
      warmIds: [],
      fontSize: readTerminalFontSize(),
      loading: false,
    }));

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.scheduleFitActive();
      });
      this.resizeObserver.observe(this.stageEl);
    }
  }

  private scheduleFitActive(): void {
    if (typeof requestAnimationFrame === "function") {
      if (this.fitRafId) cancelAnimationFrame(this.fitRafId);
      this.fitRafId = requestAnimationFrame(() => {
        this.fitRafId = 0;
        this.fitActive();
      });
    } else {
      this.fitActive();
    }
  }

  bindConnection(connection: Connection | undefined): void {
    if (this.connection === connection) return;

    this.connectionUnsub?.();
    this.connectionUnsub = undefined;
    this.connection = connection;

    if (connection) {
      const offChanged = connection.link.on("terminal.changed", (payload) => {
        const prev = this.store.getState().terminals;
        if (payload.closed) {
          const nextList = prev.filter((t) => t.id !== payload.terminal.id);
          this.evictWarmSession(payload.terminal.id, false);
          const curActive = this.store.getState().activeId;
          const nextActive =
            curActive === payload.terminal.id ? nextList[0]?.id : curActive;
          this.store.setState({
            terminals: nextList,
            activeId: nextActive,
          });
          if (nextActive) {
            this.selectTerminal(nextActive);
          }
          return;
        }
        const exists = prev.some((t) => t.id === payload.terminal.id);
        const nextList = exists
          ? prev.map((t) =>
              t.id === payload.terminal.id ? payload.terminal : t,
            )
          : [...prev, payload.terminal];
        this.store.setState({ terminals: nextList });
      });

      const offOutput = connection.link.on("terminal.output", (payload) => {
        const warm = this.warmSessions.get(payload.terminalId);
        if (!warm || warm.disposed) return;
        if (warm.replaying) {
          const byteLen = payload.data.length;
          warm.queuedChunks.push({ seq: payload.seq, data: payload.data });
          warm.queuedBytes += byteLen;
          while (
            warm.queuedBytes > MAX_TERMINAL_QUEUE_BYTES &&
            warm.queuedChunks.length > 1
          ) {
            const dropped = warm.queuedChunks.shift()!;
            warm.queuedBytes -= dropped.data.length;
          }
          return;
        }
        if (payload.seq <= warm.lastSeq) return;
        warm.lastSeq = payload.seq;
        void writeTerminal(warm.surface.replayTarget, payload.data);
      });

      this.connectionUnsub = () => {
        offChanged();
        offOutput();
      };
    }
  }

  /**
   * Moves the persistent `stageEl` into `slotEl` via `safeMoveOrAppend` (`Element.prototype.moveBefore()`
   * when already connected, `appendChild` on initial mount) so switching between Right Inspector
   * and Bottom Dock never unmounts xterm or throws `DOMException` in Chromium 152!
   */
  attachToSlot(slotEl: HTMLElement): void {
    safeMoveOrAppend(slotEl, this.stageEl);
    this.syncHostVisibility();
    this.fitActive();
  }

  /**
   * Called in `useLayoutEffect` cleanup right before an active dock slot unmounts so `stageEl`
   * stays connected in `document.body` via `moveBefore` instead of detaching with the unmounting slot.
   */
  parkBeforeUnmount(slotEl: HTMLElement): void {
    if (this.stageEl.parentElement !== slotEl || !this.stageEl.isConnected) {
      return;
    }
    const parking = ensureStageParkingRoot();
    if (parking) {
      safeMoveOrAppend(parking, this.stageEl);
    }
  }

  async refreshList(autoOpenOpts?: {
    cwd?: string;
    sessionId?: string;
  }): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      if (this.store.getState().terminals.length > 0 || !autoOpenOpts?.cwd) {
        return;
      }
    }

    const run = (async () => {
      const conn = this.connection;
      if (!conn) return;
      this.store.setState({ loading: true });
      try {
        const res = await conn.link.call("terminals.list", {});
        const list = Array.isArray(res?.terminals) ? res.terminals : [];
        const curActive = this.store.getState().activeId;
        const validActive =
          curActive && list.some((t) => t.id === curActive)
            ? curActive
            : list.find(
                (t) =>
                  (autoOpenOpts?.sessionId &&
                    t.sessionId === autoOpenOpts.sessionId) ||
                  (autoOpenOpts?.cwd && t.cwd === autoOpenOpts.cwd),
              )?.id ?? list[0]?.id;

        this.store.setState({
          terminals: list,
          activeId: validActive,
          loading: false,
        });

        if (validActive) {
          this.selectTerminal(validActive);
          return;
        }

        if (list.length === 0 && autoOpenOpts?.cwd) {
          const key = `${autoOpenOpts.sessionId ?? ""}:${autoOpenOpts.cwd}`;
          if (!this.autoOpenedCwds.has(key)) {
            this.autoOpenedCwds.add(key);
            await this.createTerminal({
              cwd: autoOpenOpts.cwd,
              sessionId: autoOpenOpts.sessionId,
            });
          }
        }
      } catch {
        this.store.setState({ loading: false });
      }
    })();

    this.refreshInFlight = run;
    try {
      await run;
    } finally {
      if (this.refreshInFlight === run) {
        this.refreshInFlight = undefined;
      }
    }
  }

  async createTerminal(opts?: {
    cwd?: string;
    sessionId?: string;
    command?: string;
  }): Promise<TerminalInfo | undefined> {
    const conn = this.connection;
    if (!conn) return undefined;

    const protocol = conn.store.getState().machine?.protocol ?? 2;
    const res = await conn.link.call("terminals.create", {
      cwd: opts?.cwd,
      sessionId: protocol >= 2 ? opts?.sessionId : undefined,
      command: opts?.command,
      cols: 80,
      rows: 24,
    });

    const created = res.terminal;
    const prev = this.store.getState().terminals;
    const nextList = prev.some((t) => t.id === created.id)
      ? prev
      : [...prev, created];
    this.store.setState({
      terminals: nextList,
      activeId: created.id,
    });
    this.selectTerminal(created.id);
    return created;
  }

  selectTerminal(terminalId: string): void {
    saveLocal(STORAGE_KEYS.selectedTerminal(this.stageKey), terminalId);
    const { warmIds } = this.store.getState();
    const { next, evicted } = touchTerminalLru(
      warmIds,
      terminalId,
      MAX_WARM_TERMINALS,
    );

    for (const evictedId of evicted) {
      this.evictWarmSession(evictedId, true);
    }

    this.store.setState({
      activeId: terminalId,
      warmIds: next,
    });

    this.ensureWarmMounted(terminalId);
    this.syncHostVisibility();
    this.fitActive();
  }

  async closeTerminal(terminalId: string): Promise<void> {
    const conn = this.connection;
    this.evictWarmSession(terminalId, false);
    const remaining = this.store
      .getState()
      .terminals.filter((t) => t.id !== terminalId);
    const nextWarm = this.store
      .getState()
      .warmIds.filter((id) => id !== terminalId);
    const nextActive =
      this.store.getState().activeId === terminalId
        ? remaining[0]?.id
        : this.store.getState().activeId;

    this.store.setState({
      terminals: remaining,
      warmIds: nextWarm,
      activeId: nextActive,
    });

    if (conn) {
      await conn.link
        .call("terminals.close", { terminalId })
        .catch(() => undefined);
    }
    if (nextActive) {
      this.selectTerminal(nextActive);
    }
  }

  setFontSize(nextSize: number): number {
    const clamped = saveTerminalFontSize(clampTerminalFontSize(nextSize));
    this.store.setState({ fontSize: clamped });
    for (const warm of this.warmSessions.values()) {
      warm.surface.setFontSize(clamped);
    }
    this.fitActive();
    return clamped;
  }

  fitActive(): void {
    const activeId = this.store.getState().activeId;
    if (!activeId) return;
    const warm = this.warmSessions.get(activeId);
    if (!warm || warm.disposed) return;
    const dims = warm.surface.fit();
    if (
      dims &&
      this.connection &&
      (dims.cols !== warm.lastSentCols || dims.rows !== warm.lastSentRows)
    ) {
      warm.lastSentCols = dims.cols;
      warm.lastSentRows = dims.rows;
      void this.connection.link
        .call("terminals.resize", {
          terminalId: activeId,
          cols: dims.cols,
          rows: dims.rows,
        })
        .catch(() => undefined);
    }
  }

  focusActive(): void {
    const activeId = this.store.getState().activeId;
    if (!activeId) return;
    this.warmSessions.get(activeId)?.surface.focus();
  }

  async uploadFilesToActive(
    files: readonly File[],
    fallbackDir?: string,
  ): Promise<void> {
    const conn = this.connection;
    const activeId = this.store.getState().activeId;
    if (!conn || !activeId || files.length === 0) return;

    const termInfo = this.store
      .getState()
      .terminals.find((t) => t.id === activeId);
    const connState = conn.store.getState();
    const targetPlatform =
      connState.machine?.platform ?? conn.computer.machine.platform;
    const dir =
      termInfo?.cwd || fallbackDir || connState.machine?.home || "/tmp";
    const uploadedPaths: string[] = [];

    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const uploaded = await conn.link.call("fs.upload", {
        dir,
        name: file.name,
        data: toBase64(bytes),
      });
      uploadedPaths.push(shellQuotePath(uploaded.path, targetPlatform));
    }

    if (uploadedPaths.length > 0) {
      const joined = `${uploadedPaths.join(" ")} `;
      const warm = this.warmSessions.get(activeId);
      if (warm) {
        warm.surface.paste(joined);
      } else {
        await conn.link.call("terminals.input", {
          terminalId: activeId,
          data: joined,
        });
      }
    }
  }

  private ensureWarmMounted(terminalId: string): void {
    if (this.warmSessions.has(terminalId)) return;

    const hostEl = document.createElement("div");
    hostEl.className = "inspector-xterm-host";
    hostEl.dataset.terminalId = terminalId;
    hostEl.dataset.active = "true";
    this.stageEl.appendChild(hostEl);

    const fontSize = this.store.getState().fontSize;
    const surface = mountXtermOrHeadless(hostEl, fontSize, (data) => {
      if (!this.connection) return;
      void this.connection.link
        .call("terminals.input", { terminalId, data })
        .catch(() => undefined);
    });

    const entry: WarmTerminalSession = {
      terminalId,
      hostEl,
      surface,
      lastSeq: 0,
      lastSentCols: 0,
      lastSentRows: 0,
      replaying: true,
      queuedChunks: [],
      queuedBytes: 0,
      disposed: false,
      detachListeners: () => undefined,
    };

    this.warmSessions.set(terminalId, entry);
    void this.attachAndReplay(entry);
  }

  private async attachAndReplay(entry: WarmTerminalSession): Promise<void> {
    const conn = this.connection;
    if (!conn) {
      entry.replaying = false;
      return;
    }

    try {
      const attached = await conn.link.call("terminals.attach", {
        terminalId: entry.terminalId,
        replayFormat: "frames-v1",
        snapshot: true,
      });
      if (entry.disposed) return;

      await replayTerminal(
        entry.surface.replayTarget,
        attached,
        (afterFrame, throughFrame) =>
          conn.link.call("terminals.replay", {
            terminalId: entry.terminalId,
            afterFrame,
            throughFrame,
          }),
        () => !entry.disposed,
        {
          loadState: (snapshotId, offset) =>
            conn.link.call("terminals.state", {
              terminalId: entry.terminalId,
              snapshotId,
              offset,
            }),
        },
      );

      if (entry.disposed) return;
      entry.lastSeq = attached.seq;
      entry.replaying = false;

      const buffered = entry.queuedChunks.splice(0, entry.queuedChunks.length);
      entry.queuedBytes = 0;
      for (const chunk of buffered) {
        if (chunk.seq > entry.lastSeq) {
          entry.lastSeq = chunk.seq;
          await writeTerminal(entry.surface.replayTarget, chunk.data);
        }
      }

      this.fitActive();
    } catch {
      entry.replaying = false;
      entry.queuedChunks.length = 0;
      entry.queuedBytes = 0;
    }
  }

  private syncHostVisibility(): void {
    const activeId = this.store.getState().activeId;
    for (const [id, warm] of this.warmSessions) {
      warm.hostEl.dataset.active = id === activeId ? "true" : "false";
    }
  }

  private evictWarmSession(terminalId: string, detachOnHost: boolean): void {
    const warm = this.warmSessions.get(terminalId);
    if (!warm) return;
    warm.disposed = true;
    this.warmSessions.delete(terminalId);
    warm.detachListeners();
    warm.surface.dispose();
    warm.hostEl.remove();

    if (detachOnHost && this.connection) {
      void this.connection.link
        .call("terminals.detach", { terminalId })
        .catch(() => undefined);
    }
  }

  disposeAll(): void {
    if (this.fitRafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.fitRafId);
      this.fitRafId = 0;
    }
    this.connectionUnsub?.();
    this.connectionUnsub = undefined;
    this.resizeObserver?.disconnect();
    for (const id of [...this.warmSessions.keys()]) {
      this.evictWarmSession(id, false);
    }
    this.stageEl.remove();
  }
}

const stageControllers = new Map<string, TerminalStageController>();

export function getTerminalStageController(
  stageKey: string,
  computerKey = stageKey,
): TerminalStageController {
  let controller = stageControllers.get(stageKey);
  if (!controller) {
    controller = new TerminalStageController(stageKey, computerKey);
    stageControllers.set(stageKey, controller);
  }
  return controller;
}

export function resetTerminalStagesForTests(): void {
  for (const controller of stageControllers.values()) {
    controller.disposeAll();
  }
  stageControllers.clear();
  if (stageParkingEl) {
    stageParkingEl.remove();
    stageParkingEl = null;
  }
}
