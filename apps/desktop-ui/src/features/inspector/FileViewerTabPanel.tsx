import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadFile, downloadName } from "@linkshell/client-core";
import {
  RPC_METHOD_NOT_FOUND,
  RpcError,
  type AgentInfo,
} from "@linkshell/wire";
import {
  DESKTOP_LOCAL,
  desktopInvoke,
  isElectronRuntime,
  openExternalUrl,
  revealOnDesktop,
} from "../../bridge/desktop-bridge";
import type { Connection } from "../../core/connections";
import {
  HighlightedCodeBlock,
  grammarForPath,
  useHighlight,
} from "../../core/markdown-shiki";
import { registerUnsavedWork } from "../../core/unsaved-work";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  isImeComposing,
  useDialogs,
} from "../../primitives";
import { toRepoRelativePath } from "./ChangesPanel";
import { FileExtBadge } from "./file-ext-badge";
import {
  useConnectionTargetPlatform,
  useInspectorI18n,
} from "./i18n-inspector";
import { openFileTabInInspector } from "./inspector-tabs-store";
import {
  resolveFileHrefTarget,
} from "../session/session-helpers";

function safeMarkdownUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^(?:javascript|vbscript|file-upload):/i.test(trimmed)) return "";
  if (/^data:/i.test(trimmed) && !/^data:image\//i.test(trimmed)) return "";
  return trimmed;
}

