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
  type MethodResult,
} from "@linkshell/wire";
import {
  DESKTOP_LOCAL,
  desktopInvoke,
  isElectronRuntime,
  openExternalUrl,
  revealOnDesktop,
} from "../../bridge/desktop-bridge";
import type { Connection } from "../../core/connections";
import { engine } from "../../core/engine";
import {
  HighlightedCodeBlock,
  grammarForPath,
  useHighlight,
} from "../../core/markdown-shiki";
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
import {
  getFileDraft,
  openFileTabInInspector,
  setFileDraft,
  INSPECTOR_FILE_SAVED_EVENT,
} from "./inspector-tabs-store";
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

/**
 * What `desktop.openPath` accepts, plus Xcode, which only the desktop app's own opener knows
 * (Mac only). The in-app terminal is handled separately.
 */
export type ExternalOpenTarget =
  | "vscode"
  | "cursor"
  | "zed"
  | "xcode"
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

/**
 * Editors, the file manager and the system terminal open on the computer the host runs on;
 * for a remote computer that is not the screen in front of the user, so only the local
 * computer offers them.
 */
export function canOpenOnThisComputer(connection?: Connection): boolean {
  if (!connection) return true;
  const { key, machine } = connection.computer;
  if (key === DESKTOP_LOCAL) return true;
  // This machine reached through its gateway alias is still this machine.
  const local = engine.state.getState().localComputer;
  return Boolean(
    local && (local.key === key || (local.relayId && local.relayId === machine.id)),
  );
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
  if (!canOpenOnThisComputer(connection)) return;
  if (app === "reveal" && isElectronRuntime()) {
    const ok = await revealOnDesktop(targetPath);
    if (ok) return;
  }
  if (app === "xcode") {
    await desktopInvoke("openPath", { path: targetPath, app });
    return;
  }
  if (!connection) return;
  await connection.link.call("desktop.openPath", {
    path: targetPath,
    app,
  });
}

type FileReadResult = MethodResult<"fs.read">;

/** Never join chunks from two different versions of a file. */
export function appendFileChunk(
  file: FileReadResult,
  chunk: FileReadResult,
): FileReadResult {
  if (
    file.kind !== "text" ||
    chunk.kind !== "text" ||
    chunk.path !== file.path ||
    chunk.size !== file.size ||
    chunk.modifiedAt !== file.modifiedAt ||
    file.nextOffset === undefined ||
    (chunk.nextOffset !== undefined && chunk.nextOffset <= file.nextOffset)
  ) {
    throw new FileChangedWhileReadingError();
  }
  return { ...chunk, text: (file.text ?? "") + (chunk.text ?? "") };
}

export class FileChangedWhileReadingError extends Error {
  constructor() {
    super("file changed while reading");
  }
}

/** A line link must load enough bytes to reach the requested line before scrolling. */
export async function readFileAtLine(
  read: (offset?: number) => Promise<FileReadResult>,
  line?: number,
): Promise<FileReadResult> {
  let file = await read();
  let lines = file.text?.split("\n").length ?? 0;
  while (
    file.kind === "text" &&
    line &&
    lines <= line &&
    file.nextOffset !== undefined
  ) {
    const chunk = await read(file.nextOffset);
    lines += (chunk.text?.split("\n").length ?? 1) - 1;
    file = appendFileChunk(file, chunk);
  }
  return file;
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
  modifiedAt?: number;
  kind: "text" | "image" | "binary";
  text: string;
  data?: string;
  mimeType?: string;
  truncated: boolean;
  nextOffset?: number;
}

function toLoadedFile(res: FileReadResult): LoadedFileState {
  return {
    path: res.path,
    size: res.size,
    modifiedAt: res.modifiedAt,
    kind: res.kind,
    text: res.text ?? "",
    data: res.data,
    mimeType: res.mimeType,
    truncated: res.truncated,
    nextOffset: res.nextOffset,
  };
}

const READ_CHUNK_BYTES = 512_000;

function rpcAppCode(err: unknown): string | undefined {
  return err instanceof RpcError ? err.appCode : undefined;
}

function isMethodMissing(err: unknown): boolean {
  return (
    err instanceof RpcError &&
    (err.code === RPC_METHOD_NOT_FOUND || err.appCode === "host_outdated")
  );
}

export interface FileViewerTabPanelProps {
  computerKey?: string;
  sessionId?: string;
  /** Inspector tab owning this view; its unsaved draft is kept under this id. */
  tabId?: string;
  connection?: Connection;
  online: boolean;
  cwd?: string;
  agents?: AgentInfo[];
  filePath: string;
  lineSpec?: string;
  /** Changes when the file is asked for again: re-read it unless there is an unsaved edit. */
  reloadNonce?: number;
  onOpenTerminalAt?: (dir: string) => void;
  onBack?: () => void;
}

