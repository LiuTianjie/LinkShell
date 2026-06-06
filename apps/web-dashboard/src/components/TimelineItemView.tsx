import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { IconWrench, IconCheck, IconChevronRight, IconChevronDown, IconFile, IconClose, IconUsers, IconCopy, IconPencil } from "./icons";
import type { AgentTimelineItem } from "../lib/types";
import { parseDiff, diffStats } from "../lib/diff";

// ── Copy-to-clipboard button (hover-revealed) ───────────────────────

/** Recursively flatten React children to plain text — works for both raw code
 *  strings and the span tree that rehype-highlight produces. */
function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in (node as { props?: { children?: ReactNode } })) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

export function CopyButton({
  text,
  className,
  label = "复制",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (insecure context / denied) — fail silently.
    }
  };
  return (
    <button
      onClick={copy}
      title={copied ? "已复制" : label}
      aria-label={label}
      className={
        className ??
        "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border bg-surface text-content-muted transition-colors hover:text-content-primary"
      }
    >
      {copied ? <IconCheck size={13} className="text-success" /> : <IconCopy size={13} />}
    </button>
  );
}

// ── Search-term highlighting (rehype plugin) ────────────────────────
// Walks the hast tree and wraps case-insensitive matches of `query` in <mark>,
// skipping code/pre subtrees so it never corrupts syntax highlighting. Built as
// a unified attacher factory so it slots into ReactMarkdown's rehypePlugins.
function rehypeMark(query: string) {
  const q = query.toLowerCase();
  const walk = (node: any): void => {
    if (!node || !Array.isArray(node.children)) return;
    if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre")) return;
    const out: any[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string") {
        const value: string = child.value;
        const lower = value.toLowerCase();
        let idx = lower.indexOf(q);
        if (idx === -1) {
          out.push(child);
          continue;
        }
        let last = 0;
        while (idx !== -1) {
          if (idx > last) out.push({ type: "text", value: value.slice(last, idx) });
          out.push({
            type: "element",
            tagName: "mark",
            properties: {},
            children: [{ type: "text", value: value.slice(idx, idx + q.length) }],
          });
          last = idx + q.length;
          idx = lower.indexOf(q, last);
        }
        if (last < value.length) out.push({ type: "text", value: value.slice(last) });
      } else {
        walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  return () => (tree: any) => {
    if (q) walk(tree);
  };
}

// ── Markdown (memoized so streaming siblings don't re-parse it) ──────

export const Markdown = memo(function Markdown({ text, highlight }: { text: string; highlight?: string }) {
  return (
    <div className="prose-codex break-words text-[15px] leading-7 text-content-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // detect: true highlights fenced blocks even without a language hint;
        // ignoreMissing keeps unknown languages from throwing mid-render.
        // When a search query is active, append the <mark> highlighter.
        rehypePlugins={
          highlight
            ? [[rehypeHighlight, { detect: true, ignoreMissing: true }], rehypeMark(highlight)]
            : [[rehypeHighlight, { detect: true, ignoreMissing: true }]]
        }
        components={{
          mark({ children }) {
            return <mark className="rounded bg-warning/30 px-0.5 text-content-primary">{children}</mark>;
          },
          // Replace the default <pre> with a pass-through so our custom code
          // renderer owns the block markup (avoids a nested <pre><pre>).
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children, ...props }) {
            const isBlock = /language-|hljs/.test(className ?? "");
            if (isBlock) {
              const raw = nodeText(children);
              return (
                <div className="group/code relative my-3">
                  <pre className="max-w-full overflow-x-auto rounded-lg border border-border bg-surface-raised p-3 font-mono text-[13px] leading-relaxed">
                    <code className={className} {...props}>
                      {children}
                    </code>
                  </pre>
                  <CopyButton
                    text={raw}
                    className="absolute right-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border bg-surface text-content-muted opacity-0 transition-opacity hover:text-content-primary group-hover/code:opacity-100"
                  />
                </div>
              );
            }
            return (
              <code className="break-all rounded bg-surface-overlay px-1.5 py-0.5 font-mono text-[13px] text-accent" {...props}>
                {children}
              </code>
            );
          },
          a({ children, ...props }) {
            return (
              <a className="text-accent underline underline-offset-2" target="_blank" rel="noreferrer" {...props}>
                {children}
              </a>
            );
          },
          p({ children }) {
            return <p className="my-2">{children}</p>;
          },
          ul({ children }) {
            return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// ── Diff card (the signature Codex element) ─────────────────────────

function DiffCard({ item, onOpen }: { item: AgentTimelineItem; onOpen?: (item: AgentTimelineItem) => void }) {
  const fc = item.fileChange!;
  const lines = fc.diff ? parseDiff(fc.diff) : [];
  const stats = diffStats(lines);
  const paths = fc.entries.length > 0 ? fc.entries.map((e) => e.path) : [];
  const label = paths[0] || fc.summary || "文件变更";
  const extra = paths.length > 1 ? ` +${paths.length - 1}` : "";
  const clickable = Boolean(fc.diff && onOpen);
  return (
    <button
      onClick={() => clickable && onOpen?.(item)}
      className={`flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-left transition-colors ${clickable ? "cursor-pointer hover:border-border-strong hover:bg-surface-overlay" : "cursor-default"}`}
    >
      <IconFile size={14} className="shrink-0 text-content-faint" />
      <span className="truncate font-mono text-[13px] text-content-primary" title={paths.join(", ") || label}>
        {label}
        {extra && <span className="text-content-muted">{extra}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[13px]">
        {stats.added > 0 && <span className="text-diff-addText">+{stats.added}</span>}
        {stats.removed > 0 && <span className="text-diff-removeText">−{stats.removed}</span>}
        {clickable && <IconChevronRight size={13} className="text-content-faint" />}
      </span>
    </button>
  );
}

function parseHunkHeader(text: string): [number, number] | null {
  const m = /@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

export function DiffViewer({ item }: { item: AgentTimelineItem }) {
  const fc = item.fileChange;
  const lines = fc?.diff ? parseDiff(fc.diff) : [];
  const stats = diffStats(lines);
  const pathLabel = fc?.entries.map((e) => e.path).join(", ") || fc?.summary || "文件变更";
  let oldNo = 0;
  let newNo = 0;
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <IconFile size={13} className="shrink-0 text-content-faint" />
        <span className="truncate font-mono text-[13px] text-content-secondary" title={pathLabel}>{pathLabel}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[13px]">
          {stats.added > 0 && <span className="text-diff-addText">+{stats.added}</span>}
          {stats.removed > 0 && <span className="text-diff-removeText">−{stats.removed}</span>}
        </span>
        {fc?.diff && <CopyButton text={fc.diff} label="复制差异" />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[13px] leading-[1.6]">
        {lines.length === 0 ? (
          <p className="px-3 py-2 text-content-muted">{fc?.summary || "无差异内容"}</p>
        ) : (
          lines.map((line, i) => {
            if (line.kind === "hunk") {
              const parsed = parseHunkHeader(line.text);
              if (parsed) { oldNo = parsed[0]; newNo = parsed[1]; }
              return (
                <div key={i} className="flex bg-surface-raised/60 text-accent-dim">
                  <span className="w-14 shrink-0 border-r border-border" />
                  <span className="px-3 py-0.5">{line.text}</span>
                </div>
              );
            }
            if (line.kind === "meta") return null;
            const isAdd = line.kind === "add";
            const isRemove = line.kind === "remove";
            const oldCell = isAdd ? "" : String(oldNo);
            const newCell = isRemove ? "" : String(newNo);
            if (!isAdd) oldNo += 1;
            if (!isRemove) newNo += 1;
            return (
              <div key={i} className={`flex ${isAdd ? "bg-diff-add" : isRemove ? "bg-diff-remove" : ""}`}>
                <span className="flex w-14 shrink-0 select-none justify-end gap-1.5 border-r border-border px-1.5 py-0.5 text-[10px] text-content-faint">
                  <span className="w-5 text-right">{oldCell}</span>
                  <span className="w-5 text-right">{newCell}</span>
                </span>
                <span className={`flex-1 whitespace-pre px-3 py-0.5 ${isAdd ? "text-diff-addText" : isRemove ? "text-diff-removeText" : "text-content-secondary"}`}>
                  <span className="mr-2 select-none opacity-60">{isAdd ? "+" : isRemove ? "−" : " "}</span>
                  {line.text || " "}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Tool / command cards ─────────────────────────────────────────────

function StatusDot({ status }: { status?: string }) {
  const color =
    status === "completed"
      ? "bg-success"
      : status === "failed"
        ? "bg-danger"
        : status === "running"
          ? "bg-accent animate-pulse-dot"
          : "bg-content-faint";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

function ToolCard({ item }: { item: AgentTimelineItem }) {
  const tool = item.toolCall;
  const cmd = item.commandExecution;
  const status = cmd?.status ?? tool?.status;
  const hasBody = Boolean(cmd?.output || tool?.input || tool?.output);
  // Default collapsed once finished; expanded while running (or on failure).
  const [expanded, setExpanded] = useState(status === "running" || status === "failed");

  const headerLabel = cmd
    ? `$ ${cmd.command ?? "命令"}`
    : tool?.name ?? "工具调用";

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <button
        onClick={() => hasBody && setExpanded((v) => !v)}
        className={`flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors ${
          hasBody ? "cursor-pointer hover:bg-surface-overlay" : "cursor-default"
        } ${cmd ? "border-b border-border bg-surface-raised" : ""}`}
      >
        {hasBody ? (
          expanded ? (
            <IconChevronDown size={12} className="shrink-0 text-content-faint" />
          ) : (
            <IconChevronRight size={12} className="shrink-0 text-content-faint" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <StatusDot status={status} />
        {!cmd && <IconWrench size={12} className="shrink-0 text-content-faint" />}
        <span className="truncate font-mono text-[13px] text-content-secondary">{headerLabel}</span>
        {cmd && typeof cmd.exitCode === "number" && (
          <span className={`ml-auto shrink-0 font-mono text-[13px] ${cmd.exitCode === 0 ? "text-success" : "text-danger"}`}>
            exit {cmd.exitCode}
          </span>
        )}
      </button>
      {expanded && hasBody && (
        <div className={cmd ? "" : "px-3.5 pb-3 pt-2"}>
          {cmd?.output && (
            <div className="group/out relative">
              <pre className="max-h-72 overflow-auto px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-content-secondary">
                {cmd.output}
              </pre>
              <CopyButton
                text={cmd.output}
                className="absolute right-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border bg-surface text-content-muted opacity-0 transition-opacity hover:text-content-primary group-hover/out:opacity-100"
              />
            </div>
          )}
          {tool?.input && (
            <pre className="max-h-40 overflow-auto rounded-lg bg-surface-raised px-3 py-2 font-mono text-[13px] text-content-faint">
              {tool.input}
            </pre>
          )}
          {tool?.output && (
            <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-surface-raised px-3 py-2 font-mono text-[13px] text-content-secondary">
              {tool.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Permission request ───────────────────────────────────────────────

function PermissionCard({
  item,
  onRespond,
}: {
  item: AgentTimelineItem;
  onRespond: (requestId: string, outcome: "allow" | "deny", optionId?: string) => void;
}) {
  // Local click state disables the buttons INSTANTLY, without waiting for the
  // store round-trip (which was one render behind — the "needs two clicks" bug).
  const [clicked, setClicked] = useState(false);
  const perm = item.permission;
  if (!perm) return null;
  const pending = clicked || item.metadata?.permissionPending === true;
  const options = perm.options.length > 0 ? perm.options : [
    { id: "deny", label: "拒绝", kind: "deny" as const },
    { id: "allow_once", label: "允许一次", kind: "allow" as const },
  ];
  const respond = (outcome: "allow" | "deny", optionId: string) => {
    if (pending) return;
    setClicked(true);
    onRespond(perm.requestId, outcome, optionId);
  };
  return (
    <div className="rounded-xl border border-warning/40 bg-surface p-4">
      <p className="text-sm font-medium text-warning">需要授权</p>
      {perm.context && <p className="mt-1.5 text-sm text-content-secondary">{perm.context}</p>}
      {perm.toolName && (
        <p className="mt-1.5 font-mono text-[13px] text-content-faint">{perm.toolName}</p>
      )}
      {perm.toolInput && (
        <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-surface-raised px-3 py-2 font-mono text-[13px] text-content-faint">
          {perm.toolInput}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt.id}
            disabled={pending}
            onClick={() => respond(opt.kind === "allow" ? "allow" : "deny", opt.id)}
            className={
              opt.kind === "allow"
                ? "codex-btn-primary text-xs"
                : "codex-btn-outline text-xs border-danger/40 text-danger hover:border-danger hover:bg-danger/10 hover:text-danger"
            }
          >
            {opt.label}
          </button>
        ))}
      </div>
      {pending && <p className="mt-2 text-xs text-content-muted">已发送…</p>}
    </div>
  );
}

// ── Plan ─────────────────────────────────────────────────────────────

function PlanCard({ item }: { item: AgentTimelineItem }) {
  if (!item.plan?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-content-faint">计划</p>
      <ul className="space-y-1.5">
        {item.plan.map((step) => (
          <li key={step.id} className="flex items-start gap-2 text-sm leading-6">
            <span className="mt-1 shrink-0">
              {step.status === "completed" ? (
                <IconCheck size={12} className="text-success" />
              ) : step.status === "in_progress" ? (
                <span className="block h-2.5 w-2.5 animate-pulse-dot rounded-full bg-accent" />
              ) : (
                <span className="block h-2.5 w-2.5 rounded-full border border-content-faint" />
              )}
            </span>
            {/* Plan text can be Markdown (esp. Codex plan-mode, which sends a
                full ## / `code` document), so render it instead of dumping the
                raw source with visible #/backticks. */}
            <div
              className={`min-w-0 flex-1 ${
                step.status === "completed" ? "text-content-muted line-through" : "text-content-secondary"
              }`}
            >
              <Markdown text={step.text} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Structured input (e.g. AskUserQuestion) ─────────────────────────

function StructuredInputCard({
  item,
  onSubmit,
}: {
  item: AgentTimelineItem;
  onSubmit: (requestId: string, answers: Record<string, string[]>) => void;
}) {
  const si = item.structuredInput;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  if (!si) return null;
  const submitting = item.metadata?.inputSubmitting === true;
  const submitted = item.metadata?.inputSubmitted === true;
  const error = typeof item.metadata?.inputError === "string" ? item.metadata.inputError : undefined;

  const toggleOption = (qId: string, optId: string, limit: number | undefined) => {
    setAnswers((prev) => {
      const cur = prev[qId] ?? [];
      if (cur.includes(optId)) return { ...prev, [qId]: cur.filter((x) => x !== optId) };
      if (limit === 1) return { ...prev, [qId]: [optId] };
      const next = [...cur, optId];
      return { ...prev, [qId]: limit ? next.slice(-limit) : next };
    });
  };

  const setFreeText = (qId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [qId]: value ? [value] : [] }));
  };

  const canSubmit = si.questions.every((q) => (answers[q.id]?.length ?? 0) > 0);

  return (
    <div className="rounded-xl border border-accent-dim/40 bg-surface p-4">
      <p className="text-sm font-medium text-accent">需要你的输入</p>
      <div className="mt-3 space-y-4">
        {si.questions.map((q) => (
          <div key={q.id}>
            {q.header && (
              <p className="text-2xs font-semibold uppercase tracking-wider text-content-faint">{q.header}</p>
            )}
            <p className="mb-2 text-sm text-content-secondary">{q.question}</p>
            {q.options && q.options.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => {
                  const selected = (answers[q.id] ?? []).includes(opt.id);
                  return (
                    <button
                      key={opt.id}
                      disabled={submitted || submitting}
                      onClick={() => toggleOption(q.id, opt.id, q.selectionLimit)}
                      title={opt.description}
                      className={
                        selected
                          ? "codex-btn-primary text-xs"
                          : "codex-btn-outline text-xs"
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <input
                type={q.isSecret ? "password" : "text"}
                disabled={submitted || submitting}
                onChange={(e) => setFreeText(q.id, e.target.value)}
                className="codex-input text-sm"
                placeholder="输入答案…"
              />
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      <div className="mt-3">
        {submitted ? (
          <span className="text-xs text-content-muted">已提交</span>
        ) : (
          <button
            disabled={!canSubmit || submitting}
            onClick={() => onSubmit(si.requestId, answers)}
            className="codex-btn-primary text-xs"
          >
            {submitting ? "提交中…" : "提交"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Streaming indicator ──────────────────────────────────────────────

function StreamingPill() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-2xs text-accent">
      <span className="h-1 w-1 animate-pulse-dot rounded-full bg-accent" />
      正在生成
    </span>
  );
}

// Collapsible "thinking" block — expanded while streaming, collapsed once done.
function ThinkingBlock({ item }: { item: AgentTimelineItem }) {
  const [expanded, setExpanded] = useState(Boolean(item.isStreaming));
  return (
    <div className="rounded-xl border border-border bg-surface px-3.5 py-2.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left text-xs text-content-muted transition-colors hover:text-content-secondary"
      >
        {expanded ? (
          <IconChevronDown size={11} className="shrink-0 text-content-faint" />
        ) : (
          <IconChevronRight size={11} className="shrink-0 text-content-faint" />
        )}
        <span>思考过程</span>
        {item.isStreaming && <StreamingPill />}
      </button>
      {expanded && item.text && (
        <p className="mt-2 whitespace-pre-wrap break-words pl-4 text-sm italic leading-relaxed text-content-muted">
          {item.text}
        </p>
      )}
    </div>
  );
}

// ── Context-compaction / review note ────────────────────────────────
// Lightweight system notes the agent emits between turns: a context window
// compaction, or a self-review pass. Rendered as a slim labelled divider so
// they read as ambient status rather than chat content (mobile parity).

function SystemNoteBlock({ item, label }: { item: AgentTimelineItem; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = item.text != null && item.text.trim() !== "";
  return (
    <div className="flex items-center gap-2 py-0.5 text-2xs text-content-faint">
      <span className="h-px flex-1 bg-border" />
      <button
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 ${
          hasDetail ? "cursor-pointer transition-colors hover:text-content-secondary" : "cursor-default"
        }`}
        title={hasDetail ? (expanded ? "收起" : "展开") : undefined}
      >
        <span className="font-medium">{label}</span>
        {item.isStreaming && <StreamingPill />}
        {hasDetail &&
          (expanded ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />)}
      </button>
      <span className="h-px flex-1 bg-border" />
      {expanded && hasDetail && (
        <p className="basis-full whitespace-pre-wrap break-words pt-1.5 text-xs italic leading-relaxed text-content-muted">
          {item.text}
        </p>
      )}
    </div>
  );
}

// ── Subagent activity card ──────────────────────────────────────────
// Codex/Claude can spawn parallel sub-agents; item.subagent carries the fan-out
// (tool verb, receiver threads, per-agent status). Render as a roster card.

function subagentTitle(sa: NonNullable<AgentTimelineItem["subagent"]>): string {
  const count = Math.max(1, sa.receiverThreadIds.length, sa.receiverAgents.length);
  const t = (sa.tool || "").toLowerCase();
  if (t.includes("spawn")) return `启动 ${count} 个子 Agent`;
  if (t.includes("wait")) return `等待 ${count} 个子 Agent`;
  if (t.includes("resume")) return `恢复 ${count} 个子 Agent`;
  if (t.includes("close")) return `关闭 ${count} 个子 Agent`;
  if (t.includes("sendinput") || t.includes("send_input")) return `更新 ${count} 个子 Agent`;
  return count === 1 ? "子 Agent 活动" : `${count} 个子 Agent 活动`;
}

function subagentStatusLabel(status?: string): string {
  const t = (status || "").toLowerCase().replace(/[\s_-]/g, "");
  if (t === "completed" || t === "done" || t === "success") return "完成";
  if (t === "failed" || t === "error") return "失败";
  if (t === "stopped" || t === "cancelled") return "已停止";
  if (t === "queued" || t === "pending") return "排队中";
  if (t === "running" || t === "inprogress") return "运行中";
  return status || "未知";
}

function SubagentCard({ item, onOpenAgent }: { item: AgentTimelineItem; onOpenAgent?: (detail: SubagentDetail) => void }) {
  const sa = item.subagent!;
  const [expanded, setExpanded] = useState(true);
  const rows = [
    ...new Set(
      sa.receiverThreadIds.length > 0
        ? sa.receiverThreadIds
        : sa.receiverAgents.map((a) => a.threadId),
    ),
  ];
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 text-left"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
          <IconUsers size={13} />
        </span>
        <span className="flex-1 truncate text-sm font-medium text-content-primary">
          {subagentTitle(sa)}
        </span>
        {item.isStreaming && <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" />}
        {expanded ? (
          <IconChevronDown size={13} className="shrink-0 text-content-faint" />
        ) : (
          <IconChevronRight size={13} className="shrink-0 text-content-faint" />
        )}
      </button>
      {sa.prompt && (
        <p className={`mt-2 text-xs leading-relaxed text-content-muted ${expanded ? "" : "line-clamp-1"}`}>
          {sa.prompt}
        </p>
      )}
      {expanded && rows.length > 0 && (
        <div className="mt-2.5 space-y-0.5">
          {rows.map((threadId) => {
            const agent = sa.receiverAgents.find((a) => a.threadId === threadId);
            const state = sa.agentStates[threadId];
            const status = subagentStatusLabel(state?.status ?? sa.status);
            const name =
              agent?.nickname && agent?.role
                ? `${agent.nickname} [${agent.role}]`
                : agent?.nickname || agent?.role || (threadId.length > 14 ? `Agent ${threadId.slice(-8)}` : threadId || "Agent");
            const dot =
              status === "失败" ? "bg-danger" : status === "完成" ? "bg-success" : "bg-accent";
            return (
              <button
                key={threadId}
                onClick={() =>
                  onOpenAgent?.({
                    threadId,
                    name,
                    role: agent?.role,
                    model: agent?.model,
                    prompt: agent?.prompt ?? sa.prompt,
                    status,
                    message: state?.message,
                    tool: sa.tool,
                  })
                }
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface-overlay"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-content-secondary">{name}</span>
                {agent?.model && (
                  <span className="shrink-0 font-mono text-2xs text-content-faint">{agent.model}</span>
                )}
                <span className="shrink-0 text-2xs font-medium text-content-muted">{status}</span>
                <IconChevronRight size={12} className="shrink-0 text-content-faint" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Detail extracted when a sub-agent row is clicked — drives the right drawer.
export interface SubagentDetail {
  threadId: string;
  name: string;
  role?: string;
  model?: string;
  prompt?: string;
  status: string;
  message?: string;
  tool?: string;
}

/** Read-only sub-agent detail panel (right drawer). The protocol exposes no
 *  per-subagent transcript, so this shows every field the host does send:
 *  identity, delegated prompt, status, and any status message. */
export function SubagentDetailView({ detail }: { detail: SubagentDetail }) {
  const dot =
    detail.status === "失败" ? "bg-danger" : detail.status === "完成" ? "bg-success" : "bg-accent";
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface">
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <IconUsers size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-content-primary">{detail.name}</p>
            <p className="truncate font-mono text-2xs text-content-faint">{detail.threadId}</p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-content-secondary">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            {detail.status}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {detail.role && <span className="codex-chip">{detail.role}</span>}
          {detail.model && <span className="codex-chip">{detail.model}</span>}
          {detail.tool && <span className="codex-chip">{detail.tool}</span>}
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {detail.prompt && (
          <section>
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-content-faint">委派指令</p>
            <div className="rounded-xl border border-border bg-surface-raised p-3 text-[13px] leading-relaxed text-content-secondary whitespace-pre-wrap">
              {detail.prompt}
            </div>
          </section>
        )}
        {detail.message && (
          <section>
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-content-faint">状态消息</p>
            <div className="rounded-xl border border-border bg-surface-raised p-3 text-[13px] leading-relaxed text-content-secondary whitespace-pre-wrap">
              {detail.message}
            </div>
          </section>
        )}
        <p className="pt-2 text-2xs leading-relaxed text-content-faint">
          子 Agent 由主 Agent 内部派生，其完整对话记录不经网关透出，因此此处仅展示主 Agent 报告的状态信息。
        </p>
      </div>
    </div>
  );
}

// ── Turn activity rollup (Codex-style) ──────────────────────────────
// While a turn runs, its tool/command/file/thinking activity shows inline.
// Once the turn ends, the run collapses into a one-line summary that can be
// expanded again. Grouping happens at the list level (see groupTimeline).

const ACTIVITY_KINDS = new Set([
  "tool_activity",
  "command_execution",
  "file_change",
  "subagent_action",
  "thinking",
]);

export function isActivityItem(item: AgentTimelineItem): boolean {
  if (item.kind && ACTIVITY_KINDS.has(item.kind)) return true;
  if (item.fileChange || item.commandExecution || item.toolCall || item.subagent) return true;
  if (item.type === "tool_call") return true;
  return false;
}

/** A still-pending queued user message (shown floating above the composer,
 *  Codex-style, NOT inline in the transcript). */
export function isQueuedItem(item: AgentTimelineItem): boolean {
  return (
    item.role === "user" &&
    item.metadata?.delivery === "queued" &&
    item.metadata?.queuedSent !== true &&
    item.metadata?.queuedDiscarded !== true
  );
}

/** Floating stack of queued messages, rendered just above the composer. */
export function QueuedMessages({
  items,
  canSteer,
  onSend,
  onSteer,
  onDiscard,
}: {
  items: AgentTimelineItem[];
  canSteer?: boolean;
  onSend: (itemId: string) => void;
  onSteer: (itemId: string) => void;
  onDiscard: (itemId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {items.map((item) => (
        <div
          key={item.id}
          className="group flex animate-slide-in items-center gap-2 rounded-xl border border-border bg-surface-raised px-3.5 py-2.5 shadow-sm"
        >
          <span className="shrink-0 rounded-full bg-surface-overlay px-2 py-0.5 text-2xs font-medium text-content-muted">
            已排队
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-content-secondary">{item.text}</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => onSend(item.id)}
              className="cursor-pointer rounded-md px-2 py-1 text-2xs text-content-muted transition-colors hover:bg-surface-overlay hover:text-accent"
              title="立即发送"
            >
              立即发送
            </button>
            {canSteer && (
              <button
                onClick={() => onSteer(item.id)}
                className="cursor-pointer rounded-md px-2 py-1 text-2xs text-content-muted transition-colors hover:bg-surface-overlay hover:text-accent"
                title="引导当前轮"
              >
                引导
              </button>
            )}
            <button
              onClick={() => onDiscard(item.id)}
              className="cursor-pointer rounded-md p-1 text-content-faint transition-colors hover:text-danger"
              title="丢弃"
              aria-label="丢弃排队消息"
            >
              <IconClose size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function renderActivity(
  item: AgentTimelineItem,
  onOpenDiff?: (item: AgentTimelineItem) => void,
  onOpenAgent?: (detail: SubagentDetail) => void,
): ReactNode {
  if (item.kind === "thinking") return <ThinkingBlock item={item} />;
  if (item.kind === "subagent_action" || item.subagent) return <SubagentCard item={item} onOpenAgent={onOpenAgent} />;
  if (item.kind === "file_change" || item.fileChange) {
    return <DiffCard item={item} onOpen={onOpenDiff} />;
  }
  return <ToolCard item={item} />;
}

export function TurnActivityGroup({
  items,
  live,
  onOpenDiff,
  onOpenAgent,
}: {
  items: AgentTimelineItem[];
  live: boolean;
  onOpenDiff?: (item: AgentTimelineItem) => void;
  onOpenAgent?: (detail: SubagentDetail) => void;
}) {
  const [open, setOpen] = useState(false);

  // While the turn is live, show every activity inline (it's happening now).
  if (live) {
    return (
      <div className="space-y-2">
        {items.map((it) => (
          <div key={it.id}>{renderActivity(it, onOpenDiff, onOpenAgent)}</div>
        ))}
      </div>
    );
  }

  // Completed turn → compact summary, click to expand.
  const files = items.filter((i) => i.kind === "file_change" || i.fileChange).length;
  const cmds = items.filter((i) => i.kind === "command_execution" || i.commandExecution).length;
  const tools = items.filter((i) => (i.toolCall || i.type === "tool_call") && !i.subagent).length;
  const subs = items.filter((i) => i.kind === "subagent_action" || i.subagent).length;
  const thinks = items.filter((i) => i.kind === "thinking").length;
  const parts: string[] = [];
  if (files) parts.push(`编辑 ${files} 个文件`);
  if (cmds) parts.push(`运行 ${cmds} 条命令`);
  if (tools) parts.push(`调用 ${tools} 个工具`);
  if (subs) parts.push(`${subs} 次子 Agent`);
  if (!files && !cmds && !tools && !subs && thinks) parts.push("思考");
  const summary = parts.join(" · ") || `${items.length} 项活动`;

  if (open) {
    return (
      <div className="rounded-xl border border-border bg-surface p-2">
        <button
          onClick={() => setOpen(false)}
          className="mb-2 flex w-full cursor-pointer items-center gap-1.5 px-1.5 text-left text-xs text-content-muted transition-colors hover:text-content-secondary"
        >
          <IconChevronDown size={12} className="shrink-0 text-content-faint" />
          <span>{summary}</span>
        </button>
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id}>{renderActivity(it, onOpenDiff, onOpenAgent)}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setOpen(true)}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-2 text-left text-xs text-content-muted transition-colors hover:border-border-strong hover:text-content-secondary"
    >
      <IconChevronRight size={12} className="shrink-0 text-content-faint" />
      <span>{summary}</span>
      <span className="ml-auto text-content-faint">展开</span>
    </button>
  );
}

// ── The dispatcher ───────────────────────────────────────────────────

export interface TimelineItemProps {
  item: AgentTimelineItem;
  canSteer?: boolean;
  onPermission: (requestId: string, outcome: "allow" | "deny", optionId?: string) => void;
  onStructuredInput: (requestId: string, answers: Record<string, string[]>) => void;
  onSendQueued?: (itemId: string) => void;
  onSteerQueued?: (itemId: string) => void;
  onDiscardQueued?: (itemId: string) => void;
  onOpenDiff?: (item: AgentTimelineItem) => void;
  onOpenAgent?: (detail: SubagentDetail) => void;
  /** Edit & resend a prior user message (loads its text into the composer). */
  onEditMessage?: (text: string) => void;
  /** Active search query — message text highlights matches when set. */
  highlightQuery?: string;
}

export const TimelineItemView = memo(
  function TimelineItemView({
    item,
    canSteer,
    onPermission,
    onStructuredInput,
    onSendQueued,
    onSteerQueued,
    onDiscardQueued,
    onOpenDiff,
    onOpenAgent,
    onEditMessage,
    highlightQuery,
  }: TimelineItemProps) {
    // structured input (e.g. AskUserQuestion)
    if (item.kind === "user_input_prompt" || item.structuredInput) {
      return <StructuredInputCard item={item} onSubmit={onStructuredInput} />;
    }
    // subagent fan-out
    if (item.kind === "subagent_action" || item.subagent) {
      return <SubagentCard item={item} onOpenAgent={onOpenAgent} />;
    }
    // file change
    if (item.kind === "file_change" || item.fileChange) {
      return <DiffCard item={item} onOpen={onOpenDiff} />;
    }
    // command / tool
    if (item.kind === "command_execution" || item.commandExecution || item.type === "tool_call" || item.toolCall) {
      return <ToolCard item={item} />;
    }
    // permission
    if (item.type === "permission" || item.permission) {
      return <PermissionCard item={item} onRespond={onPermission} />;
    }
    // plan
    if (item.type === "plan" || item.plan) {
      return <PlanCard item={item} />;
    }
    // error
    if (item.type === "error" || item.error) {
      return (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-surface px-3.5 py-2.5 text-sm text-danger">
          <span className="mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          <span>{item.error ?? "发生错误"}</span>
        </div>
      );
    }
    // thinking
    if (item.kind === "thinking") {
      return <ThinkingBlock item={item} />;
    }
    // context compaction / review — ambient system notes
    if (item.kind === "context_compaction") {
      return <SystemNoteBlock item={item} label="上下文压缩" />;
    }
    if (item.kind === "review") {
      return <SystemNoteBlock item={item} label="审查" />;
    }
    // message (user / assistant / system)
    const isUser = item.role === "user";
    const discarded = item.metadata?.queuedDiscarded === true;
    const hasText = item.text != null && item.text !== "";

    return (
      <div className={isUser ? "group flex flex-col items-end" : "group min-w-0"}>
        <div
          className={
            isUser
              ? `max-w-[85%] break-words rounded-2xl px-4 py-2.5 text-[15px] leading-7 ${
                  discarded
                    ? "bg-surface-raised text-content-secondary line-through opacity-50"
                    : "bg-surface-raised text-content-primary"
                }`
              : "w-full min-w-0"
          }
        >
          {/* Image blocks from content (text-only path missed these before). */}
          {Array.isArray(item.content) &&
            item.content.some((b) => b.type === "image") && (
              <div className="mb-1.5 flex flex-wrap gap-2">
                {item.content
                  .filter((b) => b.type === "image" && b.data)
                  .map((b, i) => (
                    <img
                      key={i}
                      src={b.data}
                      alt="附件"
                      className="max-h-48 rounded-lg border border-border object-contain"
                    />
                  ))}
              </div>
            )}
          {hasText && <Markdown text={item.text!} highlight={highlightQuery} />}
          {item.isStreaming && <StreamingPill />}
        </div>
        {discarded && <span className="mt-1 text-2xs text-content-faint">已丢弃</span>}
        {/* Hover actions: copy (both roles), edit & resend (user only). Hidden
            while streaming or for discarded items. */}
        {hasText && !item.isStreaming && !discarded && (
          <div
            className={`mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 ${
              isUser ? "justify-end" : ""
            }`}
          >
            {isUser && onEditMessage && (
              <button
                onClick={() => onEditMessage(item.text!)}
                title="编辑并重新发送"
                aria-label="编辑并重新发送"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border bg-surface text-content-muted transition-colors hover:text-content-primary"
              >
                <IconPencil size={13} />
              </button>
            )}
            <CopyButton text={item.text!} />
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.item === next.item &&
    prev.canSteer === next.canSteer &&
    prev.onPermission === next.onPermission &&
    prev.onStructuredInput === next.onStructuredInput &&
    prev.onSendQueued === next.onSendQueued &&
    prev.onSteerQueued === next.onSteerQueued &&
    prev.onDiscardQueued === next.onDiscardQueued &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenAgent === next.onOpenAgent &&
    prev.onEditMessage === next.onEditMessage &&
    prev.highlightQuery === next.highlightQuery,
);
