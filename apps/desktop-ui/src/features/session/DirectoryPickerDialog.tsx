import { useCallback, useEffect, useState } from "react";
import type { DirectoryEntry } from "@linkshell/wire";
import { reportDesktopError, type Connection } from "@/core";
import { DesktopIcon } from "@/icons";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  isImeComposing,
  useDialogs,
} from "@/primitives";
import { describeActionError, parentOfPath, useSessionCopy } from "./session-helpers";

export interface DirectoryPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: Connection | undefined;
  initialPath: string;
  onSelect: (path: string) => void;
}

export function DirectoryPickerDialog({
  open,
  onOpenChange,
  connection,
  initialPath,
  onSelect,
}: DirectoryPickerDialogProps) {
  const copy = useSessionCopy();
  const dialogs = useDialogs();

  const [currentPath, setCurrentPath] = useState(initialPath);
  const [parentPath, setParentPath] = useState<string | undefined>();
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  // The highlighted row: a single click picks it, a double click goes into it.
  const [selectedPath, setSelectedPath] = useState<string | undefined>();

  const loadDirectory = useCallback(
    async (targetPath?: string) => {
      if (!connection) return;
      setLoading(true);
      setLoadError(undefined);
      try {
        const res = await connection.link.call("fs.list", {
          path: targetPath?.trim() || undefined,
          hidden: false,
          files: false,
        });
        setCurrentPath(res.path);
        setParentPath(res.parent);
        setEntries((res.entries ?? []).filter((item) => !item.file));
        setSelectedPath(undefined);
        setSearchQuery("");
      } catch (error) {
        // A stale listing of the previous folder would read as this one's contents.
        setEntries([]);
        setLoadError(describeActionError(error, copy.directoryLoadFailed));
      } finally {
        setLoading(false);
      }
    },
    [connection, copy.directoryLoadFailed],
  );

  useEffect(() => {
    if (!open || !connection) return;
    void loadDirectory(initialPath);
  }, [connection, initialPath, loadDirectory, open]);

  // Support global `fs.search` when user types >=2 chars, or client-side filter for 1 char
  const [remoteMatches, setRemoteMatches] = useState<DirectoryEntry[] | null>(null);
  useEffect(() => {
    if (!open || !connection) return;
    const q = searchQuery.trim();
    if (q.length < 2) {
      setRemoteMatches(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void connection.link
        .call("fs.search", { query: q, limit: 60 })
        .then((res) => {
          if (alive) setRemoteMatches(res.entries ?? []);
        })
        .catch(() => {
          if (alive) setRemoteMatches(null);
        });
    }, 140);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [connection, open, searchQuery]);

  const displayedEntries =
    remoteMatches ??
    (searchQuery.trim()
      ? entries.filter((e) =>
          e.name.toLowerCase().includes(searchQuery.trim().toLowerCase()),
        )
      : entries);

  const handleCreateFolder = async () => {
    if (!connection || !currentPath) return;
    const name = await dialogs.prompt(copy.folderNamePrompt, "");
    if (!name?.trim()) return;
    try {
      const created = await connection.link.call("fs.mkdir", {
        parent: currentPath,
        name: name.trim(),
      });
      await loadDirectory(created.path);
    } catch (error) {
      reportDesktopError(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md">
      <DialogHeader>
        <DialogTitle>{copy.selectDirectory}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="ls-dir-browser">
          <div className="ls-dir-path-bar">
            <Input
              value={currentPath}
              placeholder={copy.directoryPlaceholder}
              onChange={(e) => setCurrentPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e)) {
                  e.preventDefault();
                  void loadDirectory(currentPath);
                }
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={loading || (!parentPath && currentPath === parentOfPath(currentPath))}
              onClick={() => void loadDirectory(parentPath ?? parentOfPath(currentPath))}
            >
              {copy.parentDirectory}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon="folder-plus"
              disabled={loading || !currentPath}
              onClick={() => void handleCreateFolder()}
            >
              {copy.newFolder}
            </Button>
          </div>

          <Input
            type="search"
            value={searchQuery}
            placeholder={copy.searchDirectories}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <div className="ls-dir-list" role="listbox" aria-label={copy.selectDirectory}>
            {displayedEntries.length === 0 ? (
              <div className="ls-dir-empty" role={loadError ? "alert" : "status"}>
                {loading ? copy.loadingDirectory : loadError ?? copy.emptyDirectory}
              </div>
            ) : (
              displayedEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={entry.path === selectedPath}
                  className="ls-dir-entry"
                  onClick={() => setSelectedPath(entry.path)}
                  onDoubleClick={() => {
                    setRemoteMatches(null);
                    void loadDirectory(entry.path);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isImeComposing(e)) {
                      e.preventDefault();
                      setRemoteMatches(null);
                      void loadDirectory(entry.path);
                    }
                  }}
                >
                  <DesktopIcon
                    name={entry.project ? "folder-open" : "folder"}
                    size="sm"
                  />
                  <span style={{ fontWeight: entry.project ? 500 : 400 }}>{entry.name}</span>
                  {remoteMatches && (
                    <span className="ls-dir-entry-path">
                      {entry.path}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {copy.cancelAction}
        </Button>
        <Button
          variant="primary"
          disabled={!(selectedPath ?? currentPath).trim()}
          onClick={() => {
            onSelect((selectedPath ?? currentPath).trim());
            onOpenChange(false);
          }}
        >
          {copy.useThisDirectory}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