export function FileViewerTabPanel({
  computerKey,
  sessionId,
  tabId,
  connection,
  online,
  cwd,
  agents = [],
  filePath,
  lineSpec,
  reloadNonce,
  onOpenTerminalAt,
  onBack,
}: FileViewerTabPanelProps): JSX.Element {
  const targetPlatform = useConnectionTargetPlatform(connection);
  const { t, ti, revealLabel, resolvedPlatform } = useInspectorI18n(targetPlatform);
  const dialogs = useDialogs();
  const draftOwner = computerKey ?? "default";
  const draftTabId = tabId ?? `file:${filePath}`;
  const openLocally = canOpenOnThisComputer(connection);

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
  const [loadingMore, setLoadingMore] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [alternatePath, setAlternatePath] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [saveUnsupported, setSaveUnsupported] = useState(false);

  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">(() =>
    isMarkdownPath(effectivePath) ? "preview" : "source",
  );
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const sourcePreRef = useRef<HTMLPreElement | null>(null);
  const readSeqRef = useRef(0);

  const isDirty = Boolean(
    editing && loadedFile?.kind === "text" && draftText !== loadedFile.text,
  );

  // The draft lives in the tab store: closing the tab asks, and a session switch that unmounts
  // this view finds it again on return.
  useEffect(() => {
    if (!loadedFile || loadedFile.kind !== "text") return;
    setFileDraft(
      draftOwner,
      sessionId,
      draftTabId,
      editing
        ? {
            text: draftText,
            baseText: loadedFile.text,
            baseModifiedAt: loadedFile.modifiedAt,
          }
        : undefined,
    );
  }, [draftOwner, draftTabId, draftText, editing, loadedFile, sessionId]);

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

  // An unsaved edit wins over "show me the file again"; the reload button can still discard it.
  const lastNonceRef = useRef(reloadNonce);
  useEffect(() => {
    if (lastNonceRef.current === reloadNonce) return;
    lastNonceRef.current = reloadNonce;
    if (!getFileDraft(draftOwner, sessionId, draftTabId)) {
      setReloadTick((n) => n + 1);
    }
  }, [draftOwner, draftTabId, reloadNonce, sessionId]);

  const readAt = useCallback(
    (path: string, offset?: number) => {
      if (!connection) return Promise.reject(new Error("offline"));
      return connection.link.call("fs.read", {
        path,
        offset: offset ?? 0,
        maxBytes: READ_CHUNK_BYTES,
      });
    },
    [connection],
  );

  // Load file contents when host connection or target path becomes ready.
  useEffect(() => {
    if (!connection || !online || !effectivePath) return;
    const seq = ++readSeqRef.current;
    const draft = getFileDraft(draftOwner, sessionId, draftTabId);
    // Leaving edit mode would clear the stored draft; with one, stay put until the read lands.
    if (!draft) setEditing(false);
    setSavedNotice(false);
    setAlternatePath(null);
    setMarkdownMode(
      parsedAnchor.startLine || draft
        ? "source"
        : isMarkdownPath(effectivePath)
          ? "preview"
          : "source",
    );
    setFileLoading(true);
    setFileError(null);

    void readFileAtLine(
      (offset) => readAt(effectivePath, offset),
      parsedAnchor.endLine ?? parsedAnchor.startLine,
    )
      .then((res) => {
        if (seq !== readSeqRef.current) return;
        const next = toLoadedFile(res);
        if (draft && next.kind === "text") {
          // Compare and save against what the draft was written over, so a change on disk
          // since then still surfaces as a conflict.
          next.text = draft.baseText;
          next.modifiedAt = draft.baseModifiedAt ?? next.modifiedAt;
        }
        setLoadedFile(next);
        if (draft && next.kind === "text") {
          setDraftText(draft.text);
          setEditing(true);
        } else {
          setDraftText(next.text);
        }
      })
      .catch(async (err: unknown) => {
        if (seq !== readSeqRef.current) return;
        setLoadedFile(null);
        setFileError(
          err instanceof FileChangedWhileReadingError
            ? ti("fileChangedWhileReading")
            : err instanceof Error
              ? err.message
              : String(err),
        );
        // A path from an agent can be stale; offer (never silently open) a same-named file.
        const baseName = basenameOfFilePath(effectivePath);
        if (rpcAppCode(err) !== "not_found" || !cwd || !baseName) return;
        try {
          const searchRes = await connection.link.call("fs.projectFiles", {
            cwd,
            query: baseName,
            limit: 30,
          });
          if (seq !== readSeqRef.current) return;
          const exact = (searchRes?.files ?? []).find(
            (item) => !item.isDir && basenameOfFilePath(item.path) === baseName,
          );
          if (!exact) return;
          const candidate =
            exact.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(exact.path)
              ? exact.path
              : joinDirAndRelative(cwd, exact.path);
          if (candidate !== effectivePath) setAlternatePath(candidate);
        } catch {
          // The original error is what the user needs to see.
        }
      })
      .finally(() => {
        if (seq === readSeqRef.current) {
          setFileLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload only when connection, online, target path or an explicit reload changes.
  }, [connection, online, effectivePath, cwd, reloadTick]);

  const handleLoadMore = useCallback(async () => {
    if (!loadedFile || loadedFile.nextOffset === undefined || loadingMore) return;
    const seq = readSeqRef.current;
    setLoadingMore(true);
    try {
      const chunk = await readAt(loadedFile.path, loadedFile.nextOffset);
      if (seq !== readSeqRef.current) return;
      const merged = appendFileChunk(
        {
          path: loadedFile.path,
          size: loadedFile.size,
          modifiedAt: loadedFile.modifiedAt ?? 0,
          kind: loadedFile.kind,
          text: loadedFile.text,
          truncated: loadedFile.truncated,
          nextOffset: loadedFile.nextOffset,
        },
        chunk,
      );
      const next = toLoadedFile(merged);
      setLoadedFile(next);
      setDraftText(next.text);
    } catch (err) {
      await dialogs.alert(
        err instanceof FileChangedWhileReadingError
          ? ti("fileChangedWhileReading")
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [dialogs, loadedFile, loadingMore, readAt, ti]);

  const discardDraftAndReload = useCallback(() => {
    setFileDraft(draftOwner, sessionId, draftTabId, undefined);
    setEditing(false);
    setReloadTick((n) => n + 1);
  }, [draftOwner, draftTabId, sessionId]);

  const handleReload = useCallback(async () => {
    if (isDirty) {
      const ok = await dialogs.confirm(
        ti("reloadDirtyBody", { name: basenameOfFilePath(effectivePath) }),
        {
          title: ti("discardDraftTitle"),
          confirmLabel: ti("discardDraftConfirm"),
          cancelLabel: ti("cancel"),
          destructive: true,
        },
      );
      if (!ok) return;
    }
    discardDraftAndReload();
  }, [dialogs, discardDraftAndReload, effectivePath, isDirty, ti]);

  useEffect(() => {
    if (!highlightRange || !sourcePreRef.current) return;
    const row = sourcePreRef.current.querySelector<HTMLElement>(
      `[data-line-number="${highlightRange.start}"]`,
    );
    row?.scrollIntoView({ block: "center" });
  }, [highlightRange, loadedFile?.path, loadedFile?.text, markdownMode]);

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    return dialogs.confirm(t("desktop.inspector.unsavedConfirm"), {
      title: t("desktop.inspector.files"),
      confirmLabel: ti("exitEdit"),
      cancelLabel: ti("cancel"),
      destructive: true,
    });
  }, [dialogs, isDirty, t, ti]);

  /** Older hosts have no `fs.write`; an ACP agent with an editor can still save for them. */
  const saveThroughAgentEditor = useCallback(
    async (path: string, text: string): Promise<boolean> => {
      if (!connection) return false;
      const candidates = agents.filter((a) => a.installed && a.capabilities?.acp);
      for (const agent of candidates) {
        let editorId: string | undefined;
        try {
          const opened = await connection.link.call("agents.editor", {
            agent: agent.id,
            operation: "open",
            cwd: cwd || "/",
            path,
          });
          editorId = opened.editorId;
          if (!editorId) continue;
          await connection.link.call("agents.editor", {
            agent: agent.id,
            operation: "save",
            editorId,
            text,
          });
          return true;
        } catch {
          // This agent can't edit (no editor support, or the path is outside its folders).
        } finally {
          if (editorId) {
            await connection.link
              .call("agents.editor", { agent: agent.id, operation: "close", editorId })
              .catch(() => undefined);
          }
        }
      }
      return false;
    },
    [agents, connection, cwd],
  );

  const finishSave = useCallback(
    (text: string, result?: { modifiedAt: number; size: number }) => {
      setLoadedFile((prev) =>
        prev
          ? {
              ...prev,
              text,
              size: result?.size ?? new TextEncoder().encode(text).byteLength,
              modifiedAt: result?.modifiedAt ?? prev.modifiedAt,
            }
          : null,
      );
      setFileDraft(draftOwner, sessionId, draftTabId, undefined);
      setEditing(false);
      setSavedNotice(true);
      window.dispatchEvent(new CustomEvent(INSPECTOR_FILE_SAVED_EVENT));
      setTimeout(() => setSavedNotice(false), 1400);
    },
    [draftOwner, draftTabId, sessionId],
  );

  const handleSaveFile = useCallback(
    async (overwrite = false) => {
      // A ref, not state: the overwrite retry runs from inside the first attempt's handler.
      if (!connection || !loadedFile || loadedFile.kind !== "text" || savingRef.current) {
        return;
      }
      const text = draftText;
      savingRef.current = true;
      setSaving(true);
      try {
        const result = await connection.link.call("fs.write", {
          path: loadedFile.path,
          text,
          ...(overwrite || loadedFile.modifiedAt === undefined
            ? {}
            : { expectedModifiedAt: loadedFile.modifiedAt }),
        });
        finishSave(text, result);
      } catch (err) {
        if (rpcAppCode(err) === "conflict") {
          const choice = await dialogs.choose(
            ti("saveConflictBody", { path: toRepoRelativePath(loadedFile.path, cwd) }),
            [
              { value: "reload", label: ti("saveConflictReload") },
              { value: "overwrite", label: ti("saveConflictOverwrite"), destructive: true },
            ],
            { title: ti("saveConflictTitle"), cancelLabel: ti("cancel") },
          );
          savingRef.current = false;
          setSaving(false);
          if (choice === "overwrite") {
            await handleSaveFileRef.current?.(true);
          } else if (choice === "reload") {
            discardDraftAndReload();
          }
          return;
        }
        if (isMethodMissing(err)) {
          if (await saveThroughAgentEditor(loadedFile.path, text)) {
            finishSave(text);
          } else {
            setSaveUnsupported(true);
            await dialogs.alert(ti("saveOldHost"));
          }
          return;
        }
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [
      connection,
      cwd,
      dialogs,
      discardDraftAndReload,
      draftText,
      finishSave,
      loadedFile,
      saveThroughAgentEditor,
      ti,
    ],
  );
  const handleSaveFileRef = useRef(handleSaveFile);
  handleSaveFileRef.current = handleSaveFile;

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

  const loadMoreBanner =
    loadedFile?.kind === "text" && loadedFile.nextOffset !== undefined ? (
      <div className="inspector-banner">
        <span>{ti("truncatedNote")}</span>
        <Button
          size="xs"
          variant="secondary"
          loading={loadingMore}
          disabled={!online}
          onClick={() => {
            void handleLoadMore();
          }}
        >
          {ti("loadMoreFile")}
        </Button>
      </div>
    ) : null;

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
                    setFileDraft(draftOwner, sessionId, draftTabId, undefined);
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
                {saveUnsupported ? null : (
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
                )}
                <CopyButton
                  value={() => loadedFile.text}
                  size="sm"
                  label={t("desktop.menu.copy")}
                />
              </>
            )
          ) : null}

          <IconButton
            icon="refresh"
            size="icon-sm"
            label={ti("reloadFile")}
            loading={fileLoading}
            disabled={!online}
            onClick={() => {
              void handleReload();
            }}
          />

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
                void navigator.clipboard?.writeText(activePath).catch(() => undefined);
              }}
            >
              {t("desktop.menu.copyPath")}
            </MenuItem>
            {openLocally ? (
              <>
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
                {resolvedPlatform === "macos" && isElectronRuntime() ? (
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
                  icon="folder-open"
                  onSelect={() => {
                    void handleOpenExternal(activePath, "reveal");
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
            actions={
              alternatePath && computerKey ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="file-code"
                  onClick={() =>
                    openFileTabInInspector(computerKey, sessionId, alternatePath, {
                      openPanel: true,
                    })
                  }
                >
                  {ti("openOtherFile", {
                    path: toRepoRelativePath(alternatePath, cwd),
                  })}
                </Button>
              ) : undefined
            }
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
              className="inspector-file-image"
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
            // Edit means "let me type": the caret is in the file as soon as the editor shows.
            autoFocus
            aria-label={loadedFile.path}
            className="inspector-editor-textarea"
            spellCheck={false}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={handleEditorKeyDown}
          />
        ) : isMarkdownPath(loadedFile.path) && markdownMode === "preview" ? (
          <div className="inspector-markdown-body ls-markdown">
            {loadMoreBanner}
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
            {loadMoreBanner}
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
