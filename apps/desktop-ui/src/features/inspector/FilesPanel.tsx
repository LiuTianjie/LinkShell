import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import {
  toBase64,
  type AgentInfo,
  type DirectoryEntry,
} from "@linkshell/wire";
import type { NativeContextMenuItem } from "../../bridge/desktop-bridge";
import type { Connection } from "../../core/connections";
import {
  STORAGE_KEYS,
  readLocal,
  saveLocal,
} from "../../core/storage";
import { DesktopIcon } from "../../icons";
import {
  Button,
  ContextMenu,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
  useDialogs,
} from "../../primitives";
import { FileExtBadge } from "./file-ext-badge";
import {
  INSPECTOR_FILE_SAVED_EVENT,
  INSPECTOR_FOCUS_FILE_SEARCH_EVENT,
  takeFileSearchFocus,
} from "./inspector-tabs-store";
import {
  canOpenOnThisComputer,
  formatByteSize,
  openPathInExternalApp,
  parseFileSpec,
  triggerRemoteFileDownload,
  type ExternalOpenTarget,
  type ParsedFileSpec,
} from "./FileViewerTabPanel";
import {
  useConnectionTargetPlatform,
  useInspectorI18n,
} from "./i18n-inspector";

export { parseFileSpec, type ExternalOpenTarget, type ParsedFileSpec };

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function joinChildPath(parent: string, childName: string): string {
  const sep = parent.includes("\\") ? "\\" : "/";
  const trimmed = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return `${trimmed}${sep}${childName}`;
}

function folderDisplayName(dirPath: string | undefined): string {
  if (!dirPath) return "~";
  const cleaned = dirPath.replace(/[\\/]+$/, "");
  if (!cleaned) return "/";
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

function splitSearchEntryLabel(rawName: string): {
  base: string;
  relDir: string;
} {
  const norm = rawName.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx <= 0) {
    return { base: rawName, relDir: "" };
  }
  return {
    base: norm.slice(idx + 1) || rawName,
    relDir: norm.slice(0, idx),
  };
}

export interface FilesPanelProps {
  connection?: Connection;
  online: boolean;
  cwd?: string;
  agents?: AgentInfo[];
  initialFileSpec?: string;
  onOpenFile?: (specOrPath: string) => void;
  onOpenTerminalAt?: (dir: string) => void;
}

