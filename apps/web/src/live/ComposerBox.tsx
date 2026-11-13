import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AgentInfo, ContentBlock, ProjectFileEntry } from "@linkshell/wire";
import {
  commandQuery,
  matchCommands,
  normalizeCommandText,
  type Command,
} from "../../../client/src/lib/commands";
import { FileText, Folder, Paperclip, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command as CommandUI,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ErrorNotice, useConnection } from "./common";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL, shrinkImage } from "./attachments";
import { useComposerDraft } from "./composer-draft";
import {
  desktopShortcuts,
  keysBelongToContent,
  matchesShortcut,
  shiftTabShortcut,
  useDesktopCommand,
} from "./desktop-commands";
import { useT } from "./i18n";

/** Plain-text pastes at or above 32 KiB become removable text-attachment chips instead of flooding the textarea. */
export const LARGE_PASTE_CHARS = 32_768;

export interface PastedTextAttachment {
  id: string;
  text: string;
}

export interface ComposerSubmitPayload {
  rawDraft: string;
  text: string;
  files: File[];
  pastedTexts: PastedTextAttachment[];
  blocks: ContentBlock[];
  now: boolean;
  clear: () => void;
}

export interface ComposerToolbarRenderProps {
  hasContent: boolean;
  hasText: boolean;
  openFilePicker: () => void;
  setDraftText: (text: string) => void;
  focus: () => void;
  submit: (now?: boolean) => void;
}

export interface ComposerBoxHandle {
  focus: () => void;
  setDraft: (text: string) => void;
  hasUnsentContent: () => boolean;
  replaceWithQueued: (blocks: ContentBlock[]) => void;
  openFilePicker: () => void;
  submit: (now?: boolean) => void;
}

