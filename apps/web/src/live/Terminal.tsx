import { FilePicker } from "@/components/FilePicker";
import { Files } from "./Files";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { TerminalInfo } from "@linkshell/wire";
import { cn } from "@/lib/utils";
import {
  ArrowDownToLine,
  Check,
  CheckCircle2,
  CircleStop,
  Copy,
  LoaderCircle,
  Upload,
  FolderOpen,
  Plus,
  RotateCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fileBase64 } from "./Files";
import { readLocal, saveLocal } from "./storage";
import { replayTerminal, writeTerminal } from "./terminal-replay";
import { useDialogs } from "@/components/Dialogs";
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  ErrorNotice,
  EmptyState,
  LoadState,
  Modal,
  baseName,
  useConnection,
  useClient,
  useJob,
} from "./common";

export function Terminal({
  id,
  active = true,
}: {
  id: string;
  active?: boolean;
}) {
  const { link } = useConnection();
  const mount = useRef<HTMLDivElement>(null);
  const activeTerm = useRef<Xterm | null>(null);
  const mountedRef = useRef(true);
  const fitRef = useRef<FitAddon | null>(null);
  const visibleRef = useRef(active);
  visibleRef.current = active;
  const readyForInput = useRef(false);
  const endedRef = useRef(false);
  const onlineStatus = useClient((state) => state.status === "online");
  const [restoring, setRestoring] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [info, setInfo] = useState<TerminalInfo>();
  const [closed, setClosed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [fontSize, setFontSize] = useState(() => {
    const saved = readLocal("terminalFontSize", 13);
    return Number.isFinite(saved) ? Math.max(10, Math.min(24, saved)) : 13;
  });
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState<string>();
  const [uploaded, setUploaded] = useState<
    { path: string; inserted: boolean }[]
  >([]);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const uploadJob = useJob();
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;
  const ended =
    closed || Boolean(info && (info.exitCode != null || info.interrupted));
  const canInput = onlineStatus && !restoring && !restoreFailed && !ended;
  const shellPath = (path: string) =>
    "'" + path.replaceAll("'", "'\"'\"'") + "' ";
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    const target = activeTerm.current;
    if (!target || !readyForInput.current || endedRef.current)
      throw new Error("终端尚不能接收输入，请恢复连接后再上传。");
    // Validate the batch before saving anything, so an oversized later file is not a partial upload.
    const oversized = files.find((file) => file.size > 30_000_000);
    if (oversized) throw new Error(`${oversized.name} 超过 30 MB`);
    const result = await link.call("terminals.list", {});
    const terminal = result.terminals.find((item) => item.id === id);
    if (!terminal || terminal.exitCode != null || terminal.interrupted)
      throw new Error("终端已停止");
    if (!mountedRef.current) return;
    setUploaded([]);
    setCopied(false);
    try {
      for (const [index, file] of files.entries()) {
        if (!mountedRef.current || activeTerm.current !== target) return;
        setUploading(`${index + 1}/${files.length} · ${file.name}`);
        const saved = await link.call(
          "fs.upload",
          { dir: terminal.cwd, name: file.name, data: await fileBase64(file) },
          180000,
        );
        if (!mountedRef.current) return;
        const inserted =
          activeTerm.current === target && readyForInput.current && !endedRef.current && visibleRef.current;
        setUploaded((previous) => [
          ...previous,
          { path: saved.path, inserted },
        ]);
        if (inserted) target.paste(shellPath(saved.path));
      }
      if (activeTerm.current === target && visibleRef.current && readyForInput.current) target.focus();
    } finally {
      if (mountedRef.current) setUploading(undefined);
    }
  }
  const startUpload = (files: File[]) => {
    if (uploadJob.busy) {
      setError("请等待当前文件上传完成，再添加其他文件。");
      return;
    }
    void uploadJob.run(() => uploadFiles(files));
  };

  useEffect(() => {
    if (!mount.current) return;
    const term = new Xterm({
      fontFamily:
        '"Berkeley Mono", "SF Mono", ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: fontRef.current,
      lineHeight: 1.3,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      disableStdin: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    activeTerm.current = term;
    fitRef.current = fit;
    term.open(mount.current);
    // A considered 16-colour palette in Ghostty's muted spirit — soft, legible,
    // never the harsh VGA primaries. Background/foreground track the app theme.
    const ansi = {
      black: "#3b3b45",
      red: "#e06c75",
      green: "#8cc265",
      yellow: "#d8b76c",
      blue: "#7d95ff",
      magenta: "#c792ea",
      cyan: "#5fb3c9",
      white: "#c7c7d1",
      brightBlack: "#5c5c68",
      brightRed: "#ff9a9a",
      brightGreen: "#a5e075",
      brightYellow: "#e6c384",
      brightBlue: "#9aa5ff",
      brightMagenta: "#ddb2f4",
      brightCyan: "#7fd3e0",
      brightWhite: "#f2f2f7",
    };
    const syncTheme = () => {
      const styles = getComputedStyle(document.documentElement);
      const bg = styles.getPropertyValue("--code").trim();
      const fg = styles.getPropertyValue("--codeText").trim();
      const accent = styles.getPropertyValue("--accent").trim();
      term.options.theme = {
        background: bg,
        foreground: fg,
        cursor: accent,
        cursorAccent: bg,
        selectionBackground: accent + "40",
        ...ansi,
      };
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    if (visibleRef.current) fit.fit();
    let alive = true;
    let attaching = true;
    let failed = false;
    let seq: number | undefined;
    let generation = 0;
    let frame: number | undefined;
    let chain = Promise.resolve();
    let queuedBytes = 0;
    let overflowed = false;
    let pumping = false;
    const queued: {
      seq: number;
      frame?: number;
      data: string;
      cols?: number;
      rows?: number;
    }[] = [];
    const apply = async (event: (typeof queued)[number], current: number) => {
      if (!alive || generation !== current || event.seq <= (seq ?? -1)) return;
      if (
        event.cols &&
        event.rows &&
        (term.cols !== event.cols || term.rows !== event.rows)
      )
        term.resize(event.cols, event.rows);
      await writeTerminal(term, event.data);
      if (!alive || generation !== current) return;
      frame = event.frame;
      seq = event.seq;
    };
    const drain = async (current: number) => {
      while (queued.length && alive && generation === current && !overflowed) {
        const event = queued.shift()!;
        queuedBytes -= event.data.length;
        await apply(event, current);
      }
    };
    const setEnded = (terminal: TerminalInfo, removed = false) => {
      endedRef.current =
        removed || terminal.exitCode != null || Boolean(terminal.interrupted);
      setInfo(terminal);
      setClosed(removed);
      if (endedRef.current) {
        readyForInput.current = false;
        term.options.disableStdin = true;
      }
    };
    const resize = async () => {
      if (!visibleRef.current || !mount.current?.offsetWidth) return;
      fit.fit();
      if (endedRef.current) return;
      await link.call("terminals.resize", {
        terminalId: id,
        cols: Math.max(10, Math.min(1000, term.cols)),
        rows: Math.max(4, Math.min(500, term.rows)),
      });
    };
    const attach = () => {
      if (!alive || link.status !== "online") return;
      // A cancelled parser write may already be visible without a committed cursor.
      // Rebuild from a snapshot instead of replaying that write a second time.
      if (pumping) { seq = undefined; frame = undefined; }
      attaching = true;
      failed = false;
      readyForInput.current = false;
      term.options.disableStdin = true;
      setRestoring(true);
      setRestoreFailed(false);
      setError(undefined);
      setProgress(undefined);
      const current = ++generation;
      queued.length = 0;
      queuedBytes = 0;
      overflowed = false;
      chain = chain
        .catch(() => {})
        .then(async () => {
          if (!alive || generation !== current) return;
          try {
            const result = await link.call("terminals.attach", {
              terminalId: id,
              fromSeq: seq,
              replayFormat: "frames-v1",
              fromFrame: frame,
              snapshot: true,
            });
            if (!alive || generation !== current) return;
            setEnded(result.terminal);
            await replayTerminal(
              term,
              result,
              (afterFrame, throughFrame) =>
                link.call("terminals.replay", {
                  terminalId: id,
                  afterFrame,
                  throughFrame,
                }),
              () => alive && generation === current,
              {
                loadState: (snapshotId, offset) =>
                  link.call("terminals.state", {
                    terminalId: id,
                    snapshotId,
                    offset,
                  }),
                onProgress: (completed, total) => {
                  if (alive && generation === current)
                    setProgress(
                      total ? Math.floor((completed / total) * 100) : 100,
                    );
                },
              },
            );
            if (!alive || generation !== current) return;
            seq = result.seq;
            frame = result.state?.frame ?? result.recording?.throughFrame;
            if (!overflowed) await resize();
            await drain(current);
            if (!alive || generation !== current) return;
            if (overflowed) {
              attach();
              return;
            }
            attaching = false;
            readyForInput.current = !endedRef.current;
            term.options.disableStdin = endedRef.current || !visibleRef.current;
            setRestoring(false);
          } catch (reason) {
            if (alive && generation === current) {
              // A partial replay is not a valid base for live updates or the next reconnect.
              failed = true;
              seq = undefined;
              frame = undefined;
              queued.length = 0;
              queuedBytes = 0;
              readyForInput.current = false;
              term.options.disableStdin = true;
              setRestoring(false);
              setRestoreFailed(true);
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          }
        });
    };
    const pump = () => {
      if (pumping || attaching || failed) return;
      pumping = true;
      const current = generation;
      chain = chain
        .then(() => drain(current))
        .catch(() => {
          if (alive && current === generation) attach();
        })
        .finally(() => {
          pumping = false;
          if (queued.length && !attaching && !failed) pump();
        });
    };
    const output = link.on("terminal.output", (event) => {
      if (event.terminalId !== id || failed || !alive || overflowed) return;
      queuedBytes += event.data.length;
      if (queuedBytes > 4 * 1024 * 1024) {
        queued.length = 0;
        queuedBytes = 0;
        overflowed = true;
        if (!attaching) attach();
        return;
      }
      queued.push(event);
      pump();
    });
    const changed = link.on("terminal.changed", ({ terminal, closed }) => {
      if (terminal.id === id) setEnded(terminal, closed);
    });
    const input = term.onData((data) => {
      // Replay can contain terminal queries; never send their historical replies back to the shell.
      if (!readyForInput.current || endedRef.current) return;
      if (link.status !== "online") {
        setError("连接已断开，输入未发送");
        return;
      }
      void link
        .call("terminals.input", { terminalId: id, data })
        .catch((reason) => {
          if (alive)
            setError(reason instanceof Error ? reason.message : String(reason));
        });
    });
    const online = link.onOnline(attach);
    const status = link.onStatus((state) => {
      if (state !== "online") {
        seq = undefined;
        frame = undefined;
        generation++;
        attaching = true;
        queued.length = 0;
        queuedBytes = 0;
        readyForInput.current = false;
        term.options.disableStdin = true;
        setRestoring(true);
        setProgress(undefined);
      }
    });
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!alive || attaching || failed || !visibleRef.current) return;
        if (link.status === "online")
          void resize().catch((reason) => {
            if (alive)
              setError(
                `终端尺寸未同步：${reason instanceof Error ? reason.message : String(reason)}`,
              );
          });
      }, 120);
    });
    observer.observe(mount.current);
    attach();
    return () => {
      alive = false;
      generation++;
      clearTimeout(timer);
      observer.disconnect();
      themeObserver.disconnect();
      output();
      changed();
      online();
      status();
      input.dispose();
      activeTerm.current = null;
      fitRef.current = null;
      readyForInput.current = false;
      term.dispose();
      if (link.status === "online")
        void link.call("terminals.detach", { terminalId: id }).catch(() => {});
    };
  }, [link, id, retry]);

  useEffect(() => {
    const term = activeTerm.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try { saveLocal("terminalFontSize", fontSize); } catch { /* Font controls also work when storage is unavailable. */ }
    term.options.disableStdin = !active || !readyForInput.current;
    // Hidden cached tabs have no measured geometry; resizing them would resize the remote shell.
    if (active && !restoring && !restoreFailed && mount.current?.offsetWidth) {
      fitRef.current?.fit();
      if (endedRef.current) return;
      void link
        .call("terminals.resize", {
          terminalId: id,
          cols: Math.max(10, Math.min(1000, term.cols)),
          rows: Math.max(4, Math.min(500, term.rows)),
        })
        .catch((reason) => setError(`终端尺寸未同步：${String(reason)}`));
    }
  }, [fontSize, active, link, id, restoring, restoreFailed]);

  return (
    <div
      className="terminal-live"
      data-dragging={dragging || undefined}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          canInput && !uploadJob.busy ? "copy" : "none";
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        startUpload(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          startUpload(Array.from(event.clipboardData.files));
        }
      }}
    >
      <div className="terminal-controls">
        <span className="terminal-connection" role="status">
          {onlineStatus && restoring ? (
            <LoaderCircle className="animate-spin" size={14} />
          ) : (
            <span className={canInput ? "online-dot" : "offline-dot"} aria-hidden="true" />
          )}
          {!onlineStatus
            ? "连接已断开"
            : restoring
              ? "正在恢复终端…"
              : restoreFailed
                ? "恢复失败"
                : ended
                  ? "只读记录"
                  : "已连接"}
        </span>
        <div
          className="terminal-font-controls"
          role="group"
          aria-label="终端字号"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="缩小终端字号"
            disabled={fontSize <= 10}
            onClick={() => setFontSize((value) => value - 1)}
          >
            A−
          </Button>
          <span className="terminal-font-value">{fontSize}px</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="放大终端字号"
            disabled={fontSize >= 24}
            onClick={() => setFontSize((value) => value + 1)}
          >
            A+
          </Button>
        </div>
        <FilePicker
          multiple
          disabled={uploadJob.busy || !canInput}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            startUpload(files);
          }}
        >
          {uploadJob.busy ? "正在上传…" : "上传文件"}
        </FilePicker>
        <Button
          variant="ghost"
          size="sm"
          disabled={restoring || restoreFailed}
          onClick={() => {
            activeTerm.current?.scrollToBottom();
            activeTerm.current?.focus();
          }}
        >
          <ArrowDownToLine data-icon="inline-start" />
          回到底部
        </Button>
      </div>
      <div className="terminal-feedback">
        {restoreFailed ? (
          <Alert variant="destructive">
            <AlertTitle>终端恢复失败</AlertTitle>
            <AlertDescription>
              {error}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!onlineStatus}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  重新恢复
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertDescription className="flex items-center justify-between gap-3">
                  <span>{error}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="关闭终端提示"
                    onClick={() => setError(undefined)}
                  >
                    <X />
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {!onlineStatus ? (
              <Alert role="status">
                <AlertDescription>
                  正在重新连接电脑，恢复后可继续输入。当前输出仍可查看。
                </AlertDescription>
              </Alert>
            ) : restoring ? (
              <div className="terminal-restore-progress" role="status">
                <span>
                  正在恢复输出，完成后即可输入
                  {progress !== undefined ? ` · ${progress}%` : ""}
                </span>
                <progress
                  aria-label="终端恢复进度"
                  max={100}
                  value={progress}
                />
              </div>
            ) : (
              ended && (
                <Alert role="status">
                  <AlertDescription>
                    {closed
                      ? "终端已关闭，无法继续输入。"
                      : info?.interrupted
                        ? "电脑重启或服务中断，终端已停止。原有输出已保留。"
                        : `进程已退出（退出码 ${info?.exitCode}）。原有输出已保留。`}
                  </AlertDescription>
                </Alert>
              )
            )}
          </>
        )}
        {uploading && (
          <div className="terminal-upload-progress" role="status">
            <LoaderCircle className="animate-spin" size={14} />
            <span>上传 {uploading}</span>
          </div>
        )}
        <ErrorNotice error={uploadJob.error} />
        {uploaded.length > 0 && !uploading && (
          <Alert role="status">
            <CheckCircle2 />
            <AlertTitle>已上传 {uploaded.length} 个文件</AlertTitle>
            <AlertDescription>
              <span>
                {uploaded.every((file) => file.inserted)
                  ? "路径已填入终端，按 Enter 前可继续编辑。"
                  : "文件已保存，可复制路径或插入终端。"}
              </span>
              <div className="terminal-upload-paths">
                {uploaded.map((file) => (
                  <code key={file.path}>{file.path}</code>
                ))}
              </div>
              <div className="terminal-upload-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={uploadJob.busy}
                  onClick={() =>
                    void uploadJob.run(async () => {
                      await navigator.clipboard.writeText(
                        uploaded.map((file) => file.path).join("\n"),
                      );
                      setCopied(true);
                    })
                  }
                >
                  {copied ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Copy data-icon="inline-start" />
                  )}
                  {copied ? "已复制" : "复制路径"}
                </Button>
                {uploaded.some((file) => !file.inserted) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canInput}
                    onClick={() => {
                      const target = activeTerm.current;
                      if (!target || !readyForInput.current) return;
                      target.paste(
                        uploaded
                          .filter((file) => !file.inserted)
                          .map((file) => shellPath(file.path))
                          .join(""),
                      );
                      setUploaded((previous) =>
                        previous.map((file) => ({ ...file, inserted: true })),
                      );
                      target.focus();
                    }}
                  >
                    插入终端
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setUploaded([]);
                    uploadJob.clear();
                  }}
                >
                  收起
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>
      <div className="xterm-mount" ref={mount} />
      {dragging && (
        <div className="terminal-drop-target">
          <Upload size={24} />
          <strong>{canInput ? "松开以上传文件" : "终端恢复后才能上传"}</strong>
          <span>保存到工作目录，路径填入终端 · 单个文件最多 30 MB</span>
        </div>
      )}
    </div>
  );
}

