import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ProjectFileEntry } from "@linkshell/wire";
import {
  createPastedBlock,
  isLargePaste,
  reportDesktopError,
  useT,
  type Connection,
  type PastedTextBlock,
} from "@/core";
import { DesktopIcon } from "@/icons";
import { IconButton, Tooltip, isImeComposing } from "@/primitives";
import {
  detectAtFileMention,
  extractCommandQuery,
  filterSlashCommands,
  prepareComposerAttachment,
  useSessionCopy,
  type ComposerAttachment,
  type SlashCommandItem,
} from "./session-helpers";

export interface ComposerBoxProps {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  textareaAriaLabel: string;
  disabled?: boolean;
  connection?: Connection;
  cwd?: string;
  commands?: readonly SlashCommandItem[];
  attachments: readonly ComposerAttachment[];
  onAddAttachments: (added: ComposerAttachment[]) => void;
  onRemoveAttachment: (id: string) => void;
  pastedBlocks: readonly PastedTextBlock[];
  onAddPastedBlock: (block: PastedTextBlock) => void;
  onExpandPastedBlock: (id: string) => void;
  onRemovePastedBlock: (id: string) => void;
  onSubmit: (options?: { steerNow?: boolean }) => void;
  onCycleMode?: () => void;
  /** Esc with no popup open: stop the running turn (the old web composer's `onCancel`). */
  onCancel?: () => void;
  leftControls?: ReactNode;
  rightControls: ReactNode;
  autoFocus?: boolean;
}

