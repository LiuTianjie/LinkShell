import { useEffect, useState, useCallback } from "react";
import type { WorkspaceStore } from "../store/workspace-store";
import { IconClose, IconArrowUp, IconRefresh, IconFolder } from "./icons";
import type { BrowseEntry } from "../lib/types";

// Directory picker shown before creating a conversation, so the agent starts in
// the right working directory. Reuses the host's terminal.browse (directories
// only). The currently-browsed path is itself the selectable target.

export function FolderPicker({
  store,
  initialPath,
  providerLabel,
  onCancel,
  onConfirm,
}: {
  store: WorkspaceStore;
  initialPath: string;
  providerLabel: string;
  onCancel: () => void;
  onConfirm: (cwd: string) => void;
}) {
  const [path, setPath] = useState(initialPath || ".");
  const [dirs, setDirs] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await store.browse(target, false); // directories only
        if (res.error) {
          setError(res.error);
        } else {
          setPath(res.path);
          setDirs(
            res.entries
              .filter((e) => e.isDirectory)
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        }
      } catch (e: any) {
        setError(e.message || "无法读取目录");
      } finally {
        setLoading(false);
      }
    },
    [store],
  );

  useEffect(() => {
    browse(initialPath || ".");
  }, [browse, initialPath]);

  const parentPath = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="codex-card flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">选择工作目录 · {providerLabel}</h3>
          <button onClick={onCancel} className="codex-btn-ghost px-2 py-1.5" aria-label="取消">
            <IconClose size={15} />
          </button>
        </div>

        {/* Path bar */}
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
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

        {error && <p className="px-4 py-2 text-2xs text-danger">{error}</p>}

        {/* Directory list */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <p className="px-4 py-3 text-2xs text-content-muted">加载中…</p>
          ) : dirs.length === 0 ? (
            <p className="px-4 py-3 text-2xs text-content-faint">（无子目录）</p>
          ) : (
            dirs.map((d) => (
              <button
                key={d.path}
                onClick={() => browse(d.path)}
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-surface-overlay"
              >
                <IconFolder size={13} className="shrink-0 text-content-faint" />
                <span className="truncate font-mono text-2xs text-content-primary">{d.name}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer: confirm current dir */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="truncate font-mono text-2xs text-content-muted" title={path}>
            将在此创建：{path}
          </span>
          <button onClick={() => onConfirm(path)} disabled={loading} className="codex-btn-primary text-2xs">
            在此新建
          </button>
        </div>
      </div>
    </div>
  );
}
