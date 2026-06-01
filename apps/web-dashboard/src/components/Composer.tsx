import { useState, useRef, useMemo, useEffect, type KeyboardEvent, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import type { AgentCommandDescriptor } from "../lib/types";
import { IconPlus, IconArrowUp, IconStop, IconClose, IconFile, IconFolder } from "./icons";
import { useIsMobile } from "../hooks/useMediaQuery";
import { loadDraft, saveDraft } from "../lib/storage";

export interface PendingImage {
  data: string; // data URL
  mimeType: string;
  name: string;
}

interface MentionEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface ComposerProps {
  disabled?: boolean;
  running?: boolean;
  supportsImages?: boolean;
  commands?: AgentCommandDescriptor[];
  /** Active conversation id — scopes the persisted draft so each thread keeps
   *  its own in-progress text across refreshes and conversation switches. */
  conversationId?: string;
  /** Last user message in this conversation, recalled by pressing ↑ on an
   *  empty input (shell-style history). */
  lastUserText?: string;
  /** Working directory used as the base for @-file-mention browsing. */
  cwd?: string;
  /** Browse the host filesystem for @ mentions (wired to store.browse). */
  onBrowse?: (path: string) => Promise<{ path: string; entries: MentionEntry[]; error?: string }>;
  /** External text injection (edit-and-resend): when nonce changes, the text is
   *  loaded into the input and focused. */
  seedText?: { text: string; nonce: number };
  /** Capability-driven control pills (model / effort / permission / plan),
   *  rendered inside the composer's bottom toolbar — Codex style. */
  controls?: ReactNode;
  onSend: (text: string, images: PendingImage[]) => void;
  onCancel?: () => void;
  onExecuteCommand?: (commandId: string, args?: string) => void;
}

export function Composer({
  disabled,
  running,
  supportsImages,
  commands = [],
  conversationId,
  lastUserText,
  cwd,
  onBrowse,
  seedText,
  controls,
  onSend,
  onCancel,
  onExecuteCommand,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // Picked @-file references, shown as removable chips above the input and
  // re-expanded to `@path` tokens on send (directories are NOT chipped — they
  // stay inline so the palette can drill into them).
  const [mentions, setMentions] = useState<string[]>([]);
  // @-mention state: entries fetched for the directory under the cursor token,
  // refetched only when that directory changes (not on every keystroke).
  const [mentionEntries, setMentionEntries] = useState<MentionEntry[]>([]);
  const [mentionFetchedDir, setMentionFetchedDir] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const isMobile = useIsMobile();

  // Load the persisted draft when the active conversation changes.
  useEffect(() => {
    if (!conversationId) return;
    const draft = loadDraft(conversationId);
    setText(draft);
    setMentions([]); // file chips are per-message, never carry across switches
    // Defer the height sync until the textarea reflects the new value.
    requestAnimationFrame(() => autoGrow());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // External injection (edit-and-resend): replace the text and focus. nonce 0
  // is the initial sentinel — ignore it so it can't clobber a loaded draft.
  useEffect(() => {
    if (!seedText || seedText.nonce === 0) return;
    setText(seedText.text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        autoGrow();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedText?.nonce]);

  // Slash-command palette: active when the input is a single "/token" with no
  // space yet. Filters commands by name prefix.
  const slashMatch = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text);
    if (!m || commands.length === 0) return null;
    const q = m[1].toLowerCase();
    const matches = commands
      .filter((c) => c.name.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
      .slice(0, 8);
    return matches.length > 0 ? matches : null;
  }, [text, commands]);

  // @-mention: the "@token" immediately before the cursor (end of text). Split
  // into a directory part and a filter, so "@src/co" browses src/ filtering "co".
  const atMatch = useMemo(() => {
    if (!onBrowse) return null;
    const m = /(?:^|\s)@(\S*)$/.exec(text);
    if (!m) return null;
    const query = m[1];
    const slash = query.lastIndexOf("/");
    const dir = slash >= 0 ? query.slice(0, slash) : "";
    const filter = slash >= 0 ? query.slice(slash + 1) : query;
    return { token: `@${query}`, query, dir, filter };
  }, [text, onBrowse]);

  // Absolute directory to browse for the current @ token.
  const mentionTargetDir = useMemo(() => {
    if (!atMatch) return null;
    const base = (cwd || ".").replace(/\/+$/, "") || "/";
    return atMatch.dir ? `${base}/${atMatch.dir}` : base;
  }, [atMatch, cwd]);

  // Fetch entries when the target directory changes (guarded against races).
  useEffect(() => {
    if (!mentionTargetDir || !onBrowse) return;
    if (mentionTargetDir === mentionFetchedDir) return;
    let cancelled = false;
    onBrowse(mentionTargetDir)
      .then((res) => {
        if (cancelled) return;
        setMentionEntries(res.error ? [] : res.entries);
        setMentionFetchedDir(mentionTargetDir);
      })
      .catch(() => {
        if (!cancelled) setMentionEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionTargetDir, mentionFetchedDir, onBrowse]);

  const mentionMatches = useMemo(() => {
    if (!atMatch || mentionFetchedDir !== mentionTargetDir) return null;
    const f = atMatch.filter.toLowerCase();
    const matches = mentionEntries
      .filter((e) => e.name.toLowerCase().includes(f))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      // Cap generously and let the panel scroll. A tight cap (was 8) hid every
      // file when a directory had ≥8 subfolders, since folders sort first.
      .slice(0, 50);
    return matches.length > 0 ? matches : null;
  }, [atMatch, mentionEntries, mentionFetchedDir, mentionTargetDir]);

  // One active palette at a time (slash takes priority; they can't co-occur).
  const palette: { kind: "slash"; items: AgentCommandDescriptor[] } | { kind: "mention"; items: MentionEntry[] } | null =
    slashMatch ? { kind: "slash", items: slashMatch } : mentionMatches ? { kind: "mention", items: mentionMatches } : null;

  const resetHeight = () => {
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };

  const updateText = (value: string) => {
    setText(value);
    setHighlight(0);
    if (conversationId) saveDraft(conversationId, value);
    autoGrow();
  };

  const pickCommand = (cmd: AgentCommandDescriptor) => {
    if (cmd.argsMode === "none") {
      onExecuteCommand?.(cmd.id);
      updateText("");
      resetHeight();
    } else {
      // Fill the input so the user can add arguments, then send.
      updateText(`/${cmd.name} `);
      taRef.current?.focus();
    }
  };

  // Insert the picked file/dir, replacing the trailing @token. Directories stay
  // inline (trailing slash) so the user can drill in; files become a removable
  // chip above the input and the @token is stripped from the text.
  const pickMention = (entry: MentionEntry) => {
    if (!atMatch) return;
    const base = (cwd || ".").replace(/\/+$/, "");
    const rel = base && entry.path.startsWith(base)
      ? entry.path.slice(base.length).replace(/^\/+/, "")
      : entry.name;
    const head = text.slice(0, text.length - atMatch.token.length);
    if (entry.isDirectory) {
      updateText(`${head}@${rel}/`);
    } else {
      updateText(head);
      setMentions((prev) => (prev.includes(rel) ? prev : [...prev, rel]));
    }
    taRef.current?.focus();
  };

  const submit = () => {
    if (disabled) return;
    const trimmed = text.trim();

    // A leading slash that exactly names a command → execute as command.
    const cmdMatch = /^\/(\S+)\s*(.*)$/s.exec(trimmed);
    if (cmdMatch && onExecuteCommand) {
      const cmd = commands.find((c) => c.name.toLowerCase() === cmdMatch[1].toLowerCase());
      if (cmd) {
        onExecuteCommand(cmd.id, cmdMatch[2] || undefined);
        updateText("");
        setMentions([]);
        resetHeight();
        return;
      }
    }

    // Expand picked file chips back into leading @path tokens so the agent
    // receives them the same way it would from inline typing.
    const mentionPrefix = mentions.map((m) => `@${m}`).join(" ");
    const body = [mentionPrefix, trimmed].filter(Boolean).join(" ");
    if (!body && images.length === 0) return;
    onSend(body, images);
    updateText("");
    setImages([]);
    setMentions([]);
    resetHeight();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (palette) {
      const len = palette.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, len - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      const pick = () => {
        const i = Math.min(highlight, len - 1);
        if (palette.kind === "slash") pickCommand(palette.items[i]);
        else pickMention(palette.items[i]);
      };
      if (e.key === "Tab") {
        e.preventDefault();
        pick();
        return;
      }
      // Cmd/Ctrl+Enter picks the highlighted entry (Enter alone = newline).
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        pick();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Slash: clear the whole token. Mention: drop just the trailing @token.
        if (palette.kind === "slash") updateText("");
        else if (atMatch) updateText(text.slice(0, text.length - atMatch.token.length));
        return;
      }
    }
    // ↑ on an empty input recalls the last user message (shell history).
    if (e.key === "ArrowUp" && !palette && text === "" && lastUserText) {
      e.preventDefault();
      updateText(lastUserText);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      return;
    }
    // Enter = newline (default). Cmd/Ctrl+Enter = send.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const addImageFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result);
        setImages((prev) => [...prev, { data, mimeType: file.type || "image/png", name: file.name || "粘贴图片" }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = ""; // allow re-picking the same file
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsImages) return;
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null);
    if (files.length > 0) {
      e.preventDefault(); // don't also paste the file path as text
      addImageFiles(files);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    if (!supportsImages) return;
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!supportsImages) return;
    if (Array.from(e.dataTransfer.items).some((it) => it.kind === "file")) {
      e.preventDefault();
      setDragOver(true);
    }
  };

  return (
    <div className="relative">
      {/* Slash command / @-mention palette */}
      {palette && (
        <div className="codex-card-raised absolute bottom-full left-0 mb-2 max-h-72 w-80 overflow-y-auto p-1">
          {palette.kind === "slash"
            ? palette.items.map((cmd, i) => (
                <button
                  key={cmd.id}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pickCommand(cmd)}
                  className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                    i === highlight ? "bg-surface-overlay" : "hover:bg-surface-overlay"
                  }`}
                >
                  <span className="font-mono text-xs text-accent">/{cmd.name}</span>
                  <span className="ml-2 flex-1 truncate text-xs text-content-muted">{cmd.title}</span>
                  {cmd.destructive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" title="破坏性操作" />}
                </button>
              ))
            : palette.items.map((entry, i) => (
                <button
                  key={entry.path}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pickMention(entry)}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                    i === highlight ? "bg-surface-overlay" : "hover:bg-surface-overlay"
                  }`}
                >
                  {entry.isDirectory ? (
                    <IconFolder size={13} className="shrink-0 text-content-faint" />
                  ) : (
                    <IconFile size={13} className="shrink-0 text-content-faint" />
                  )}
                  <span className="truncate font-mono text-xs text-content-secondary">{entry.name}</span>
                  {entry.isDirectory && <span className="text-content-faint">/</span>}
                </button>
              ))}
        </div>
      )}

      {/* Image preview chips */}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="group relative">
              <img src={img.data} alt={img.name} className="h-14 w-14 rounded-lg border border-border object-cover" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-danger text-white"
                aria-label="移除图片"
              >
                <IconClose size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Picked @-file reference chips (removable; expanded to @path on send) */}
      {mentions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {mentions.map((m) => (
            <span
              key={m}
              className="flex items-center gap-1 rounded-lg border border-border bg-surface-overlay py-1 pl-2 pr-1 font-mono text-xs text-content-secondary"
            >
              <IconFile size={12} className="shrink-0 text-content-faint" />
              <span className="max-w-[200px] truncate" title={m}>{m}</span>
              <button
                onClick={() => setMentions((prev) => prev.filter((x) => x !== m))}
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-content-faint transition-colors hover:text-danger"
                aria-label={`移除 ${m}`}
              >
                <IconClose size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* One rounded card: textarea on top, a single bottom toolbar (Codex style)
          holding the +/attach control, capability pills, and the send button. */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        className={`codex-card-raised flex flex-col gap-1 px-3 pt-2.5 pb-2 transition-colors focus-within:border-border-strong ${
          dragOver ? "border-border-strong" : ""
        }`}
      >
        {supportsImages && (
          <input ref={fileRef} type="file" accept="image/*" multiple onChange={onFiles} className="hidden" />
        )}
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          disabled={disabled}
          placeholder={
            isMobile
              ? commands.length > 0
                ? "发送指令，或输入 / 调用命令…"
                : "向 agent 发送指令…"
              : commands.length > 0
                ? "发送指令，/ 调用命令，@ 引用文件  (⌘/Ctrl+Enter 发送)"
                : "向 agent 发送指令，@ 引用文件  (⌘/Ctrl+Enter 发送，Enter 换行)"
          }
          onChange={(e) => updateText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          // text-base (16px) on mobile prevents iOS Safari from auto-zooming
          // the page when the field focuses; md+ keeps the tighter 15px.
          className="min-w-0 resize-none bg-transparent px-0 py-1 text-base leading-6 text-content-primary placeholder-content-muted outline-none md:text-[15px]"
        />

        {/* Bottom toolbar: left cluster (attach + capability pills), right send. */}
        <div className="flex items-center gap-1">
          {supportsImages && (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-content-muted transition-colors hover:bg-surface-overlay hover:text-content-primary disabled:opacity-40"
              title="附加图片"
              aria-label="附加图片"
            >
              <IconPlus size={17} />
            </button>
          )}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
            {controls}
          </div>
          {running && onCancel ? (
            <button
              onClick={onCancel}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-surface-overlay text-content-secondary transition-colors hover:bg-surface-raised hover:text-content-primary"
              aria-label="停止"
              title="停止"
            >
              <IconStop size={14} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={disabled || (!text.trim() && images.length === 0 && mentions.length === 0)}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent-dim text-white transition-colors hover:bg-accent disabled:cursor-default disabled:bg-surface-overlay disabled:text-content-faint"
              aria-label="发送"
              title="发送"
            >
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
