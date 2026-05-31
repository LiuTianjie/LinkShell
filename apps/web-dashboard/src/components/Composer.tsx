import { useState, useRef, useMemo, type KeyboardEvent, type ChangeEvent, type ReactNode } from "react";
import type { AgentCommandDescriptor } from "../lib/types";
import { IconPlus, IconArrowUp, IconStop, IconClose } from "./icons";
import { useIsMobile } from "../hooks/useMediaQuery";

export interface PendingImage {
  data: string; // data URL
  mimeType: string;
  name: string;
}

export interface ComposerProps {
  disabled?: boolean;
  running?: boolean;
  supportsImages?: boolean;
  commands?: AgentCommandDescriptor[];
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
  controls,
  onSend,
  onCancel,
  onExecuteCommand,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [highlight, setHighlight] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const isMobile = useIsMobile();

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

  const resetHeight = () => {
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const pickCommand = (cmd: AgentCommandDescriptor) => {
    if (cmd.argsMode === "none") {
      onExecuteCommand?.(cmd.id);
      setText("");
      resetHeight();
    } else {
      // Fill the input so the user can add arguments, then send.
      setText(`/${cmd.name} `);
      taRef.current?.focus();
    }
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
        setText("");
        resetHeight();
        return;
      }
    }

    if (!trimmed && images.length === 0) return;
    onSend(trimmed, images);
    setText("");
    setImages([]);
    resetHeight();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatch) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, slashMatch.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        pickCommand(slashMatch[Math.min(highlight, slashMatch.length - 1)]);
        return;
      }
      // Cmd/Ctrl+Enter picks the highlighted command (Enter alone = newline).
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && slashMatch[highlight]) {
        e.preventDefault();
        pickCommand(slashMatch[Math.min(highlight, slashMatch.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        setText("");
        return;
      }
    }
    // Enter = newline (default). Cmd/Ctrl+Enter = send.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result);
        setImages((prev) => [...prev, { data, mimeType: file.type || "image/png", name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = ""; // allow re-picking the same file
  };

  return (
    <div className="relative">
      {/* Slash command palette */}
      {slashMatch && (
        <div className="codex-card-raised absolute bottom-full left-0 mb-2 w-80 overflow-hidden p-1">
          {slashMatch.map((cmd, i) => (
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

      {/* One rounded card: textarea on top, a single bottom toolbar (Codex style)
          holding the +/attach control, capability pills, and the send button. */}
      <div className="codex-card-raised flex flex-col gap-1 px-3 pt-2.5 pb-2 transition-colors focus-within:border-accent-dim focus-within:ring-2 focus-within:ring-accent/20">
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
                ? "发送指令，或输入 / 调用命令…  (⌘/Ctrl+Enter 发送)"
                : "向 agent 发送指令…  (⌘/Ctrl+Enter 发送，Enter 换行)"
          }
          onChange={(e) => {
            setText(e.target.value);
            setHighlight(0);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
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
              disabled={disabled || (!text.trim() && images.length === 0)}
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