export function FilesPanel({
  connection,
  online,
  cwd,
  initialFileSpec,
  onOpenFile,
  onOpenTerminalAt,
}: FilesPanelProps): JSX.Element {
  const targetPlatform = useConnectionTargetPlatform(connection);
  const { t, ti, revealLabel } = useInspectorI18n(targetPlatform);
  const dialogs = useDialogs();

  const [showHidden, setShowHidden] = useState<boolean>(() =>
    readLocal<boolean>(STORAGE_KEYS.hiddenFilesShown, false),
  );

  const [currentDir, setCurrentDir] = useState<string>(cwd ?? "");
  const [parentDir, setParentDir] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [dirTruncated, setDirTruncated] = useState(false);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<DirectoryEntry[] | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | undefined>(
    undefined,
  );

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const searchWrapRef = useRef<HTMLDivElement | null>(null);
  const openLocally = canOpenOnThisComputer(connection);

  useEffect(() => {
    const focusSearch = () => {
      const input = searchWrapRef.current?.querySelector<HTMLInputElement>("input");
      if (!input) return;
      takeFileSearchFocus();
      input.focus();
      input.select();
    };
    if (takeFileSearchFocus()) focusSearch();
    window.addEventListener(INSPECTOR_FOCUS_FILE_SEARCH_EVENT, focusSearch);
    return () => window.removeEventListener(INSPECTOR_FOCUS_FILE_SEARCH_EVENT, focusSearch);
  }, []);

  const copyPath = useCallback((path: string) => {
    void navigator.clipboard?.writeText(path).catch(() => undefined);
  }, []);
  const dirLoadSeqRef = useRef(0);
  const forwardedInitialSpecRef = useRef<string | undefined>(undefined);
  const prevRootRef = useRef<{ connection?: Connection; cwd?: string }>({
    connection,
    cwd,
  });

  const loadDirectory = useCallback(
    async (targetDir?: string, hiddenOverride?: boolean) => {
      if (!connection || !online) return;
      const reqSeq = ++dirLoadSeqRef.current;
      setDirLoading(true);
      setDirError(null);
      try {
        const effectivePath =
          targetDir !== undefined
            ? targetDir || undefined
            : currentDir || cwd || undefined;
        const res = await connection.link.call("fs.list", {
          path: effectivePath,
          files: true,
          hidden: hiddenOverride ?? showHidden,
        });
        if (reqSeq !== dirLoadSeqRef.current) return;
        setCurrentDir(res?.path ?? "");
        setParentDir(res?.parent);
        setEntries(Array.isArray(res?.entries) ? res.entries : []);
        setDirTruncated(Boolean(res?.truncated));
        setDirError(null);
      } catch (err) {
        if (reqSeq !== dirLoadSeqRef.current) return;
        setEntries([]);
        setParentDir(undefined);
        setDirError(err instanceof Error ? err.message : String(err));
      } finally {
        if (reqSeq === dirLoadSeqRef.current) {
          setDirLoading(false);
        }
      }
    },
    [connection, online, currentDir, cwd, showHidden],
  );

  useEffect(() => {
    const prev = prevRootRef.current;
    const rootChanged = prev.connection !== connection || prev.cwd !== cwd;
    if (rootChanged) {
      prevRootRef.current = { connection, cwd };
      dirLoadSeqRef.current += 1;
      const nextRoot = cwd ?? "";
      setCurrentDir(nextRoot);
      setParentDir(undefined);
      setEntries([]);
      setDirError(null);
      setSearchQuery("");
      setSearchHits(null);
      setActiveFilePath(undefined);
      if (connection && online) {
        void loadDirectory(nextRoot);
      }
      return;
    }
    if (!connection || !online) return;
    void loadDirectory(currentDir || cwd || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload when host comes online, root cwd changes, or hidden toggle changes.
  }, [connection, online, cwd, showHidden]);

  // Saving from the viewer changes a size and a time this list shows.
  useEffect(() => {
    const reload = () => {
      if (connection && online) void loadDirectory(currentDir || cwd || "");
    };
    window.addEventListener(INSPECTOR_FILE_SAVED_EVENT, reload);
    return () => window.removeEventListener(INSPECTOR_FILE_SAVED_EVENT, reload);
  }, [connection, online, currentDir, cwd, loadDirectory]);

  useEffect(() => {
    if (
      initialFileSpec &&
      onOpenFile &&
      forwardedInitialSpecRef.current !== initialFileSpec
    ) {
      forwardedInitialSpecRef.current = initialFileSpec;
      const parsed = parseFileSpec(initialFileSpec);
      setActiveFilePath(parsed.path);
      onOpenFile(initialFileSpec);
    }
  }, [initialFileSpec, onOpenFile]);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed || !connection || !online) {
      setSearchHits(null);
      return undefined;
    }
    const base = currentDir || cwd;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (base) {
            const proj = await connection.link.call("fs.projectFiles", {
              cwd: base,
              query: trimmed,
              limit: 80,
            });
            if (!cancelled) {
              const projFiles = Array.isArray(proj?.files) ? proj.files : [];
              setSearchHits(
                projFiles.map((f) => ({
                  name: f.relativePath,
                  path: f.path,
                  file: !f.isDir,
                })),
              );
              return;
            }
          }
        } catch {
          // Fall back to fs.search or local filter on older hosts.
        }
        try {
          const fallback = await connection.link.call("fs.search", {
            query: trimmed,
            limit: 60,
          });
          if (!cancelled) {
            setSearchHits(
              Array.isArray(fallback?.entries) ? fallback.entries : [],
            );
          }
        } catch {
          if (!cancelled) {
            const lower = trimmed.toLowerCase();
            setSearchHits(
              entries.filter((e) => e.name.toLowerCase().includes(lower)),
            );
          }
        }
      })();
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, connection, online, currentDir, cwd, entries]);

  const handleOpenExternal = useCallback(
    async (targetPath: string, app: ExternalOpenTarget) => {
      try {
        await openPathInExternalApp({
          targetPath,
          app,
          connection,
          onOpenTerminalAt,
        });
      } catch (err) {
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      }
    },
    [connection, dialogs, onOpenTerminalAt],
  );

  const handleDownload = useCallback(
    async (targetPath: string) => {
      if (!connection) return;
      try {
        await triggerRemoteFileDownload(connection, targetPath);
      } catch (err) {
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      }
    },
    [connection, dialogs],
  );

  const handleCreateFolder = useCallback(async () => {
    const parent = currentDir || cwd;
    if (!connection || !parent) return;
    const name = await dialogs.prompt(ti("newFolderPrompt"), {
      title: ti("newFolder"),
      placeholder: "src",
      submitLabel: ti("newFolder"),
      cancelLabel: ti("cancel"),
    });
    if (!name) return;
    try {
      await connection.link.call("fs.mkdir", { parent, name });
      await loadDirectory(parent);
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    }
  }, [currentDir, cwd, connection, dialogs, ti, loadDirectory]);

  const handleUploadChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      const dir = currentDir || cwd;
      if (!connection || !dir || files.length === 0) return;

      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          await dialogs.alert(ti("uploadTooLarge", { name: file.name }));
          continue;
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await connection.link.call("fs.upload", {
            dir,
            name: file.name,
            data: toBase64(bytes),
          });
        } catch (err) {
          await dialogs.alert(err instanceof Error ? err.message : String(err));
        }
      }
      await loadDirectory(dir);
    },
    [currentDir, cwd, connection, dialogs, ti, loadDirectory],
  );

  const toggleShowHidden = useCallback(() => {
    setShowHidden((prev) => {
      const next = !prev;
      saveLocal(STORAGE_KEYS.hiddenFilesShown, next);
      return next;
    });
  }, []);

  const handleOpenEntry = useCallback(
    (entryPath: string, isFile: boolean) => {
      if (isFile) {
        setActiveFilePath(entryPath);
        onOpenFile?.(entryPath);
      } else {
        setSearchQuery("");
        void loadDirectory(entryPath);
      }
    },
    [loadDirectory, onOpenFile],
  );

  const displayedEntries = searchHits ?? entries;
  const activeDirPath = currentDir || cwd || "";
  const isSearching = Boolean(searchHits);

  return (
    <div
      className="ls-files-explorer inspector-panel-fill"
      data-testid="files-explorer-panel"
    >
      <div className="ls-files-header inspector-subbar">
        <div className="ls-files-header__left">
          <IconButton
            icon="arrow-up"
            size="icon-sm"
            label={ti("parentDir")}
            disabled={!parentDir || !online}
            onClick={() => {
              if (parentDir) void loadDirectory(parentDir);
            }}
          />
          <span
            className="ls-files-header__title ls-truncate"
            title={activeDirPath || "~"}
          >
            {folderDisplayName(activeDirPath)}
          </span>
        </div>

        <div className="ls-files-header__actions">
          <IconButton
            icon="refresh"
            size="icon-sm"
            label={ti("refresh")}
            loading={dirLoading}
            disabled={!online}
            onClick={() => {
              void loadDirectory();
            }}
          />

          <Menu
            label={ti("moreActions")}
            trigger={
              <IconButton
                icon="more-horizontal"
                size="icon-sm"
                label={ti("moreActions")}
              />
            }
          >
            <MenuCheckboxItem
              checked={showHidden}
              onCheckedChange={() => toggleShowHidden()}
            >
              {t("desktop.inspector.showHidden")}
            </MenuCheckboxItem>
            <MenuItem
              icon="folder-plus"
              disabled={!online || !activeDirPath}
              onSelect={() => {
                void handleCreateFolder();
              }}
            >
              {ti("newFolder")}
            </MenuItem>
            <MenuItem
              icon="upload"
              disabled={!online || !activeDirPath}
              onSelect={() => uploadInputRef.current?.click()}
            >
              {ti("uploadFiles")}
            </MenuItem>
            {activeDirPath ? (
              <>
                {openLocally ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon="code"
                      onSelect={() => {
                        void handleOpenExternal(activeDirPath, "vscode");
                      }}
                    >
                      {ti("openInVscode")}
                    </MenuItem>
                    <MenuItem
                      icon="code"
                      onSelect={() => {
                        void handleOpenExternal(activeDirPath, "cursor");
                      }}
                    >
                      {ti("openInCursor")}
                    </MenuItem>
                    <MenuItem
                      icon="folder-open"
                      onSelect={() => {
                        void handleOpenExternal(activeDirPath, "reveal");
                      }}
                    >
                      {revealLabel}
                    </MenuItem>
                  </>
                ) : null}
                <MenuSeparator />
                <MenuItem
                  icon="terminal"
                  onSelect={() => {
                    void handleOpenExternal(activeDirPath, "terminal");
                  }}
                >
                  {ti("openInTerminal")}
                </MenuItem>
              </>
            ) : null}
          </Menu>

          <input
            ref={uploadInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void handleUploadChange(e);
            }}
          />
        </div>
      </div>

      <div className="ls-files-search" ref={searchWrapRef}>
        <Input
          size="sm"
          type="search"
          leadingIcon="search"
          value={searchQuery}
          placeholder={ti("filterFilesPlaceholder")}
          aria-label={ti("filterFilesPlaceholder")}
          trailingSlot={
            searchQuery ? (
              <IconButton
                icon="close"
                size="icon-sm"
                label={ti("clearComments")}
                onClick={() => setSearchQuery("")}
              />
            ) : undefined
          }
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div
        className="ls-files-list inspector-files-list inspector-panel-scroll"
        role="list"
      >
        {dirError ? (
          <EmptyState
            compact
            icon="folder"
            title={ti("missingDirTitle")}
            description={dirError}
            actions={
              <Button
                size="xs"
                variant="secondary"
                leadingIcon="folder-open"
                onClick={() => {
                  const homeDir =
                    connection?.store.getState().machine?.home ?? "";
                  setDirError(null);
                  setCurrentDir(homeDir);
                  void loadDirectory(homeDir);
                }}
              >
                {ti("openHomeDir")}
              </Button>
            }
          />
        ) : displayedEntries.length === 0 && isSearching ? (
          <EmptyState compact icon="search" title={ti("noSearchHitsTitle")} />
        ) : displayedEntries.length === 0 ? (
          <EmptyState
            compact
            icon="folder"
            title={ti("emptyDirTitle")}
            description={ti("emptyDirHiddenHint")}
            actions={
              <Button
                size="xs"
                variant="secondary"
                leadingIcon={showHidden ? "eye-off" : "eye"}
                onClick={toggleShowHidden}
              >
                {t("desktop.inspector.showHidden")}
              </Button>
            }
          />
        ) : (
          <>
          {dirTruncated && !isSearching ? (
            <div className="inspector-banner" role="status">
              <span>{ti("dirTruncatedNote")}</span>
            </div>
          ) : null}
          {displayedEntries.map((entry) => {
            const isFile = Boolean(entry.file);
            const entryPath =
              entry.path || joinChildPath(currentDir, entry.name);
            const { base, relDir } = isSearching
              ? splitSearchEntryLabel(entry.name)
              : { base: entry.name, relDir: "" };
            const nativeItems = (): NativeContextMenuItem[] => [
              { id: "open", label: base },
              { id: "sep-1", label: "", type: "separator" },
              ...(openLocally
                ? [
                    { id: "vscode", label: ti("openInVscode") },
                    { id: "cursor", label: ti("openInCursor") },
                    { id: "reveal", label: revealLabel },
                  ]
                : []),
              { id: "copyPath", label: t("desktop.menu.copyPath") },
              ...(isFile
                ? [{ id: "download", label: t("desktop.inspector.download") }]
                : []),
            ];

            return (
              <ContextMenu
                key={entryPath}
                label={base}
                nativeItems={nativeItems}
                onNativeSelect={(actionId) => {
                  if (actionId === "open") {
                    handleOpenEntry(entryPath, isFile);
                  } else if (
                    actionId === "vscode" ||
                    actionId === "cursor" ||
                    actionId === "reveal"
                  ) {
                    void handleOpenExternal(entryPath, actionId);
                  } else if (actionId === "copyPath") {
                    copyPath(entryPath);
                  } else if (actionId === "download" && isFile) {
                    void handleDownload(entryPath);
                  }
                }}
                menu={
                  <>
                    <MenuItem
                      icon={isFile ? "file-code" : "folder-open"}
                      onSelect={() => handleOpenEntry(entryPath, isFile)}
                    >
                      {base}
                    </MenuItem>
                    <MenuSeparator />
                    {openLocally ? (
                      <>
                        <MenuItem
                          icon="code"
                          onSelect={() => {
                            void handleOpenExternal(entryPath, "vscode");
                          }}
                        >
                          {ti("openInVscode")}
                        </MenuItem>
                        <MenuItem
                          icon="folder-open"
                          onSelect={() => {
                            void handleOpenExternal(entryPath, "reveal");
                          }}
                        >
                          {revealLabel}
                        </MenuItem>
                      </>
                    ) : null}
                    <MenuItem
                      icon="copy"
                      onSelect={() => copyPath(entryPath)}
                    >
                      {t("desktop.menu.copyPath")}
                    </MenuItem>
                    {isFile ? (
                      <MenuItem
                        icon="download"
                        onSelect={() => {
                          void handleDownload(entryPath);
                        }}
                      >
                        {t("desktop.inspector.download")}
                      </MenuItem>
                    ) : null}
                  </>
                }
              >
                <button
                  type="button"
                  role="listitem"
                  data-selected={
                    activeFilePath === entryPath ? "true" : undefined
                  }
                  title={entryPath}
                  className="inspector-file-row"
                  onClick={() => handleOpenEntry(entryPath, isFile)}
                >
                  {isFile ? (
                    <FileExtBadge path={entryPath} />
                  ) : (
                    <DesktopIcon name="folder" size="sm" />
                  )}
                  <span className="inspector-file-row__name ls-truncate">
                    {base}
                  </span>
                  {relDir ? (
                    <span className="inspector-file-row__rel ls-truncate">
                      {relDir}
                    </span>
                  ) : null}
                  {isFile && entry.size !== undefined ? (
                    <span className="inspector-file-row__size" data-tabular="">
                      {formatByteSize(entry.size)}
                    </span>
                  ) : null}
                </button>
              </ContextMenu>
            );
          })}
          </>
        )}
      </div>
    </div>
  );
}