export function ComposerBox({
  value,
  onChange,
  placeholder,
  textareaAriaLabel,
  disabled = false,
  connection,
  cwd,
  commands = [],
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  pastedBlocks,
  onAddPastedBlock,
  onExpandPastedBlock,
  onRemovePastedBlock,
  onSubmit,
  onCycleMode,
  onCancel,
  leftControls,
  rightControls,
  autoFocus = false,
}: ComposerBoxProps) {
  const t = useT();
  const copy = useSessionCopy();
  const listboxId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [caretOffset, setCaretOffset] = useState(value.length);
  const [dragging, setDragging] = useState(false);
  const [dismissedPopupKey, setDismissedPopupKey] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileCandidates, setFileCandidates] = useState<ProjectFileEntry[]>([]);

  const slashQuery = useMemo(() => extractCommandQuery(value), [value]);
  const matchingCommands = useMemo(
    () => (slashQuery !== null ? filterSlashCommands(commands, slashQuery) : []),
    [commands, slashQuery],
  );

  const atMatch = useMemo(
    () => (slashQuery === null ? detectAtFileMention(value, caretOffset) : null),
    [caretOffset, slashQuery, value],
  );

  // Debounced `fs.projectFiles` lookup (90ms) when `@` mention is active.
  useEffect(() => {
    if (!atMatch || !connection || !cwd?.trim()) {
      setFileCandidates([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void connection.link
        .call("fs.projectFiles", {
          cwd: cwd.trim(),
          query: atMatch.query || undefined,
          limit: 20,
        })
        .then((res) => {
          if (alive) setFileCandidates(res.files ?? []);
        })
        .catch(() => {
          if (alive) setFileCandidates([]);
        });
    }, 90);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [atMatch, connection, cwd]);

  const activePopupKey =
    slashQuery !== null
      ? `cmd:${slashQuery}`
      : atMatch
        ? `at:${atMatch.start}:${atMatch.query}`
        : null;

  useEffect(() => {
    setSelectedIndex(0);
  }, [activePopupKey, matchingCommands.length, fileCandidates.length]);

  const showSlashPopup =
    slashQuery !== null &&
    matchingCommands.length > 0 &&
    dismissedPopupKey !== activePopupKey;

  const showAtPopup =
    !showSlashPopup &&
    atMatch !== null &&
    fileCandidates.length > 0 &&
    dismissedPopupKey !== activePopupKey;

  const popupCount = showSlashPopup
    ? matchingCommands.length
    : showAtPopup
      ? fileCandidates.length
      : 0;

  const applySlashCommand = (cmd: SlashCommandItem) => {
    const next = `/${cmd.name} `;
    onChange(next);
    setDismissedPopupKey(null);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
        setCaretOffset(next.length);
      }
    });
  };

  const applyFileMention = (entry: ProjectFileEntry) => {
    if (!atMatch) return;
    const inserted = `@${entry.relativePath}${entry.isDir ? "/" : " "}`;
    const next = value.slice(0, atMatch.start) + inserted + value.slice(atMatch.end);
    const nextCaret = atMatch.start + inserted.length;
    onChange(next);
    if (!entry.isDir) setDismissedPopupKey(activePopupKey);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
        setCaretOffset(nextCaret);
      }
    });
  };

  const ingestFiles = async (files: Iterable<File>) => {
    const added: ComposerAttachment[] = [];
    for (const rawFile of files) {
      try {
        const prepared = await prepareComposerAttachment(rawFile);
        added.push(prepared);
      } catch (error) {
        reportDesktopError(error);
      }
    }
    if (added.length > 0) {
      onAddAttachments(added);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const clipboardFiles = Array.from(event.clipboardData?.files ?? []);
    if (clipboardFiles.length > 0) {
      event.preventDefault();
      void ingestFiles(clipboardFiles);
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text && isLargePaste(text)) {
      event.preventDefault();
      onAddPastedBlock(createPastedBlock(text));
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length > 0) {
      void ingestFiles(dropped);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // CRITICAL (`modern-web-guidance` / CJK IME rule): NEVER intercept keys while IME is composing!
    if (isImeComposing(event)) return;

    if (event.key === "Tab" && event.shiftKey && onCycleMode) {
      event.preventDefault();
      onCycleMode();
      return;
    }

    if (popupCount > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((idx) => (idx + 1) % popupCount);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((idx) => (idx - 1 + popupCount) % popupCount);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedPopupKey(activePopupKey);
        return;
      }
      if (
        (event.key === "Tab" && !event.shiftKey) ||
        (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey)
      ) {
        event.preventDefault();
        if (showSlashPopup) {
          const picked = matchingCommands[selectedIndex] ?? matchingCommands[0];
          if (picked) applySlashCommand(picked);
        } else if (showAtPopup) {
          const picked = fileCandidates[selectedIndex] ?? fileCandidates[0];
          if (picked) applyFileMention(picked);
        }
        return;
      }
    }

    if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit({ steerNow: event.metaKey || event.ctrlKey });
    }
  };

  return (
    <div
      className="ls-composer-box"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        // Leaving for a child (the textarea) is not leaving the box; leaving the box from a child is.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) void ingestFiles(files);
        }}
      />

      {(showSlashPopup || showAtPopup) && (
        <div
          id={listboxId}
          role="listbox"
          className="ls-composer-popup"
          aria-label={showSlashPopup ? copy.commandsHeading : copy.filesHeading}
        >
          {showSlashPopup
            ? matchingCommands.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  type="button"
                  role="option"
                  aria-selected={idx === selectedIndex}
                  className="ls-composer-popup-item"
                  data-selected={idx === selectedIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySlashCommand(cmd);
                  }}
                >
                  <DesktopIcon name="terminal" size="xs" />
                  <span className="ls-composer-popup-cmd" title={`/${cmd.name}`}>
                    /{cmd.name}
                    {cmd.hint ? (
                      <span className="ls-composer-popup-hint">{cmd.hint}</span>
                    ) : null}
                  </span>
                  <span className="ls-composer-popup-meta">{cmd.description}</span>
                </button>
              ))
            : fileCandidates.map((entry, idx) => (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={idx === selectedIndex}
                  className="ls-composer-popup-item"
                  data-selected={idx === selectedIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyFileMention(entry);
                  }}
                >
                  <DesktopIcon name={entry.isDir ? "folder" : "file-code"} size="xs" />
                  <span className="ls-composer-popup-path" title={entry.relativePath}>
                    {entry.relativePath}
                  </span>
                </button>
              ))}
        </div>
      )}

      {(attachments.length > 0 || pastedBlocks.length > 0) && (
        <div className="ls-composer-attachments">
          {pastedBlocks.map((block) => (
            <span key={block.id} className="ls-attachment-pill">
              <DesktopIcon name="file-text" size="xs" />
              <span>{t("desktop.composer.pastedBlock", { lines: block.lines })}</span>
              <button
                type="button"
                className="ls-composer-chip"
                style={{ height: 20, padding: "0 6px", fontSize: 11 }}
                onClick={() => onExpandPastedBlock(block.id)}
              >
                {t("desktop.composer.expandPasted")}
              </button>
              <button
                type="button"
                className="ls-attachment-remove"
                aria-label={t("desktop.composer.removeQueued")}
                onClick={() => onRemovePastedBlock(block.id)}
              >
                <DesktopIcon name="close" size="xs" />
              </button>
            </span>
          ))}

          {attachments.map((item) => (
            <span key={item.id} className="ls-attachment-pill" title={item.name}>
              {item.previewUrl ? (
                <img src={item.previewUrl} alt={item.name} className="ls-attachment-thumb" />
              ) : (
                <DesktopIcon name={item.isImage ? "image" : "paperclip"} size="xs" />
              )}
              <span
                style={{
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.name}
              </span>
              <button
                type="button"
                className="ls-attachment-remove"
                aria-label={t("desktop.composer.removeQueued")}
                onClick={() => onRemoveAttachment(item.id)}
              >
                <DesktopIcon name="close" size="xs" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Native contextmenu is intentionally untouched so macOS/Windows Cut/Copy/Paste/Spellcheck work natively. */}
      <textarea
        ref={textareaRef}
        className="ls-composer-textarea"
        aria-label={textareaAriaLabel}
        aria-controls={popupCount > 0 ? listboxId : undefined}
        aria-expanded={popupCount > 0 || undefined}
        placeholder={dragging ? copy.dropFilesHint : placeholder}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={2}
        onChange={(e) => {
          onChange(e.target.value);
          setCaretOffset(e.target.selectionStart ?? e.target.value.length);
          setDismissedPopupKey(null);
        }}
        onSelect={(e) => {
          setCaretOffset(e.currentTarget.selectionStart ?? value.length);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />

      <div className="ls-composer-footer">
        <div className="ls-composer-chips">
          <Tooltip content={t("desktop.composer.attachFile")}>
            <IconButton
              icon="paperclip"
              size="icon-sm"
              label={t("desktop.composer.attachFile")}
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
            />
          </Tooltip>
          {leftControls}
        </div>
        <div className="ls-composer-actions">{rightControls}</div>
      </div>
    </div>
  );
}
