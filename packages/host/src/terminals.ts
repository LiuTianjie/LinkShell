import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { SerializeAddon } from "@xterm/addon-serialize";
// CommonJS bundle: only a default export under ESM.
import xtermHeadless from "@xterm/headless";
import { spawn, type IPty } from "node-pty";
import { RpcError, type TerminalInfo } from "@linkshell/wire";
import type { HostStore, TerminalRecord } from "./store.js";
import { TerminalState } from "./terminal-state.js";

// Plain shells on the host, kept open while devices come and go: any command,
// like an SSH session that survives the phone locking.
//
// Each terminal is mirrored by a headless emulator. A device that (re)opens a
// terminal gets a snapshot of the mirror's screen and scrollback rather than
// the raw byte log: shells redraw their prompt on every resize with cursor
// moves meant for the width of the moment, so replaying the bytes at another
// width stacks up stale prompts. A device that only briefly dropped off still
// catches up from the byte log, which is cheaper and exact for it.

const { Terminal: ScreenMirror } = xtermHeadless;

/** Screen history kept per terminal for redraws. */
const BUFFER_BYTES = 1024 * 1024;
/** Scrollback kept by the mirror, and sent to a device opening the terminal. */
const SCROLLBACK = 2000;
/** Scrollback saved, so an ended terminal can still be read. */
const SAVED_SCROLLBACK = 1000;
const SAVE_EVERY_MS = 3000;
/** Output is sent in slices at most this often, so a flood of small writes isn't a flood of messages. */
const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;
const MAX_TERMINALS = 24;

interface Chunk {
  seq: number;
  data: string;
}

export type OutputListener = (seq: number, data: string, geometry?: { frame: number; cols: number; rows: number }) => void;

class Terminal {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  /** Output since the last save. */
  dirty = false;
  activeAt = Date.now();
  exitCode: number | null | undefined;
  title: string;
  private readonly chunks: Chunk[] = [];
  private bytes = 0;
  private seq = 0;
  private frame = 0;
  private closed = false;
  private pending = "";
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<OutputListener>();
  private readonly mirror: InstanceType<typeof ScreenMirror>;
  private readonly serializer = new SerializeAddon();
  /** The last chunk the mirror has parsed (it parses asynchronously). */
  private parsedSeq = 0;
  private state?: TerminalState;
  private stateSnapshot?: { frame: number; cols: number; rows: number; data: string };

  constructor(
    private readonly pty: IPty,
    readonly cwd: string,
    private readonly shell: string,
    public cols: number,
    public rows: number,
    readonly command: string | undefined,
    private readonly changed: (terminal: Terminal) => void,
    private readonly store?: HostStore,
  ) {
    this.title = basename(shell);
    try { this.state = new TerminalState(cols, rows); }
    catch (error) { console.warn("Terminal snapshot mirror unavailable:", error instanceof Error ? error.message : error); }
    this.recordFrame("");
    this.mirror = new ScreenMirror({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    // The addon's types are written against the browser's terminal; it only uses what the headless one has too.
    this.mirror.loadAddon(this.serializer as unknown as Parameters<InstanceType<typeof ScreenMirror>["loadAddon"]>[0]);
    pty.onData((data) => this.onData(data));
    pty.onExit(({ exitCode }) => {
      if (this.closed) return;
      this.flush();
      this.exitCode = exitCode;
      this.changed(this);
    });
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      activeAt: this.activeAt,
      command: this.command,
      exitCode: this.exitCode,
    };
  }

  /**
   * The screen as it is now: the mirror's parsed state, then any output it
   * hasn't parsed yet, so the result is exact up to `seq`.
   */
  private snapshot(scrollback = SCROLLBACK): string {
    const unparsed = this.chunks.filter((chunk) => chunk.seq > this.parsedSeq).map((chunk) => chunk.data);
    return this.serializer.serialize({ scrollback }) + unparsed.join("");
  }

  record(): TerminalRecord {
    this.flush();
    const buffer = this.snapshot(SAVED_SCROLLBACK);
    return {
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      command: this.command,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      activeAt: this.activeAt,
      exitCode: this.exitCode ?? null,
      ended: !this.running,
      buffer,
    };
  }

  captureState(): { frame: number; cols: number; rows: number; data: string } | undefined {
    this.flush();
    if (!this.state) return undefined;
    if (this.stateSnapshot?.frame === this.frame) return this.stateSnapshot;
    try {
      return this.stateSnapshot = { frame: this.frame, cols: this.cols, rows: this.rows, data: this.state.snapshot() };
    } catch {
      // An unsupported state must use exact recordings, never a damaged screen.
      return undefined;
    }
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  /** Re-reads the foreground process; reports whether the title changed. */
  refreshTitle(): boolean {
    if (!this.running) return false;
    let process = this.shell;
    try {
      process = this.pty.process || this.shell;
    } catch {
      // The pty is going away.
    }
    const title = basename(process);
    if (title === this.title) return false;
    this.title = title;
    return true;
  }

  attach(listener: OutputListener, fromSeq?: number): { replay: string; reset: boolean; seq: number } {
    this.flush();
    this.listeners.add(listener);
    const first = this.chunks[0]?.seq ?? this.seq + 1;
    // Everything after fromSeq is still here: send just that.
    if (fromSeq !== undefined && fromSeq <= this.seq && fromSeq >= first - 1) {
      return { replay: this.chunks.filter((chunk) => chunk.seq > fromSeq).map((chunk) => chunk.data).join(""), reset: false, seq: this.seq };
    }
    return { replay: this.snapshot(), reset: true, seq: this.seq };
  }

  detach(listener: OutputListener): void {
    this.listeners.delete(listener);
  }

  write(data: string): void {
    if (!this.running) throw RpcError.app("not_ready", "this terminal has exited");
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.running || (cols === this.cols && rows === this.rows)) return;
    this.flush();
    this.cols = cols;
    this.rows = rows;
    this.recordFrame("");
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
    try { this.state?.resize(cols, rows); }
    catch { this.state?.dispose(); this.state = undefined; this.stateSnapshot = undefined; }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.flushTimer);
    this.listeners.clear();
    this.mirror.dispose();
    this.state?.dispose(); this.state = undefined; this.stateSnapshot = undefined;
    if (this.running) {
      try {
        this.pty.kill("SIGHUP");
      } catch {
        // Already gone.
      }
    }
  }