function basenameOfFilePath(rawPath: string): string {
  const cleaned = rawPath.replace(/[\\/]+$/, "");
  if (!cleaned) return rawPath;
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

function joinDirAndRelative(dir: string, rel: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const base = dir.replace(/[\\/]+$/, "");
  const stripped = rel.replace(/^(?:\.[\\/]|[\\/])+/, "");
  const cleanRel = sep === "\\" ? stripped.replace(/\//g, "\\") : stripped;
  return `${base}${sep}${cleanRel}`;
}

export type ExternalOpenTarget =
  | "vscode"
  | "cursor"
  | "zed"
  | "xcode"
  | "windsurf"
  | "antigravity"
  | "reveal"
  | "terminal";

export interface ParsedFileSpec {
  path: string;
  startLine?: number;
  endLine?: number;
}

export function parseFileSpec(spec: string): ParsedFileSpec {
  const hashIdx = spec.lastIndexOf("#L");
  if (hashIdx > 0) {
    const basePath = spec.slice(0, hashIdx);
    const anchor = spec.slice(hashIdx + 2);
    const match = /^(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(anchor);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : start;
      return {
        path: basePath,
        startLine: Math.min(start, end),
        endLine: Math.max(start, end),
      };
    }
  }
  const colonMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(spec);
  if (colonMatch && colonMatch[1] && !/^[A-Za-z]$/.test(colonMatch[1])) {
    const start = Number(colonMatch[2]);
    return {
      path: colonMatch[1],
      startLine: start,
      endLine: start,
    };
  }
  return { path: spec };
}

export function formatByteSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

export async function openPathInExternalApp(params: {
  targetPath: string;
  app: ExternalOpenTarget;
  connection?: Connection;
  onOpenTerminalAt?: (dir: string) => void;
}): Promise<void> {
  const { targetPath, app, connection, onOpenTerminalAt } = params;
  if (app === "terminal" && onOpenTerminalAt) {
    onOpenTerminalAt(targetPath);
    return;
  }
  const isLocalConnection =
    !connection || connection.computer.key === DESKTOP_LOCAL;
  if (app === "reveal" && isElectronRuntime() && isLocalConnection) {
    const ok = await revealOnDesktop(targetPath);
    if (ok) return;
  }
  if (!connection) return;
  if (
    app === "vscode" ||
    app === "cursor" ||
    app === "zed" ||
    app === "reveal" ||
    app === "terminal"
  ) {
    await connection.link.call("desktop.openPath", {
      path: targetPath,
      app,
    });
    return;
  }
  const rawCall = connection.link.call.bind(connection.link) as (
    method: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  const invoked = await desktopInvoke<{ ok?: boolean }>("openPath", {
    path: targetPath,
    app,
  });
  if (!invoked?.ok) {
    await rawCall("desktop.openPath", { path: targetPath, app });
  }
}

export async function triggerRemoteFileDownload(
  connection: Connection,
  targetPath: string,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  await downloadFile(connection.link, targetPath, (bytes) => {
    chunks.push(bytes);
  });
  const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  const blob = new Blob([merged]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadName(targetPath);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface LoadedFileState {
  path: string;
  size: number;
  kind: "text" | "image" | "binary";
  text: string;
  data?: string;
  mimeType?: string;
  truncated: boolean;
}

export interface FileViewerTabPanelProps {
  computerKey?: string;
  sessionId?: string;
  connection?: Connection;
  online: boolean;
  cwd?: string;
  agents?: AgentInfo[];
  filePath: string;
  lineSpec?: string;
  onOpenTerminalAt?: (dir: string) => void;
  onBack?: () => void;
}

export function FileViewerTabPanel({
  computerKey,
  sessionId,
  connection,
  online,
  cwd,
  agents = [],
  filePath,
  lineSpec,
  onOpenTerminalAt,
  onBack,
}: FileViewerTabPanelProps): JSX.Element {
  const targetPlatform = useConnectionTargetPlatform(connection);
  const { t, ti, revealLabel, resolvedPlatform } =
    useInspectorI18n(targetPlatform);
  const dialogs = useDialogs();

  const parsedAnchor = useMemo(
    () => parseFileSpec(lineSpec ?? filePath),
    [filePath, lineSpec],
  );
  const effectivePath = parsedAnchor.path || filePath;

  const [highlightRange, setHighlightRange] = useState<{
    start: number;
    end: number;
  } | null>(() =>
    parsedAnchor.startLine
      ? {
          start: parsedAnchor.startLine,
          end: parsedAnchor.endLine ?? parsedAnchor.startLine,
        }
      : null,
  );

  const [loadedFile, setLoadedFile] = useState<LoadedFileState | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">(() =>
    isMarkdownPath(effectivePath) ? "preview" : "source",
  );
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const sourcePreRef = useRef<HTMLPreElement | null>(null);
  const readSeqRef = useRef(0);

  const isDirty = Boolean(
    editing && loadedFile?.kind === "text" && draftText !== loadedFile.text,
  );

  useEffect(() => {
    if (!isDirty) return undefined;
    return registerUnsavedWork();
  }, [isDirty]);

  // Sync incoming `#L` anchor updates without discarding an already loaded file.
  useEffect(() => {
    if (parsedAnchor.startLine) {
      setHighlightRange({
        start: parsedAnchor.startLine,
        end: parsedAnchor.endLine ?? parsedAnchor.startLine,
      });
      if (isMarkdownPath(effectivePath)) {
        setMarkdownMode("source");
      }
    }
  }, [effectivePath, parsedAnchor.endLine, parsedAnchor.startLine]);

  // Load file contents when host connection or target path becomes ready.
  useEffect(() => {
    if (!connection || !online || !effectivePath) return;
    const seq = ++readSeqRef.current;
    setEditing(false);
    setSavedNotice(false);
    setMarkdownMode(
      parsedAnchor.startLine
        ? "source"
        : isMarkdownPath(effectivePath)
          ? "preview"
          : "source",
    );
    setFileLoading(true);
    setFileError(null);

    const applyReadResult = (res: {
      path: string;
      size: number;
      kind: "text" | "image" | "binary";
      text?: string;
      data?: string;
      mimeType?: string;
      truncated: boolean;
    }) => {
      if (seq !== readSeqRef.current) return;
      const text = res.text ?? "";
      setFileError(null);
      setLoadedFile({
        path: res.path,
        size: res.size,
        kind: res.kind,
        text,
        data: res.data,
        mimeType: res.mimeType,
        truncated: res.truncated,
      });
      setDraftText(text);
    };

    void connection.link
      .call("fs.read", {
        path: effectivePath,
        offset: 0,
        maxBytes: 512_000,
      })
      .then((res) => {
        applyReadResult(res);
      })
      .catch(async (err) => {
        if (seq !== readSeqRef.current) return;
        const baseName = basenameOfFilePath(effectivePath);
        if (cwd && baseName) {
          try {
            const searchRes = await connection.link.call("fs.projectFiles", {
              cwd,
              query: baseName,
              limit: 30,
            });
            const candidates = Array.isArray(searchRes?.files)
              ? searchRes.files
              : [];
            const exact = candidates.find((item) => {
              const rec = item as {
                path?: string;
                file?: boolean;
                isDir?: boolean;
              };
              if (!rec.path || rec.file === false || rec.isDir) return false;
              return basenameOfFilePath(rec.path) === baseName;
            }) as { path: string } | undefined;
            if (exact?.path) {
              const fallbackPath =
                exact.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(exact.path)
                  ? exact.path
                  : joinDirAndRelative(cwd, exact.path);
              if (fallbackPath !== effectivePath) {
                const fallbackRes = await connection.link.call("fs.read", {
                  path: fallbackPath,
                  offset: 0,
                  maxBytes: 512_000,
                });
                applyReadResult(fallbackRes);
                return;
              }
            }
          } catch {
            // Fall through to surface original read error.
          }
        }
        if (seq !== readSeqRef.current) return;
        setLoadedFile(null);
        setFileError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq === readSeqRef.current) {
          setFileLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload only when connection, online, or target file path changes.
  }, [connection, online, effectivePath, cwd]);

  useEffect(() => {
    if (!highlightRange || !sourcePreRef.current) return;
    const row = sourcePreRef.current.querySelector<HTMLElement>(
      `[data-line-number="${highlightRange.start}"]`,
    );
    row?.scrollIntoView({ block: "center" });
  }, [highlightRange, loadedFile?.path, markdownMode]);

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    return dialogs.confirm(t("desktop.inspector.unsavedConfirm"), {
      title: t("desktop.inspector.files"),
      confirmLabel: ti("exitEdit"),
      cancelLabel: ti("cancel"),
      destructive: true,
    });
  }, [dialogs, isDirty, t, ti]);

  const handleSaveFile = useCallback(async () => {
    if (!connection || !loadedFile || loadedFile.kind !== "text" || saving) {
      return;
    }
    setSaving(true);
    try {
      const rawCall = connection.link.call.bind(connection.link) as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;

      try {
        await rawCall("fs.write", {
          path: loadedFile.path,
          text: draftText,
          content: draftText,
        });
      } catch (err) {
        const errData =
          err instanceof RpcError &&
          typeof err.data === "object" &&
          err.data !== null
            ? (err.data as { code?: string })
            : undefined;
        const isNotFound =
          err instanceof RpcError &&
          (err.code === RPC_METHOD_NOT_FOUND ||
            errData?.code === "host_outdated");
        if (!isNotFound) throw err;

        const acpAgent =
          agents.find((a) => a.installed && a.id !== "claude")?.id ??
          agents.find((a) => a.installed)?.id ??
          "codex";
        const opened = await connection.link.call("agents.editor", {
          agent: acpAgent,
          operation: "open",
          cwd: cwd || "/",
          path: loadedFile.path,
        });
        if (!opened.editorId) {
          throw err;
        }
        try {
          await connection.link.call("agents.editor", {
            agent: acpAgent,
            operation: "save",
            editorId: opened.editorId,
            text: draftText,
          });
        } finally {
          await connection.link
            .call("agents.editor", {
              agent: acpAgent,
              operation: "close",
              editorId: opened.editorId,
            })
            .catch(() => undefined);
        }
      }

      setLoadedFile((prev) =>
        prev
          ? {
              ...prev,
              text: draftText,
              size: new TextEncoder().encode(draftText).byteLength,
            }
          : null,
      );
      setEditing(false);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 1400);
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [agents, connection, cwd, dialogs, draftText, loadedFile, saving]);

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeComposing(event)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveFile();
      }
    },
    [handleSaveFile],
  );

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

  const handlePromptJumpToLine = useCallback(async () => {
    const answer = await dialogs.prompt(ti("jumpToLinePrompt"), {
      title: ti("jumpToLineAction"),
      placeholder: highlightRange ? `${highlightRange.start}` : "1",
      submitLabel: ti("jumpToLineAction"),
      cancelLabel: ti("cancel"),
    });
    if (!answer) return;
    const cleaned = answer.trim().replace(/^#?L?/i, "");
    const match = /^(\d+)(?:-L?(\d+))?$/.exec(cleaned);
    if (!match) return;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (isMarkdownPath(effectivePath)) {
      setMarkdownMode("source");
    }
    setHighlightRange({
      start: Math.min(start, end),
      end: Math.max(start, end),
    });
  }, [dialogs, effectivePath, highlightRange, ti]);

  const activePath = loadedFile?.path ?? effectivePath;
  const displayRelPath = useMemo(
    () => toRepoRelativePath(activePath, cwd),
    [activePath, cwd],
  );

  const sourceLanguage = useMemo(
    () => (loadedFile ? grammarForPath(loadedFile.path) : undefined),
    [loadedFile],
  );
  const sourceLines = useMemo(
    () => (loadedFile?.kind === "text" ? loadedFile.text.split("\n") : []),
    [loadedFile],
  );
  const shouldHighlightSource = Boolean(
    loadedFile?.kind === "text" &&
      !editing &&
      (markdownMode === "source" || !isMarkdownPath(loadedFile.path)),
  );
  const highlightedTokens = useHighlight(
    loadedFile?.kind === "text" ? loadedFile.text : "",
    sourceLanguage,
    shouldHighlightSource,
  );

  const parentDirOfFile = useMemo(() => {
    const stripped = activePath.replace(/[\\/][^\\/]+$/, "");
    return stripped || cwd || activePath;
  }, [activePath, cwd]);

  return (
    <div
      className="ls-file-tab-panel inspector-panel-fill"
      data-testid={`file-tab-panel:${activePath}`}
    >
      <div className="ls-file-tab-header inspector-subbar">
        <div className="ls-file-tab-header__left">
          {onBack ? (
            <IconButton
              icon="arrow-left"
              size="icon-sm"
              label={ti("backToFilesList")}
              onClick={() => {
                void (async () => {
                  if (await confirmDiscardIfDirty()) {
                    onBack();
                  }
                })();
              }}
            />
          ) : null}
          <FileExtBadge path={activePath} />
          <span
            className="ls-file-tab-header__path ls-truncate"
            title={activePath}
          >
            {displayRelPath}
          </span>
          {loadedFile ? (
            <span className="ls-file-tab-header__size" data-tabular="">
              {formatByteSize(loadedFile.size)}
            </span>
          ) : null}
          {isDirty ? (
            <Badge variant="tag" tone="waiting">
              {ti("unsavedBadge")}
            </Badge>
          ) : savedNotice ? (
            <Badge variant="tag" tone="ok">
              {ti("savedToast")}
            </Badge>
          ) : null}
        </div>

        <div className="ls-file-tab-header__actions">
          {loadedFile?.kind === "text" &&
          isMarkdownPath(loadedFile.path) &&
          !editing ? (
            <div
              className="inspector-segmented"
              role="group"
              aria-label={t("desktop.inspector.preview")}
            >
              <button
                type="button"
                className="inspector-segmented-btn"
                aria-pressed={markdownMode === "preview"}
                onClick={() => setMarkdownMode("preview")}
              >
                {t("desktop.inspector.preview")}
              </button>
              <button
                type="button"
                className="inspector-segmented-btn"
                aria-pressed={markdownMode === "source"}
                onClick={() => setMarkdownMode("source")}
              >
                {t("desktop.inspector.source")}
              </button>
            </div>
          ) : null}

          {loadedFile?.kind === "text" ? (
            editing ? (
              <>
                <Button
                  size="xs"
                  variant="primary"
                  shortcut="Mod+S"
                  loading={saving}
                  disabled={!isDirty}
                  onClick={() => {
                    void handleSaveFile();
                  }}
                >
                  {t("desktop.inspector.saveFile")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    void (async () => {
                      if (await confirmDiscardIfDirty()) {
                        setDraftText(loadedFile.text);
                        setEditing(false);
                      }
                    })();
                  }}
                >
                  {ti("cancel")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  leadingIcon="edit"
                  disabled={loadedFile.truncated}
                  disabledReason={
                    loadedFile.truncated ? ti("truncatedNote") : undefined
                  }
                  onClick={() => {
                    setDraftText(loadedFile.text);
                    setEditing(true);
                  }}
                >
                  {ti("editFile")}
                </Button>
                <CopyButton
                  value={() => loadedFile.text}
                  size="sm"
                  label={t("desktop.menu.copy")}
                />
              </>
            )
          ) : null}

          <Menu
            label={t("desktop.inspector.openIn")}
            trigger={
              <Button
                size="xs"
                variant="secondary"
                leadingIcon="external-link"
                trailingIcon="chevron-down"
              >
                {ti("openShort")}
              </Button>
            }
          >
            {loadedFile?.kind === "text" && !editing ? (
              <MenuItem
                icon="corner-down-left"
                onSelect={() => {
                  void handlePromptJumpToLine();
                }}
              >
                {ti("jumpToLineAction")}
              </MenuItem>
            ) : null}
            <MenuItem
              icon="download"
              disabled={!online}
              onSelect={() => {
                void handleDownload(activePath);
              }}
            >
              {t("desktop.inspector.download")}
            </MenuItem>
            <MenuItem
              icon="copy"
              onSelect={() => {
                void navigator.clipboard?.writeText(activePath);
              }}
            >
              {t("desktop.menu.copyPath")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon="code"
              onSelect={() => {
                void handleOpenExternal(activePath, "vscode");
              }}
            >
              {ti("openInVscode")}
            </MenuItem>
            <MenuItem
              icon="code"
              onSelect={() => {
                void handleOpenExternal(activePath, "cursor");
              }}
            >
              {ti("openInCursor")}
            </MenuItem>
            <MenuItem
              icon="code"
              onSelect={() => {
                void handleOpenExternal(activePath, "zed");
              }}
            >
              {ti("openInZed")}
            </MenuItem>
            {resolvedPlatform === "macos" ? (
              <MenuItem
                icon="code"
                onSelect={() => {
                  void handleOpenExternal(activePath, "xcode");
                }}
              >
                {ti("openInXcode")}
              </MenuItem>
            ) : null}
            <MenuItem
              icon="code"
              onSelect={() => {
                void handleOpenExternal(activePath, "windsurf");
              }}
            >
              {ti("openInWindsurf")}
            </MenuItem>
            <MenuItem
              icon="sparkles"
              onSelect={() => {
                void handleOpenExternal(activePath, "antigravity");
              }}
            >
              {ti("openInAntigravity")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon="folder-open"
              onSelect={() => {
                void handleOpenExternal(activePath, "reveal");
              }}
            >
              {revealLabel}
            </MenuItem>
            <MenuItem
              icon="terminal"
              onSelect={() => {
                void handleOpenExternal(parentDirOfFile, "terminal");
              }}
            >
              {ti("openInTerminal")}
            </MenuItem>
          </Menu>
        </div>
      </div>

      <div className="ls-file-tab-body inspector-panel-fill">
        {fileLoading ? (
          <EmptyState compact icon="spinner" title={ti("loading")} />
        ) : fileError ? (
          <EmptyState
            compact
            icon="alert-circle"
            title={displayRelPath}
            description={fileError}
          />
        ) : !loadedFile ? (
          <EmptyState
            compact
            icon="file-code"
            title={ti("noFileSelectedTitle")}
            description={ti("noFileSelectedDesc")}
          />
        ) : loadedFile.kind === "image" && loadedFile.data ? (
          <div className="inspector-panel-scroll">
            <img
              src={`data:${loadedFile.mimeType ?? "image/png"};base64,${loadedFile.data}`}
              alt={loadedFile.path}
              style={{ maxWidth: "100%", borderRadius: "var(--ls-radius-md)" }}
            />
          </div>
        ) : loadedFile.kind === "binary" ? (
          <EmptyState
            icon="file"
            title={ti("binaryFileTitle")}
            description={formatByteSize(loadedFile.size)}
            actions={
              <Button
                size="sm"
                variant="primary"
                leadingIcon="download"
                onClick={() => {
                  void handleDownload(loadedFile.path);
                }}
              >
                {t("desktop.inspector.download")}
              </Button>
            }
          />
        ) : editing ? (
          <textarea
            aria-label={loadedFile.path}
            className="inspector-editor-textarea"
            spellCheck={false}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={handleEditorKeyDown}
          />
        ) : isMarkdownPath(loadedFile.path) && markdownMode === "preview" ? (
          <div className="inspector-markdown-body ls-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              urlTransform={safeMarkdownUrlTransform}
              components={{
                a(anchorProps) {
                  const safeHref = anchorProps.href ?? "";
                  const fileTarget = resolveFileHrefTarget(
                    safeHref,
                    cwd,
                  );
                  return (
                    <a
                      href={safeHref}
                      className={fileTarget ? "ls-md-file-link" : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        if (fileTarget && computerKey) {
                          const spec =
                            fileTarget.line && fileTarget.line > 0
                              ? fileTarget.endLine &&
                                fileTarget.endLine > fileTarget.line
                                ? `${fileTarget.path}#L${fileTarget.line}-L${fileTarget.endLine}`
                                : `${fileTarget.path}#L${fileTarget.line}`
                              : fileTarget.path;
                          openFileTabInInspector(
                            computerKey,
                            sessionId,
                            spec,
                            { openPanel: true },
                          );
                          return;
                        }
                        if (/^(?:https?:|mailto:|tel:)/i.test(safeHref)) {
                          openExternalUrl(safeHref);
                        }
                      }}
                    >
                      {anchorProps.children}
                    </a>
                  );
                },
                table({ children }) {
                  return (
                    <div className="ls-md-table-wrap" tabIndex={0}>
                      <table>{children}</table>
                    </div>
                  );
                },
                code(codeProps) {
                  const { className, children } = codeProps;
                  const langMatch = /language-([\w+-]+)/.exec(className ?? "");
                  const rawCode = String(children ?? "").replace(/\n$/, "");
                  if (langMatch || rawCode.includes("\n")) {
                    return (
                      <HighlightedCodeBlock
                        code={rawCode}
                        language={langMatch?.[1]}
                      />
                    );
                  }
                  return <code className={className}>{children}</code>;
                },
              }}
            >
              {loadedFile.text}
            </ReactMarkdown>
          </div>
        ) : (
          <>
            {loadedFile.truncated ? (
              <div className="inspector-banner">
                <span>{ti("truncatedNote")}</span>
              </div>
            ) : null}
            <pre
              ref={sourcePreRef}
              tabIndex={0}
              className="inspector-source-scroll"
            >
              {sourceLines.map((lineText, idx) => {
                const lineNum = idx + 1;
                const isHighlighted =
                  highlightRange !== null &&
                  lineNum >= highlightRange.start &&
                  lineNum <= highlightRange.end;
                const lineTokens = highlightedTokens?.[idx];
                return (
                  <div
                    key={lineNum}
                    data-line-number={lineNum}
                    data-highlighted={isHighlighted ? "true" : undefined}
                    className="inspector-source-line"
                  >
                    <button
                      type="button"
                      className="inspector-source-ln"
                      onClick={(event) => {
                        if (event.shiftKey && highlightRange) {
                          setHighlightRange({
                            start: Math.min(highlightRange.start, lineNum),
                            end: Math.max(highlightRange.start, lineNum),
                          });
                        } else {
                          setHighlightRange({ start: lineNum, end: lineNum });
                        }
                      }}
                    >
                      {lineNum}
                    </button>
                    <span className="inspector-source-code">
                      {lineTokens && lineTokens.length > 0
                        ? lineTokens.map((tok, tIdx) =>
                            tok.color ? (
                              <span
                                key={tIdx}
                                data-syntax-token=""
                                style={{ color: tok.color }}
                              >
                                {tok.content}
                              </span>
                            ) : (
                              tok.content
                            ),
                          )
                        : lineText || " "}
                    </span>
                  </div>
                );
              })}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
