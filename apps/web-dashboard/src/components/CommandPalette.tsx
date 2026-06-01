import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconSearch } from "./icons";

export interface PaletteAction {
  id: string;
  label: string;
  /** Right-aligned secondary text (shortcut, provider, group label). */
  hint?: string;
  icon?: ReactNode;
  /** Extra text folded into the fuzzy match (not displayed). */
  keywords?: string;
  /** Section heading this action sorts under (e.g. "对话", "操作"). */
  group?: string;
  run: () => void;
}

// Subsequence fuzzy match: every query char must appear in order. Returns a
// score (lower = tighter/earlier match) or null when it doesn't match.
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let score = 0;
  let prev = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const found = t.indexOf(c, ti);
    if (found === -1) return null;
    // Penalize gaps so contiguous matches rank higher.
    if (prev >= 0) score += found - prev - 1;
    else score += found; // earlier first-match ranks higher
    prev = found;
    ti = found + 1;
  }
  return score;
}

/** Cmd/Ctrl+K command palette: fuzzy-search actions, keyboard nav, Enter to run.
 *  Fully controlled — the parent owns open state and supplies the action list. */
export function CommandPalette({
  open,
  onClose,
  actions,
  placeholder = "搜索命令、对话…",
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset query + focus the input each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const scored = actions
      .map((a) => ({ a, score: fuzzyScore(query, `${a.label} ${a.hint ?? ""} ${a.keywords ?? ""}`) }))
      .filter((x): x is { a: PaletteAction; score: number } => x.score !== null)
      .sort((x, y) => x.score - y.score);
    return scored.map((x) => x.a);
  }, [actions, query]);

  // Keep the highlight in range as the result set shrinks.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const run = (i: number) => {
    const action = filtered[i];
    if (!action) return;
    onClose();
    action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(highlight);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Render grouped, but keep a flat index so keyboard nav matches display order.
  let flatIndex = -1;
  const groups = new Map<string, PaletteAction[]>();
  for (const a of filtered) {
    const g = a.group ?? "";
    const arr = groups.get(g) ?? [];
    arr.push(a);
    groups.set(g, arr);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-canvas/60 px-4 pt-[12vh] backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="codex-card-raised w-full max-w-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
          <IconSearch size={16} className="shrink-0 text-content-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-content-primary placeholder-content-muted outline-none"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-content-faint">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-content-muted">没有匹配项</p>
          ) : (
            [...groups.entries()].map(([group, items]) => (
              <div key={group || "_"} className="mb-1">
                {group && (
                  <p className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-content-faint">
                    {group}
                  </p>
                )}
                {items.map((a) => {
                  flatIndex += 1;
                  const i = flatIndex;
                  return (
                    <button
                      key={a.id}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => run(i)}
                      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        i === highlight ? "bg-surface-overlay" : "hover:bg-surface-overlay"
                      }`}
                    >
                      {a.icon && <span className="shrink-0 text-content-muted">{a.icon}</span>}
                      <span className="min-w-0 flex-1 truncate text-sm text-content-primary">{a.label}</span>
                      {a.hint && <span className="shrink-0 text-2xs text-content-faint">{a.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