  private onData(data: string): void {
    if (this.closed) return;
    this.activeAt = Date.now();
    this.dirty = true;
    this.pending += data;
    if (this.pending.length >= FLUSH_BYTES) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.pending) return;
    let pending = this.pending;
    this.pending = "";
    while (pending) {
      let end = Math.min(FLUSH_BYTES, pending.length);
      // Splitting a surrogate pair would corrupt a character at the native boundary.
      if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1]!)) end--;
      const chunk = { seq: ++this.seq, data: pending.slice(0, end) };
      pending = pending.slice(end);
      this.chunks.push(chunk);
      this.recordFrame(chunk.data);
      try { this.state?.write(chunk.data); }
      catch (error) {
        console.warn("Terminal snapshot mirror unavailable:", error instanceof Error ? error.message : error);
        this.state?.dispose(); this.state = undefined; this.stateSnapshot = undefined;
      }
      this.mirror.write(chunk.data, () => { this.parsedSeq = chunk.seq; });
      this.bytes += chunk.data.length;
      while (this.bytes > BUFFER_BYTES && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.data.length;
      for (const listener of this.listeners) listener(chunk.seq, chunk.data, { frame: this.frame, cols: this.cols, rows: this.rows });
    }
  }

  private recordFrame(data: string): void {
    this.store?.appendTerminalFrame(this.id, ++this.frame, this.cols, this.rows, data);
  }
}

export type TerminalChangeListener = (terminal: TerminalInfo, closed?: boolean) => void;

function recordInfo(record: TerminalRecord, interrupted: boolean): TerminalInfo {
  return {
    id: record.id,
    title: record.title,
    cwd: record.cwd,
    cols: record.cols,
    rows: record.rows,
    createdAt: record.createdAt,
    activeAt: record.activeAt,
    command: record.command,
    exitCode: record.exitCode,
    interrupted: interrupted || undefined,
  };
}