/** Extracts an active `@file` mention token ending at `caret` (ignoring emails and bare `/commands`). */
export function atFileMention(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | undefined {
  if (text.startsWith("/") && !text.includes(" ")) return undefined;
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const head = text.slice(0, safeCaret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(head);
  if (!match) return undefined;
  const query = match[1] ?? "";
  const start = safeCaret - query.length - 1;
  return { start, end: safeCaret, query };
}

/** Guards custom `Enter` / shortcut handlers against CJK IME composition confirmation (`isComposing` or `keyCode === 229`). */
export function isImeComposing(event: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return Boolean(
    event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.keyCode === 229 ||
      event.nativeEvent?.keyCode === 229,
  );
}

/** True when CSS `field-sizing: content` handles textarea auto-grow natively without layout thrashing. */
export function supportsFieldSizingContent(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("field-sizing", "content")
  );
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error(`无法读取文件 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function filesNeedUpload(
  files: readonly File[],
  capabilities?: AgentInfo["capabilities"],
): boolean {
  return files.some((file) => {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.type) && capabilities?.images) return false;
    if (/^audio\//.test(file.type) && capabilities?.audio && file.size <= 5 * 1024 * 1024) return false;
    if (capabilities?.embeddedContext && file.size <= 5 * 1024 * 1024) return false;
    return true;
  });
}

export async function buildComposerContentBlocks({
  text,
  files,
  pastedTexts,
  blocks = [],
  capabilities,
  uploadDir,
  uploadCache,
  callUpload,
  onSendingFile,
}: {
  text: string;
  files: readonly File[];
  pastedTexts: readonly PastedTextAttachment[];
  blocks?: readonly ContentBlock[];
  capabilities?: AgentInfo["capabilities"];
  uploadDir: string;
  uploadCache?: WeakMap<File, string>;
  callUpload: (dir: string, name: string, data: string) => Promise<{ path: string }>;
  onSendingFile?: (name: string | undefined) => void;
}): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [...blocks];
  if (text) content.unshift({ type: "text", text });
  for (const pasted of pastedTexts) {
    if (pasted.text) content.push({ type: "text", text: pasted.text });
  }
  try {
    for (const file of files) {
      onSendingFile?.(file.name);
      const data = await fileToBase64(file);
      if (/^image\/(png|jpe?g|webp|gif)$/.test(file.type) && capabilities?.images) {
        content.push({ type: "image", mimeType: file.type, data });
      } else if (
        /^audio\//.test(file.type) &&
        capabilities?.audio &&
        file.size <= 5 * 1024 * 1024
      ) {
        content.push({ type: "audio", mimeType: file.type, data });
      } else if (capabilities?.embeddedContext && file.size <= 5 * 1024 * 1024) {
        content.push({
          type: "resource",
          resource: {
            uri: `attachment:${encodeURIComponent(file.name)}`,
            mimeType: file.type || "application/octet-stream",
            ...(/^text\//.test(file.type) || file.type === "application/json"
              ? { text: await file.text() }
              : { blob: data }),
          },
        });
      } else {
        const cached = uploadCache?.get(file);
        const path = cached ?? (await callUpload(uploadDir, file.name, data)).path;
        uploadCache?.set(file, path);
        content.push({
          type: "resource_link",
          uri: path,
          name: file.name,
        });
      }
    }
  } finally {
    onSendingFile?.(undefined);
  }
  return content;
}

function useOptionalDraft(draftKey?: string) {
  const persisted = useComposerDraft(draftKey ?? "__ephemeral_unused__");
  const [localText, setLocalText] = useState("");
  const localRef = useRef("");
  const updateLocal = useCallback((change: string | ((current: string) => string)) => {
    const next = typeof change === "function" ? change(localRef.current) : change;
    localRef.current = next;
    setLocalText(next);
  }, []);
  const readLocalText = useCallback(() => localRef.current, []);
  const clearLocalSubmitted = useCallback((submitted: string) => {
    if (localRef.current === submitted) {
      localRef.current = "";
      setLocalText("");
    }
  }, []);
  if (draftKey) return persisted;
  return {
    text: localText,
    setText: updateLocal,
    readText: readLocalText,
    clearSubmitted: clearLocalSubmitted,
  };
}

export interface ComposerBoxProps {
  variant?: "session" | "new-session";
  draftKey?: string;
  cwd: string;
  online: boolean;
  busy?: boolean;
  disabled?: boolean;
  active?: boolean;
  autoFocus?: boolean;
  rows?: number;
  id?: string;
  ariaLabel: string;
  ariaDescribedBy?: string;
  placeholder: string;
  layoutKey?: unknown;
  commands?: Command[];
  inlineAttachmentError?: boolean;
  onAttachmentErrorChange?: (error: string | undefined) => void;
  onChooseCommand?: (command: Command, helpers: { rawDraft: string; clearDraft: () => void; setDraftText: (text: string) => void; focus: () => void }) => void | Promise<void>;
  onSubmit: (payload: ComposerSubmitPayload) => void | Promise<void>;
  onCancel?: () => void;
  onShortcutPicker?: (category: "model" | "mode" | "effort") => void;
  toolbar?: (props: ComposerToolbarRenderProps) => ReactNode;
}

export const ComposerBox = forwardRef<ComposerBoxHandle, ComposerBoxProps>(function ComposerBox(
  {
    variant = "session",
    draftKey,
    cwd,
    online,
    busy = false,
    disabled = false,
    active = true,
    autoFocus = false,
    rows = 2,
    id,
    ariaLabel,
    ariaDescribedBy,
    placeholder,
    layoutKey,
    commands = [],
    inlineAttachmentError = variant === "new-session",
    onAttachmentErrorChange,
    onChooseCommand,
    onSubmit,
    onCancel,
    onShortcutPicker,
    toolbar,
  },
  ref,
) {
  const t = useT();
  const { link } = useConnection();
  const { text: draft, setText: setDraft, readText: readDraft, clearSubmitted } = useOptionalDraft(draftKey);
  const [files, setFiles] = useState<File[]>([]);
  const [pastedTexts, setPastedTexts] = useState<PastedTextAttachment[]>([]);
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, commitAttachmentError] = useState<string>();
  const setAttachmentError = useCallback(
    (error: string | undefined) => {
      commitAttachmentError(error);
      onAttachmentErrorChange?.(error);
    },
    [onAttachmentErrorChange],
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const pasteSeq = useRef(0);

  const focus = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const openFilePicker = useCallback(() => {
    uploadRef.current?.click();
  }, []);

  // Slash command suggestions
  const [choice, setChoice] = useState(0);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string>();
  const query =
    commands.length > 0 && dismissedSuggestions !== draft ? commandQuery(draft) : undefined;
  const suggestions = useMemo(
    () => (query === undefined ? [] : matchCommands(commands, query).slice(0, 10)),
    [commands, query],
  );
  useEffect(() => {
    setChoice(0);
  }, [query]);

  // `@file` fuzzy project file autocomplete
  const [caret, setCaret] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string>();
  const rawMention = useMemo(() => atFileMention(draft, caret), [draft, caret]);
  const mentionKey = rawMention ? `${rawMention.start}:${rawMention.query}` : undefined;
  const mention =
    query === undefined && mentionKey && dismissedMention !== mentionKey ? rawMention : undefined;
  const [mentionFiles, setMentionFiles] = useState<ProjectFileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionChoice, setMentionChoice] = useState(0);
  const hasMention = Boolean(mention);
  const mentionQuery = mention?.query;

  useEffect(() => {
    setMentionChoice(0);
  }, [mentionQuery]);

  useEffect(() => {
    const trimmedCwd = cwd.trim();
    if (!hasMention || !online || !trimmedCwd) {
      setMentionFiles([]);
      setMentionLoading(false);
      return;
    }
    let alive = true;
    setMentionLoading(true);
    const timer = setTimeout(() => {
      link
        .call("fs.projectFiles", { cwd: trimmedCwd, query: mentionQuery ?? "", limit: 30 })
        .then(
          (res) => {
            if (alive) setMentionFiles(res.files);
          },
          () => {
            if (alive) setMentionFiles([]);
          },
        )
        .finally(() => {
          if (alive) setMentionLoading(false);
        });
    }, 90);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [link, online, cwd, hasMention, mentionQuery]);

  // Fallback JS auto-grow ONLY when the engine lacks CSS `field-sizing: content`.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element || supportsFieldSizingContent()) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draft, layoutKey]);

  // In-session composer commands (`⌘K` palette & native shortcuts)
  useDesktopCommand((command) => {
    if (!active) return;
    if (command.command === "composer") {
      if (command.target === "focus") textareaRef.current?.focus();
      else onShortcutPicker?.(command.target);
    }
  });

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || keysBelongToContent() || isImeComposing(event)) return;
      if (matchesShortcut(event, desktopShortcuts.focusComposer)) {
        event.preventDefault();
        textareaRef.current?.focus();
        return;
      }
      if (!onShortcutPicker) return;
      if (matchesShortcut(event, desktopShortcuts.modelPicker)) {
        event.preventDefault();
        onShortcutPicker("model");
      } else if (matchesShortcut(event, desktopShortcuts.modePicker)) {
        event.preventDefault();
        onShortcutPicker("mode");
      } else if (matchesShortcut(event, desktopShortcuts.effortPicker)) {
        event.preventDefault();
        onShortcutPicker("effort");
      } else if (matchesShortcut(event, shiftTabShortcut)) {
        const target = event.target as HTMLElement | null;
        if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
        const onTextarea = target === textareaRef.current;
        const onAmbientSurface =
          target === document.body ||
          target === document.documentElement ||
          (Boolean(target?.closest(".live-session, .new-session-page")) &&
            !target?.closest("button, a, input, select, textarea, [tabindex]"));
        if (onTextarea || onAmbientSurface) {
          event.preventDefault();
          onShortcutPicker("mode");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onShortcutPicker]);

  const takeFiles = useCallback(
    (incoming: File[]) => {
      const rejected = incoming.filter(
        (file) => file.size > MAX_ATTACHMENT_BYTES || file.name.length > 255,
      );
      setAttachmentError(
        rejected.length
          ? `未添加 ${rejected.map((file) => `「${file.name}」`).join("、")}。单个附件不能超过 ${MAX_ATTACHMENT_LABEL}（图片会先自动压缩），文件名不能超过 255 个字符。`
          : undefined,
      );
      setFiles((previous) => {
        const accepted = incoming.filter((file) => !rejected.includes(file));
        return [
          ...previous,
          ...accepted.filter(
            (file, index) =>
              ![...previous, ...accepted.slice(0, index)].some(
                (entry) =>
                  entry.name === file.name &&
                  entry.size === file.size &&
                  entry.lastModified === file.lastModified,
              ),
          ),
        ];
      });
    },
    [setAttachmentError],
  );

  const addFiles = useCallback(
    (picked: File[]) => {
      if (!picked.length) return;
      void (async () => {
        const incoming = await Promise.all(picked.map((file) => shrinkImage(file)));
        takeFiles(incoming);
      })();
    },
    [takeFiles],
  );

  const insertFileMention = (entry: ProjectFileEntry) => {
    if (!mention) return;
    const inserted = `@${entry.relativePath} `;
    const nextDraft = draft.slice(0, mention.start) + inserted + draft.slice(mention.end);
    const nextCaret = mention.start + inserted.length;
    setDraft(nextDraft);
    setCaret(nextCaret);
    setDismissedMention(undefined);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const setDraftText = useCallback(
    (next: string) => {
      setDraft(next);
      setCaret(next.length);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [setDraft],
  );

  const expandPastedText = (attachmentId: string) => {
    const entry = pastedTexts.find((item) => item.id === attachmentId);
    if (!entry) return;
    setPastedTexts((previous) => previous.filter((item) => item.id !== attachmentId));
    const current = readDraft();
    const next = current
      ? current.endsWith("\n")
        ? `${current}${entry.text}`
        : `${current}\n${entry.text}`
      : entry.text;
    setDraft(next);
    setCaret(next.length);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseCommand = async (command: Command) => {
    const submittedDraft = readDraft();
    if (onChooseCommand) {
      await onChooseCommand(command, {
        rawDraft: submittedDraft,
        clearDraft: () => clearSubmitted(submittedDraft),
        setDraftText,
        focus,
      });
      return;
    }
    setDraftText(`/${command.name} `);
  };

  const submitRef = useRef<(now?: boolean) => void>(() => {});
  submitRef.current = (now = false) => {
    const submittedDraft = readDraft();
    const normalized = normalizeCommandText(submittedDraft).trim();
    const snapshotFiles = [...files];
    const snapshotPastes = [...pastedTexts];
    const snapshotBlocks = [...blocks];
    void onSubmit({
      rawDraft: submittedDraft,
      text: normalized,
      files: snapshotFiles,
      pastedTexts: snapshotPastes,
      blocks: snapshotBlocks,
      now,
      clear: () => {
        clearSubmitted(submittedDraft);
        setFiles((current) => current.filter((file) => !snapshotFiles.includes(file)));
        setPastedTexts((current) =>
          current.filter((item) => !snapshotPastes.some((sent) => sent.id === item.id)),
        );
        setBlocks((current) => current.filter((block) => !snapshotBlocks.includes(block)));
        setAttachmentError(undefined);
        textareaRef.current?.focus();
      },
    });
  };

  const triggerSubmit = useCallback((now = false) => {
    submitRef.current(now);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus,
      setDraft: setDraftText,
      hasUnsentContent: () =>
        Boolean(
          readDraft().trim() || files.length > 0 || pastedTexts.length > 0 || blocks.length > 0,
        ),
      replaceWithQueued: (queuedBlocks) => {
        const nextText = queuedBlocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        setDraft(nextText);
        setCaret(nextText.length);
        setBlocks(queuedBlocks.filter((block) => block.type !== "text"));
        setFiles([]);
        setPastedTexts([]);
        requestAnimationFrame(() => textareaRef.current?.focus());
      },
      openFilePicker,
      submit: triggerSubmit,
    }),
    [blocks.length, files.length, focus, openFilePicker, pastedTexts.length, readDraft, setDraft, setDraftText, triggerSubmit],
  );

  const hasText = Boolean(draft.trim()) || pastedTexts.length > 0;
  const hasContent = hasText || files.length > 0 || blocks.length > 0;

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = Array.from(event.clipboardData?.files ?? []);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      addFiles(pastedFiles);
      return;
    }
    const plain = event.clipboardData?.getData("text/plain") ?? "";
    if (plain.length >= LARGE_PASTE_CHARS) {
      event.preventDefault();
      const nextId = `paste-${++pasteSeq.current}`;
      setPastedTexts((previous) => [...previous, { id: nextId, text: plain }]);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape" && mention !== undefined) {
      event.preventDefault();
      if (mentionKey) setDismissedMention(mentionKey);
      return;
    }
    if (
      mention !== undefined &&
      mentionFiles.length > 0 &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      setMentionChoice(
        (value) =>
          (value + (event.key === "ArrowDown" ? 1 : mentionFiles.length - 1)) %
          mentionFiles.length,
      );
      return;
    }
    if (
      mention !== undefined &&
      mentionFiles.length > 0 &&
      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
    ) {
      event.preventDefault();
      const picked = mentionFiles[mentionChoice] ?? mentionFiles[0];
      if (picked) insertFileMention(picked);
      return;
    }
    if (event.key === "Escape" && query !== undefined) {
      event.preventDefault();
      setDismissedSuggestions(draft);
      return;
    }
    if (
      suggestions.length > 0 &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      setChoice(
        (value) =>
          (value + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) %
          suggestions.length,
      );
      return;
    }
    if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (suggestions.length > 0) {
        void chooseCommand(suggestions[choice] ?? suggestions[0]!);
      } else {
        triggerSubmit(event.metaKey || event.ctrlKey);
      }
    }
  };

  const dragHandlers = {
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDragging(false);
      }
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      setDragging(false);
      addFiles(Array.from(event.dataTransfer.files));
    },
  };

  const attachmentsView = (
    <div className="attachment-list">
      {files.map((file, index) => (
        <span key={`${file.name}-${index}`}>
          <Paperclip aria-hidden="true" />
          <span className="attachment-name" title={file.name}>
            {file.name}
          </span>
          <small>
            {file.size < 1_000_000
              ? `${Math.max(1, Math.round(file.size / 1000))} KB`
              : `${(file.size / 1_000_000).toFixed(1)} MB`}
          </small>
          <Button
            type="button"
            variant="ghost"
            size="plain"
            aria-label={`移除附件 ${file.name}`}
            disabled={busy || disabled}
            onClick={() =>
              setFiles((previous) => previous.filter((_, at) => at !== index))
            }
          >
            <X />
          </Button>
        </span>
      ))}
      {pastedTexts.map((item) => (
        <span key={item.id} className="attachment-pasted-text">
          <FileText aria-hidden="true" />
          <span className="attachment-name" title={item.text.slice(0, 200)}>
            粘贴文本
          </span>
          <small>{item.text.length.toLocaleString()} 字</small>
          <Button
            type="button"
            variant="ghost"
            size="plain"
            className="attachment-expand"
            disabled={busy || disabled}
            onClick={() => expandPastedText(item.id)}
          >
            展开为正文
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="plain"
            aria-label="移除粘贴文本"
            disabled={busy || disabled}
            onClick={() =>
              setPastedTexts((previous) => previous.filter((entry) => entry.id !== item.id))
            }
          >
            <X />
          </Button>
        </span>
      ))}
      {blocks.length > 0 && (
        <span>
          {blocks.length} 个已有附件
          <Button
            type="button"
            variant="ghost"
            size="plain"
            aria-label="移除已有附件"
            disabled={busy || disabled}
            onClick={() => setBlocks([])}
          >
            <X />
          </Button>
        </span>
      )}
    </div>
  );

  const hiddenFileInput = (
    <Input
      ref={uploadRef}
      type="file"
      multiple
      hidden
      onChange={(event) => {
        addFiles(Array.from(event.target.files ?? []));
        event.target.value = "";
      }}
    />
  );

  const renderedToolbar = toolbar?.({
    hasContent,
    hasText,
    openFilePicker,
    setDraftText,
    focus,
    submit: triggerSubmit,
  });

  const sharedTextareaProps = {
    id,
    autoFocus,
    disabled,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    value: draft,
    placeholder,
    rows,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      setCaret(event.target.selectionStart ?? event.target.value.length);
    },
    onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      setCaret(event.currentTarget.selectionStart ?? 0);
    },
    onClick: (event: React.MouseEvent<HTMLTextAreaElement>) => {
      setCaret(event.currentTarget.selectionStart ?? 0);
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      setCaret(event.currentTarget.selectionStart ?? 0);
    },
    onPaste: handlePaste,
    onKeyDown: handleKeyDown,
  };

  return (
    <>
      {inlineAttachmentError && <ErrorNotice error={attachmentError} />}
      {hiddenFileInput}
      <Popover
        open={query !== undefined || mention !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            if (query !== undefined) setDismissedSuggestions(draft);
            if (mentionKey) setDismissedMention(mentionKey);
          }
        }}
      >
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={mention ? t("composer.mentionFiles") : "命令建议"}
          className="w-(--radix-popover-trigger-width) max-h-(--radix-popover-content-available-height) overflow-hidden p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target === textareaRef.current) event.preventDefault();
          }}
        >
          {mention ? (
            <CommandUI
              className="h-auto"
              shouldFilter={false}
              value={mentionFiles[mentionChoice]?.relativePath ?? ""}
              onValueChange={(value) => {
                const index = mentionFiles.findIndex((entry) => entry.relativePath === value);
                if (index >= 0) setMentionChoice(index);
              }}
            >
              <CommandList
                aria-label={t("composer.mentionFiles")}
                className="max-h-[min(18rem,35dvh,var(--radix-popover-content-available-height))]"
              >
                <CommandEmpty>
                  {mentionLoading ? t("composer.mentionSearching") : t("composer.mentionEmpty")}
                </CommandEmpty>
                <CommandGroup heading={t("composer.mentionFiles")}>
                  {mentionFiles.map((entry) => (
                    <CommandItem
                      key={entry.relativePath}
                      value={entry.relativePath}
                      onMouseDown={(event) => event.preventDefault()}
                      onSelect={() => insertFileMention(entry)}
                    >
                      {entry.isDir ? (
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className="truncate font-mono text-xs">{entry.relativePath}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </CommandUI>
          ) : (
            <CommandUI
              className="h-auto"
              shouldFilter={false}
              value={suggestions[choice]?.name ?? ""}
              onValueChange={(value) => {
                const index = suggestions.findIndex((command) => command.name === value);
                if (index >= 0) setChoice(index);
              }}
            >
              <CommandList
                aria-label="命令建议"
                className="max-h-[min(18rem,35dvh,var(--radix-popover-content-available-height))]"
              >
                <CommandEmpty>没有匹配项，可打开命令面板查看全部。</CommandEmpty>
                <CommandGroup>
                  {suggestions.map((command) => (
                    <CommandItem
                      key={command.name}
                      value={command.name}
                      onMouseDown={(event) => event.preventDefault()}
                      onSelect={() => void chooseCommand(command)}
                    >
                      <strong>/{command.name}</strong>
                      <span className="text-muted-foreground">{command.description}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </CommandUI>
          )}
        </PopoverContent>
        <PopoverAnchor asChild>
          {variant === "new-session" ? (
            <form
              className="new-session-composer"
              data-dragging={dragging || undefined}
              onSubmit={(event) => {
                event.preventDefault();
                triggerSubmit(false);
              }}
              {...dragHandlers}
            >
              {dragging && (
                <div className="composer-drop-hint">
                  <Plus aria-hidden="true" />
                  松开以添加附件
                </div>
              )}
              {attachmentsView}
              <textarea ref={textareaRef} {...sharedTextareaProps} />
              {renderedToolbar && <div className="new-session-bar">{renderedToolbar}</div>}
            </form>
          ) : (
            <InputGroup
              className="composer rounded-[var(--radius-composer)] bg-[var(--plain)] dark:bg-[var(--plain)]"
              data-dragging={dragging || undefined}
              {...dragHandlers}
            >
              {dragging && (
                <div className="composer-drop-hint">
                  <Plus aria-hidden="true" />
                  松开以添加附件
                </div>
              )}
              {attachmentsView}
              <InputGroupTextarea
                ref={textareaRef}
                className="px-3.5 pt-3 pb-1 text-md leading-relaxed"
                {...sharedTextareaProps}
              />
              {renderedToolbar && (
                <InputGroupAddon align="block-end" className="composer-toolbar justify-between">
                  {renderedToolbar}
                </InputGroupAddon>
              )}
            </InputGroup>
          )}
        </PopoverAnchor>
      </Popover>
    </>
  );
});