function useTerminalList(link: ReturnType<typeof useConnection>["link"]) {
  const [state, setState] = useState<{
    value?: { terminals: TerminalInfo[] };
    loading: boolean;
    error?: string;
  }>({ loading: true });
  const refresh = useRef(() => {});
  useEffect(() => {
    let alive = true;
    let fetching = false;
    const changes = new Map<string, TerminalInfo | null>();
    const fetch = async () => {
      if (fetching || link.status !== "online") return;
      fetching = true;
      changes.clear();
      setState((previous) => ({
        ...previous,
        loading: !previous.value,
        error: undefined,
      }));
      try {
        const result = await link.call("terminals.list", {});
        if (!alive) return;
        const byId = new Map(
          result.terminals.map((terminal) => [terminal.id, terminal]),
        );
        // Changes can arrive while the snapshot RPC is in flight.
        for (const [id, terminal] of changes) {
          if (terminal) byId.set(id, terminal);
          else byId.delete(id);
        }
        setState({ value: { terminals: [...byId.values()] }, loading: false });
      } catch (reason) {
        if (alive)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
      } finally {
        fetching = false;
      }
    };
    const changed = link.on("terminal.changed", ({ terminal, closed }) => {
      changes.set(terminal.id, closed ? null : terminal);
      setState((previous) => {
        if (!previous.value) return previous;
        const terminals = previous.value.terminals.filter(
          (item) => item.id !== terminal.id,
        );
        if (!closed) terminals.push(terminal);
        return { ...previous, value: { terminals } };
      });
    });
    refresh.current = () => void fetch();
    const online = link.onOnline(() => void fetch());
    setState({ loading: true });
    void fetch();
    const timer = setInterval(() => void fetch(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      changed();
      online();
    };
  }, [link]);
  return { ...state, reload: () => refresh.current() };
}
export function Terminals({
  cwd,
  selected,
  onSelect,
}: {
  cwd?: string;
  selected?: string;
  onSelect: (id?: string) => void;
}) {
  const dialogs = useDialogs();
  const { link, computer } = useConnection();
  const load = useTerminalList(link);
  const job = useJob();
  const [creating, setCreating] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [directory, setDirectory] = useState(cwd ?? "");
  const [command, setCommand] = useState("");
  const [visited, setVisited] = useState<string[]>(selected ? [selected] : []);
  const tabList = useRef<HTMLDivElement>(null);
  const pendingSelection = useRef<string | undefined>(undefined);
  const online = useClient((state) => state.status === "online");
  const terminals = useMemo(
    () =>
      load.value?.terminals
        .slice()
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.id.localeCompare(right.id),
        ),
    [load.value?.terminals],
  );
  const current = terminals?.find((terminal) => terminal.id === selected);
  const mounted = [
    ...visited.filter(
      (id) =>
        id !== selected && terminals?.some((terminal) => terminal.id === id),
    ),
    ...(selected ? [selected] : []),
  ].slice(-4);
  const selectionKey = `terminal.${computer.key}`;
  useEffect(() => {
    if (!selected) return;
    setVisited((previous) => {
      const next = [
        ...previous.filter((id) => id !== selected),
        selected,
      ].slice(-4);
      return previous.join("\0") === next.join("\0") ? previous : next;
    });
    const list = tabList.current;
    const tab = list?.querySelector<HTMLElement>('[data-state="active"]');
    if (!list || !tab) return;
    const left = tab.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (left + tab.offsetWidth > list.scrollLeft + list.clientWidth)
      list.scrollLeft = left + tab.offsetWidth - list.clientWidth;
  }, [selected]);
  useEffect(() => {
    if (!terminals) return;
    if (selected && terminals.some((terminal) => terminal.id === selected)) {
      pendingSelection.current = undefined;
      try {
        saveLocal(selectionKey, selected);
      } catch {
        /* Selection should work without storage. */
      }
      return;
    }
    if (selected && selected === pendingSelection.current) return;
    const kept = readLocal<string>(selectionKey, "");
    const next =
      terminals.find((terminal) => terminal.id === kept) ?? terminals[0];
    if (next?.id !== selected) onSelect(next?.id);
  }, [terminals, selected, onSelect, selectionKey]);
  const stopped = current && (current.exitCode != null || current.interrupted);
  function openCreate() {
    job.clear();
    setDirectory(current?.cwd ?? cwd ?? "");
    setCommand("");
    setBrowse(false);
    setCreating(true);
  }
  async function create() {
    const result = await link.call("terminals.create", {
      cwd: directory.trim() || undefined,
      command: command.trim() || undefined,
    });
    // Show the new tab immediately; a background poll must not select the old tab again.
    setCreating(false);
    pendingSelection.current = result.terminal.id;
    load.reload();
    onSelect(result.terminal.id);
  }
  async function closeCurrent() {
    if (!current) return;
    const target = current;
    const ended = target.exitCode != null || target.interrupted;
    const choice = await dialogs.choose(
      `${ended ? "删除" : "关闭"}「${target.title || "Shell"}」？${ended ? "保存的全部输出会被删除。" : "正在运行的进程会结束，保存的全部输出也会被删除。"}工作目录：${target.cwd}`,
      [
        {
          value: "close",
          label: ended ? "删除记录" : "关闭并删除",
          destructive: true,
        },
      ],
    );
    if (choice !== "close") return;
    await job.run(async () => {
      await link.call("terminals.close", { terminalId: target.id });
      const index =
        terminals?.findIndex((terminal) => terminal.id === target.id) ?? -1;
      const next = terminals?.[index + 1] ?? terminals?.[index - 1];
      pendingSelection.current = next?.id;
      onSelect(next?.id);
      load.reload();
    });
  }
  return (
    <section className="terminals-page">
      <div className="page-heading">
        <div>
          <h1>终端</h1>
          <p className="muted">在电脑上运行，在这里继续。</p>
        </div>
        <Button size="sm" disabled={!online} onClick={openCreate}>
          <Plus data-icon="inline-start" />
          新建终端
        </Button>
      </div>
      {!terminals && online && <LoadState loading={load.loading} />}
      {!terminals && !online && (
        <Alert role="status">
          <AlertDescription>
            正在连接电脑，连接恢复后会载入终端。
          </AlertDescription>
        </Alert>
      )}
      <ErrorNotice error={!creating ? job.error : undefined} />
      {load.error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>终端列表暂时无法更新：{load.error}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!online}
              onClick={load.reload}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {terminals?.length ? (
        <Tabs
          className="terminal-workspace gap-0"
          value={selected ?? ""}
          onValueChange={onSelect}
        >
          <div className="terminal-tab-bar">
            <TabsList
              ref={tabList}
              variant="line"
              className="terminal-tab-list min-w-0 flex-1 justify-start overflow-x-auto p-0"
              aria-label="打开的终端"
            >
              {terminals.map((terminal, index) => (
                <TabsTrigger
                  className="h-7 flex-none px-3"
                  key={terminal.id}
                  value={terminal.id}
                  title={`${terminal.title || "Shell"} · ${terminal.cwd}${terminal.interrupted ? " · 已中断" : terminal.exitCode != null ? ` · 已退出 ${terminal.exitCode}` : ""}`}
                >
                  {terminal.exitCode != null || terminal.interrupted ? (
                    <CircleStop data-icon="inline-start" />
                  ) : (
                    <TerminalSquare data-icon="inline-start" />
                  )}
                  <span>{terminal.title || "Shell"}</span>
                  <span className="terminal-tab-number">{index + 1}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            {stopped && (
              <Badge variant={current.interrupted ? "warning" : current.exitCode ? "destructive" : "secondary"}>
                {current.interrupted ? "已中断" : `已退出 ${current.exitCode}`}
              </Badge>
            )}
            {stopped && (
              <Button
                variant="ghost"
                size="sm"
                disabled={job.busy || !online}
                title={
                  current.command
                    ? `在同一目录执行：${current.command}`
                    : "在同一目录打开新的 Shell"
                }
                onClick={() =>
                  void job.run(async () => {
                    const next = await link.call("terminals.create", {
                      cwd: current.cwd,
                      command: current.command,
                    });
                    pendingSelection.current = next.terminal.id;
                    onSelect(next.terminal.id);
                    load.reload();
                  })
                }
              >
                <RotateCw data-icon="inline-start" />
                重新运行
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="新建另一个终端"
              title="新建另一个终端"
              disabled={!online}
              onClick={openCreate}
            >
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={stopped ? "删除当前终端记录" : "关闭当前终端"}
              title={stopped ? "删除当前终端记录" : "关闭当前终端"}
              disabled={!current || job.busy || !online}
              onClick={() => void closeCurrent()}
            >
              <X />
            </Button>
          </div>
          {mounted.map((id) => (
            <TabsContent
              key={id}
              forceMount
              value={id}
              aria-hidden={id !== selected || undefined}
              inert={id !== selected}
              className={cn(
                "terminal-session-panel min-h-0",
                id === selected ? "flex" : "hidden",
              )}
            >
              <Terminal id={id} active={id === selected} />
            </TabsContent>
          ))}
        </Tabs>
      ) : online && !load.loading && !load.error ? (
        <EmptyState
          title="一个随时能回来的终端"
          description="Shell 持续运行在当前电脑。刷新网页后，也能继续查看输出和执行命令。"
        >
          <Button disabled={!online} onClick={openCreate}>
            <Plus data-icon="inline-start" />
            创建第一个终端
          </Button>
        </EmptyState>
      ) : null}
      {creating && (
        <Modal
          title="新建终端"
          close={() => {
            if (job.busy) return;
            setCreating(false);
            setBrowse(false);
          }}
          wide={browse}
        >
          {browse ? (
            <>
              <Button
                className="self-start"
                variant="ghost"
                onClick={() => setBrowse(false)}
              >
                返回终端设置
              </Button>
              <Files
                start={directory || cwd}
                directoriesOnly
                onPick={(path) => {
                  setDirectory(path);
                  setBrowse(false);
                }}
              />
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void job.run(create);
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="terminal-directory">工作目录</FieldLabel>
                  <div className="terminal-directory-input">
                    <Input
                      autoFocus
                      id="terminal-directory"
                      placeholder="留空使用主目录"
                      value={directory}
                      disabled={job.busy}
                      onChange={(event) => setDirectory(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="浏览工作目录"
                      disabled={job.busy}
                      onClick={() => setBrowse(true)}
                    >
                      <FolderOpen />
                    </Button>
                  </div>
                  <FieldDescription>
                    {directory
                      ? `在 ${baseName(directory)} 中打开 Shell`
                      : "目录位于当前连接的电脑。"}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="terminal-command">
                    启动命令 <span className="muted">（可选）</span>
                  </FieldLabel>
                  <Input
                    id="terminal-command"
                    placeholder="例如 pnpm dev"
                    value={command}
                    maxLength={4000}
                    disabled={job.busy}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                  <FieldDescription>
                    留空打开默认 Shell，可随时输入命令。
                  </FieldDescription>
                </Field>
                <ErrorNotice error={job.error} />
                <div className="dialog-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={job.busy}
                    onClick={() => setCreating(false)}
                  >
                    取消
                  </Button>
                  <Button disabled={job.busy || !online}>
                    {job.busy ? "正在创建…" : "创建终端"}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          )}
        </Modal>
      )}
    </section>
  );
}