/**
 * Live shells plus the history of ended ones. Everything is saved, so after
 * a shell exits (or the host restarts) its output can still be read, and it
 * can be run again.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  /** Ended terminals, as saved. */
  private readonly history = new Map<string, { record: TerminalRecord; interrupted: boolean }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly changeListeners = new Set<TerminalChangeListener>();
  private stopped = false;
  private readonly snapshots = new Map<string, { terminalId: string; data: string; expires: number }>();

  /** @param env The user's login-shell environment. */
  constructor(
    private readonly env?: NodeJS.ProcessEnv,
    private readonly store?: HostStore,
  ) {
    for (const record of store?.listTerminals() ?? []) {
      // Still marked live: the host stopped while it ran.
      const interrupted = !record.ended;
      if (interrupted) store?.saveTerminal({ ...record, ended: true });
      this.history.set(record.id, { record: { ...record, ended: true }, interrupted });
    }
    this.timer = setInterval(() => {
      for (const [key, value] of this.snapshots) if (value.expires < Date.now()) this.snapshots.delete(key);
      for (const terminal of this.terminals.values()) {
        // The foreground process ("vim", "npm") is the most useful name for a terminal.
        if (terminal.refreshTitle()) this.emit(terminal.info());
        if (terminal.dirty && Date.now() - terminal.activeAt < 60_000) this.save(terminal);
      }
    }, SAVE_EVERY_MS);
    this.timer.unref();
  }

  onChange(listener: TerminalChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emit(terminal: TerminalInfo, closed?: boolean): void {
    for (const listener of this.changeListeners) listener(terminal, closed);
  }

  private save(terminal: Terminal): void {
    if (this.stopped) return;
    terminal.dirty = false;
    this.store?.saveTerminal(terminal.record());
    const snapshot = terminal.captureState();
    if (snapshot) this.store?.saveTerminalSnapshot(terminal.id, snapshot);
  }

  list(): TerminalInfo[] {
    return [
      ...[...this.terminals.values()].map((terminal) => terminal.info()),
      ...[...this.history.values()].map(({ record, interrupted }) => recordInfo(record, interrupted)),
    ].sort((a, b) => b.activeAt - a.activeAt);
  }

  create(options: { cwd?: string; command?: string; cols: number; rows: number }): TerminalInfo {
    if (this.terminals.size >= MAX_TERMINALS) throw RpcError.app("busy", `at most ${MAX_TERMINALS} terminals can run at once`);
    const cwd = options.cwd ?? homedir();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw RpcError.app("invalid_params", `no such directory: ${cwd}`);
    const base = this.env ?? process.env;
    const shell = base.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
    Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "LinkShell" });
    env.LANG ??= "en_US.UTF-8";
    const pty = spawn(shell, process.platform === "win32" ? [] : ["-l"], {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd,
      env,
    });
    const command = options.command?.trim() || undefined;
    const terminal = new Terminal(pty, cwd, shell, options.cols, options.rows, command, (t) => {
      // Closed (or the host stopping): it's gone; its shell exiting is no news.
      if (this.stopped || !this.terminals.has(t.id)) return;
      // Ended: keep it as history.
      if (!t.running) {
        this.save(t);
        this.terminals.delete(t.id);
        this.history.set(t.id, { record: t.record(), interrupted: false });
        // Its screen now lives in the record.
        t.close();
      }
      this.emit(t.info());
    }, this.store);
    this.terminals.set(terminal.id, terminal);
    // Typed into the shell (not `-c`), so the shell stays for whatever comes next.
    // Once the shell has drawn its prompt: typed any earlier, the tty echoes the
    // command above the prompt and it shows twice.
    if (command) {
      let typed = false;
      const type = () => {
        if (typed || !terminal.running) return;
        typed = true;
        first.dispose();
        clearTimeout(fallback);
        pty.write(`${command}\r`);
      };
      // A little after the first output, so a prompt drawn in pieces is complete.
      const first = pty.onData(() => setTimeout(type, 60));
      const fallback = setTimeout(type, 3000);
    }
    this.save(terminal);
    this.emit(terminal.info());
    return terminal.info();
  }

  attach(id: string, listener: OutputListener, fromSeq?: number, replayFormat?: "frames-v1", fromFrame?: number, snapshot = false) {
    const attached = this.attachScreen(id, listener, fromSeq);
    if (snapshot && attached.reset) {
      const state = this.terminals.has(id) ? this.terminals.get(id)!.captureState() : this.savedState(id);
      if (state) {
        const snapshotId = randomUUID();
        // Keep immutable transfers briefly, bounded across all devices. A
        // second attach cannot change a first client's half-received snapshot.
        let bytes = state.data.length * 2;
        for (const [key, value] of this.snapshots) {
          if (value.expires < Date.now()) this.snapshots.delete(key);
          else bytes += value.data.length * 2;
        }
        while (bytes > 256 * 1024 * 1024 && this.snapshots.size) {
          const oldest = this.snapshots.keys().next().value!;
          bytes -= this.snapshots.get(oldest)!.data.length * 2; this.snapshots.delete(oldest);
        }
        this.snapshots.set(snapshotId, { terminalId: id, data: state.data, expires: Date.now() + 120_000 });
        return { ...attached, replay: "", state: { snapshotId, length: state.data.length, frame: state.frame, cols: state.cols, rows: state.rows } };
      }
    }
    const throughFrame = replayFormat ? this.store?.lastTerminalFrame(id) ?? 0 : 0;
    if (!throughFrame) return attached;
    const afterFrame = fromFrame !== undefined && fromFrame >= 0 && fromFrame <= throughFrame ? fromFrame : 0;
    return { ...attached, replay: "", reset: afterFrame === 0, recording: { afterFrame, throughFrame } };
  }

  private savedState(id: string) {
    if (!this.history.has(id)) return undefined;
    const saved = this.store?.terminalSnapshot(id);
    const record = this.history.get(id)!.record;
    const latest = this.store?.lastTerminalFrame(id) ?? 0;
    if (saved?.frame === latest) return saved;
    if (!latest) return undefined;
    let state: TerminalState | undefined;
    try {
      state = new TerminalState(saved?.cols ?? record.cols, saved?.rows ?? record.rows);
      if (saved) state.write(saved.data);
      let after = saved?.frame ?? 0;
      // Older recordings are compacted once on the host; subsequent opens use
      // the checkpoint, without moving the old journal over the network.
      while (after < latest) {
        const frames = this.store!.terminalFrames(id, after, latest);
        if (!frames.length) throw new Error("终端检查点后的记录不完整");
        for (const frame of frames) { state.resize(frame.cols, frame.rows); state.write(frame.data); after = frame.frame; }
      }
      const updated = { frame: latest, cols: state.cols, rows: state.rows, data: state.snapshot() };
      this.store?.saveTerminalSnapshot(id, updated);
      return updated;
    } catch { return undefined; }
    finally { state?.dispose(); }
  }

  state(id: string, snapshotId: string, offset: number) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.terminalId !== id || snapshot.expires < Date.now()) throw RpcError.app("not_found", "终端恢复状态已过期，请重试");
    if (offset > snapshot.data.length) throw RpcError.app("invalid_params", "终端恢复位置无效");
    snapshot.expires = Date.now() + 120_000;
    let end = Math.min(snapshot.data.length, offset + 256 * 1024);
    if (end < snapshot.data.length && /[\uD800-\uDBFF]/.test(snapshot.data[end - 1]!)) end--;
    return { data: snapshot.data.slice(offset, end), nextOffset: end, done: end === snapshot.data.length };
  }

  replay(id: string, afterFrame: number, throughFrame: number) {
    if (!this.terminals.has(id) && !this.history.has(id)) throw RpcError.app("not_found", "终端不存在");
    const latest = this.store?.lastTerminalFrame(id) ?? 0;
    if (throughFrame > latest || afterFrame > throughFrame) throw RpcError.app("invalid_params", "终端回放范围无效");
    const frames = this.store?.terminalFrames(id, afterFrame, throughFrame) ?? [];
    const nextFrame = frames.at(-1)?.frame ?? afterFrame;
    return { frames, nextFrame, done: nextFrame >= throughFrame };
  }

  private attachScreen(id: string, listener: OutputListener, fromSeq?: number) {
    const live = this.terminals.get(id);
    if (live) return { terminal: live.info(), ...live.attach(listener, fromSeq) };
    const ended = this.history.get(id);
    if (!ended) throw RpcError.app("not_found", "no such terminal");
    return { terminal: recordInfo(ended.record, ended.interrupted), replay: ended.record.buffer, reset: true, seq: 0 };
  }

  detach(id: string, listener: OutputListener): void {
    this.terminals.get(id)?.detach(listener);
  }

  input(id: string, data: string): void {
    this.live(id).write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    const before = `${terminal.cols}x${terminal.rows}`;
    terminal.resize(cols, rows);
    if (`${terminal.cols}x${terminal.rows}` !== before) this.emit(terminal.info());
  }

  /** Ends a live terminal and forgets it, or deletes an ended one from history. */
  close(id: string): void {
    const terminal = this.terminals.get(id);
    const ended = this.history.get(id);
    if (!terminal && !ended) throw RpcError.app("not_found", "no such terminal");
    const info = terminal ? terminal.info() : recordInfo(ended!.record, ended!.interrupted);
    terminal?.close();
    this.terminals.delete(id);
    this.history.delete(id);
    this.store?.deleteTerminal(id);
    for (const [key, value] of this.snapshots) if (value.terminalId === id) this.snapshots.delete(key);
    this.emit(info, true);
  }

  stop(): void {
    clearInterval(this.timer);
    // Saved as still running: next start lists them as interrupted.
    for (const terminal of this.terminals.values()) this.save(terminal);
    this.stopped = true;
    for (const terminal of this.terminals.values()) terminal.close();
    this.terminals.clear();
    this.snapshots.clear();
  }

  private live(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (terminal) return terminal;
    if (this.history.has(id)) throw RpcError.app("not_ready", "this terminal has ended");
    throw RpcError.app("not_found", "no such terminal");
  }
}
