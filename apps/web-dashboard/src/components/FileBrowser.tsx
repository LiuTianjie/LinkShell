import { useEffect, useState, useCallback } from "react";
import type { WorkspaceStore } from "../store/workspace-store";
import type { BrowseEntry } from "../lib/types";
import { IconClose, IconArrowUp, IconRefresh, IconFolder, IconFile } from "./icons";

// File drawer: browse the host filesystem (terminal.browse) and read files
// (terminal.file.read). Read-only viewer, monospace, Codex-style.

export function FileBrowser({
  store,
  initialPath,
  onClose,
}: {
  store: WorkspaceStore;
  initialPath: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath || ".");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);

  const browse = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      setFileView(null);
      try {
        const res = await store.browse(target, true);
        if (res.error) {
          setError(res.error);
        } else {
          setPath(res.path);
          setEntries(
            [...res.entries].sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            }),
          );
        }
      } catch (e: any) {
        setError(e.message || "浏览失败");
      } finally {
        setLoading(false);
      }
    },
    [store],
  );

  useEffect(() => {
    browse(initialPath || ".");
  }, [browse, initialPath]);

  const openFile = async (entry: BrowseEntry) => {
    setLoading(true);
    setError(null);
    try {
      const res = await store.readFile(entry.path);
      if (res.error) setError(res.error);
      else setFileView({ path: res.path, content: res.content, truncated: res.truncated });
    } catch (e: any) {
      setError(e.message || "读取失败");
    } finally {
      setLoading(false);
    }
  };

  const parentPath = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 font-mono text-2xs text-content-secondary">
          <IconFolder size={13} className="text-content-faint" /> 文件
        </span>
        <button onClick={onClose} className="codex-btn-ghost px-2 py-1.5" aria-label="关闭文件面板">
          <IconClose size={15} />
        </button>
      </div>

      {/* Path bar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          onClick={() => browse(parentPath)}
          disabled={loading}
          className="cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-overlay hover:text-accent"
          title="上级目录"
          aria-label="上级目录"
        >
          <IconArrowUp size={14} />
        </button>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && browse(path)}
          className="flex-1 bg-transparent font-mono text-2xs text-content-primary outline-none"
        />
        <button
          onClick={() => browse(path)}
          disabled={loading}
          className="cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-overlay hover:text-accent"
          title="刷新"
          aria-label="刷新"
        >
          <IconRefresh size={14} />
        </button>
      </div>

      {error && <p className="px-3 py-1.5 text-2xs text-danger">{error}</p>}

      {/* Body: file view OR directory list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <p className="px-3 py-2 text-2xs text-content-muted">加载中…</p>}
        {!loading && fileView ? (
          <div>
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="truncate font-mono text-2xs text-content-secondary">{fileView.path}</span>
              <button onClick={() => setFileView(null)} className="codex-btn-ghost text-2xs">
                返回
              </button>
            </div>
            <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-2xs leading-relaxed text-content-secondary">
              {fileView.content}
              {fileView.truncated && <span className="text-warning">{"\n…（已截断）"}</span>}
            </pre>
          </div>
        ) : (
          !loading &&
          entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => (entry.isDirectory ? browse(entry.path) : openFile(entry))}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-surface-overlay"
            >
              {entry.isDirectory ? (
                <IconFolder size={13} className="shrink-0 text-content-faint" />
              ) : (
                <IconFile size={13} className="shrink-0 text-content-faint" />
              )}
              <span className="truncate font-mono text-2xs text-content-primary">{entry.name}</span>
              {!entry.isDirectory && entry.size != null && (
                <span className="ml-auto font-mono text-2xs text-content-faint">{entry.size}B</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
