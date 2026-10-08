import { fileBase64 } from "./Files";
import { readLocal, saveLocal } from "./storage";
import { replayTerminal, writeTerminal } from "./terminal-replay";
import { useDialogs } from "@/components/Dialogs";
import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  ErrorNotice,
  LoadState,
  useConnection,
  useClient,
  useJob,
  useLoad,
} from "./common";

export function Terminal({ id }: { id: string }) {
  const { link } = useConnection();
  const mount = useRef<HTMLDivElement>(null);
  const activeTerm = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const readyForInput = useRef(false);
  const onlineStatus = useClient((state) => state.status === "online");
  const [restoring, setRestoring] = useState(true);
  const [retry, setRetry] = useState(0);
  const [fontSize, setFontSize] = useState(() =>
    Math.max(10, Math.min(24, readLocal("terminalFontSize", 13))),
  );
  const uploadJob = useJob();
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;
  async function uploadFiles(files: File[]) {
    const target = activeTerm.current;
    if (!target || !readyForInput.current || !files.length) return;
    const result = await link.call("terminals.list", {});
    const terminal = result.terminals.find((item) => item.id === id);
    if (!terminal || terminal.exitCode != null || terminal.interrupted)
      throw new Error("终端已停止");
    for (const file of files) {
      const saved = await link.call(
        "fs.upload",
        { dir: terminal.cwd, name: file.name, data: await fileBase64(file) },
        180000,
      );
      if (activeTerm.current !== target) return;
      if (!readyForInput.current)
        throw new Error(`文件已上传到 ${saved.path}，请在终端恢复后粘贴路径。`);
      target.paste("'" + saved.path.replaceAll("'", "'\"'\"'") + "' ");
    }
    target.focus();
  }
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!mount.current) return;
    const term = new Xterm({
      fontFamily: "Menlo, Consolas, monospace",
      fontSize: fontRef.current,
      cursorBlink: true,
      scrollback: 10000,
      theme: {
        background: "#17181d",
        foreground: "#e4e4ec",
        cursor: "#7d95ff",
      },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    activeTerm.current = term;
    fitRef.current = fit;
    term.open(mount.current);
    const syncTheme = () => {
      const styles = getComputedStyle(document.documentElement);
      term.options.theme = {
        background: styles.getPropertyValue("--code").trim(),
        foreground: styles.getPropertyValue("--codeText").trim(),
        cursor: styles.getPropertyValue("--accent").trim(),
      };
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    fit.fit();
    let alive = true;
    let attaching = false;
    let seq: number | undefined;
    let generation = 0;
    let frame: number | undefined;
    let chain = Promise.resolve();
    let queuedBytes = 0;
    let overflowed = false;
    const queued: {
      seq: number;
      frame?: number;
      data: string;
      cols?: number;
      rows?: number;
    }[] = [];
    const apply = async (event: {
      seq: number;
      frame?: number;
      data: string;
      cols?: number;
      rows?: number;
    }) => {
      if (event.seq <= (seq ?? -1)) return;
      if (
        event.cols &&
        event.rows &&
        (term.cols !== event.cols || term.rows !== event.rows)
      )
        term.resize(event.cols, event.rows);
      await writeTerminal(term, event.data);
      if (!alive) return;
      frame = event.frame;
      seq = event.seq;
    };
    const attach = () => {
      if (!alive || link.status !== "online") return;
      attaching = true;
      readyForInput.current = false;
      setRestoring(true);
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
            });
            if (!alive || generation !== current) return;
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
            );
            if (!alive || generation !== current) return;
            seq = result.seq;
            frame = result.recording?.throughFrame;
            if (overflowed) {
              attach();
              return;
            }
            while (queued.length && alive && generation === current) {
              const event = queued.shift()!;
              queuedBytes -= event.data.length;
              await apply(event);
            }
            if (!alive || generation !== current) return;
            attaching = false;
            setError(undefined);
            fit.fit();
            await link.call("terminals.resize", {
              terminalId: id,
              cols: Math.max(10, term.cols),
              rows: Math.max(4, term.rows),
            });
          } catch (error) {
            if (alive && generation === current) {
              attaching = false;
              seq = undefined;
              frame = undefined;
              setError(error instanceof Error ? error.message : String(error));
            }
          }
        });
    };
    const output = link.on("terminal.output", (event) => {
      if (event.terminalId !== id) return;
      if (attaching) {
        if (!overflowed) {
          queuedBytes += event.data.length;
          if (queuedBytes > 4 * 1024 * 1024) {
            queued.length = 0;
            overflowed = true;
          } else queued.push(event);
        }
      } else
        chain = chain
          .then(() => (alive ? apply(event) : undefined))
          .catch(() => attach());
    });
    const input = term.onData((data) => {
      // Replay can contain terminal queries; never send their historical replies back to the shell.
      if (attaching) return;
      if (link.status !== "online") {
        setError("连接已断开，输入未发送");
        return;
      }
      void link
        .call("terminals.input", { terminalId: id, data })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    });
    const online = link.onOnline(attach);
    const status = link.onStatus((state) => {
      if (state !== "online") {
        generation++;
        attaching = true;
        readyForInput.current = false;
        setRestoring(true);
      }
    });
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!alive || attaching) return;
        fit.fit();
        if (link.status === "online")
          void link
            .call("terminals.resize", {
              terminalId: id,
              cols: Math.max(10, term.cols),
              rows: Math.max(4, term.rows),
            })
            .catch(() => {});
      }, 120);
    });
    observer.observe(mount.current);
    void attach();
    return () => {
      alive = false;
      generation++;
      clearTimeout(timer);
      observer.disconnect();
      themeObserver.disconnect();
      output();
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
    saveLocal("terminalFontSize", fontSize);
    if (readyForInput.current) {
      fitRef.current?.fit();
      void link
        .call("terminals.resize", {
          terminalId: id,
          cols: Math.max(10, term.cols),
          rows: Math.max(4, term.rows),
        })
        .catch(() => {});
    }
  }, [fontSize, link, id]);
  return (
    <div
      className="terminal-live"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void uploadJob.run(() =>
          uploadFiles(Array.from(event.dataTransfer.files)),
        );
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          void uploadJob.run(() =>
            uploadFiles(Array.from(event.clipboardData.files)),
          );
        }
      }}
    >
      <div className="browser-toolbar">
        <button
          className="text-button"
          aria-label="缩小终端字号"
          disabled={fontSize <= 10}
          onClick={() => setFontSize((value) => value - 1)}
        >
          A−
        </button>
        <span>{fontSize}px</span>
        <button
          className="text-button"
          aria-label="放大终端字号"
          disabled={fontSize >= 24}
          onClick={() => setFontSize((value) => value + 1)}
        >
          A+
        </button>
        <label className="text-button">
          上传文件
          <input
            type="file"
            multiple
            hidden
            disabled={uploadJob.busy || restoring || !onlineStatus}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadJob.run(() => uploadFiles(files));
            }}
          />
        </label>
        {restoring && <span role="status">正在恢复终端…</span>}
        {error && (
          <button
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            重新连接终端
          </button>
        )}
      </div>
      <ErrorNotice error={error ?? uploadJob.error} />
      <div className="xterm-mount" ref={mount} />
    </div>
  );
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
  const { link } = useConnection();
  const load = useLoad(() => link.call("terminals.list", {}), [link], 5000);
  const job = useJob();
  const [directory, setDirectory] = useState(cwd ?? "");
  const [command, setCommand] = useState("");
  const online = useClient((state) => state.status === "online");
  return (
    <section className="terminals-page">
      <div className="browser-toolbar">
        <h2>终端</h2>
        <input
          aria-label="终端工作目录"
          placeholder="工作目录（默认主目录）"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
        />
        <input
          aria-label="终端启动命令"
          placeholder="启动命令（可选）"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
        <button
          className="button primary"
          disabled={job.busy || !online}
          onClick={() =>
            void job.run(async () => {
              const result = await link.call("terminals.create", {
                cwd: directory || undefined,
                command: command.trim() || undefined,
              });
              onSelect(result.terminal.id);
              load.reload();
            })
          }
        >
          新建终端
        </button>
      </div>
      <LoadState {...load} />
      <ErrorNotice error={job.error} />
      <div className="terminal-tabs">
        {load.value?.terminals.map((terminal) => (
          <div
            key={terminal.id}
            className={terminal.id === selected ? "selected" : ""}
          >
            <button onClick={() => onSelect(terminal.id)}>
              {terminal.title}
              <small>
                {terminal.exitCode != null
                  ? `已退出 ${terminal.exitCode}`
                  : terminal.interrupted
                    ? "已中断"
                    : terminal.cwd}
              </small>
            </button>
            {(terminal.exitCode != null || terminal.interrupted) && (
              <button
                className="text-button"
                disabled={job.busy || !online}
                onClick={() =>
                  void job.run(async () => {
                    const next = await link.call("terminals.create", {
                      cwd: terminal.cwd,
                      command: terminal.command,
                    });
                    onSelect(next.terminal.id);
                    load.reload();
                  })
                }
              >
                重新运行
              </button>
            )}
            <button
              aria-label={`关闭终端 ${terminal.title}`}
              onClick={async () => {
                if (
                  await dialogs.confirm("关闭这个终端？其中运行的进程会结束。")
                )
                  void job.run(async () => {
                    await link.call("terminals.close", {
                      terminalId: terminal.id,
                    });
                    if (terminal.id === selected) onSelect(undefined);
                    load.reload();
                  });
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {selected ? (
        <Terminal key={selected} id={selected} />
      ) : (
        <p className="muted">选择一个终端，或新建 Shell。</p>
      )}
    </section>
  );
}
