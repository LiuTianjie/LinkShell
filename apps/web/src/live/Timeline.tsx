import { AsyncQuestions } from "./AsyncQuestions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Download, X } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, CircleAlert, CircleDashed, CircleHelp, Copy, GitFork, LoaderCircle } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import { markdownBlocks, useSmoothText } from "./smooth-text";
import { diffLines, diffStat, hunks, parsePatch, type DiffLine } from "./line-diff";
import { isDesktop } from "./desktop";
import { grammarForPath, useHighlight, type HighlightToken } from "./highlight";
import { fileTarget } from "./file-target";
import { messageTime } from "./session-time";
import remarkGfm from "remark-gfm";
import type { ContentBlock, ToolCallContent, UserContext } from "@linkshell/wire";
import {
  answeredQuestions,
  askedQuestions,
  compactionLabel,
  describeFailures,
  describeSteps,
  exitNote,
  foldStepRuns,
  formatElapsed,
  isQuietTool,
  presentError,
  proposedPlan,
  reconnectLabel,
  reconnectOf,
  startedSession,
  toolCommand,
  toolLabel,
  toolLabelParts,
  toolLabelText,
  toolOutput,
  wrapUpOf,
  inboxLabel,
  questionReplies,
  tallySteps,
  userEventLabel,
  userMessageView,
  type Step,
  type TimelineItem,
} from "@linkshell/client-core";
import { ChevronRight, ClipboardPaste, FileText, GitMerge, GitPullRequest, Globe, Highlighter, History, Image as ImageIcon, Layers, MessageSquareText, Paperclip, SearchCheck, TextSelect, type LucideIcon } from "lucide-react";
import {
  AgentMark,
  ErrorNotice,
  useActions,
  useConnection,
  useSessionOnline,
  useJob,
} from "./common";


/**
 * Lines added and removed, each only when there are some: a "−0" in red reads as an error, and a
 * file that only gained lines says "+38". Nothing at all when nothing changed.
 */
export function DiffStat({ added, removed, className = "diff-stat" }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null;
  return (
    <span className={className}>
      {added > 0 && <span className="diff-add">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="diff-del">−{removed}</span>}
    </span>
  );
}

/** A folded run of finished steps — "已编辑 2 个文件，已运行 5 个命令", one click open. */
export function StepsSummary({
  steps,
  open,
  onToggle,
}: {
  steps: Step[];
  open: boolean;
  onToggle: () => void;
}) {
  const t = tallySteps(steps);
  const label = describeSteps(t);
  const failures = describeFailures(t);
  return (
    <button
      type="button"
      className="steps-summary"
      aria-expanded={open}
      onClick={onToggle}
    >
      <Layers className="steps-summary-icon" aria-hidden="true" />
      <span className="steps-summary-label">{label}</span>
      {failures && <span className="steps-summary-failed">{failures}</span>}
      <DiffStat added={t.added} removed={t.removed} className="steps-summary-diff" />
      <ChevronRight className="steps-summary-chevron" aria-hidden="true" />
    </button>
  );
}

function CopyText({
  text,
  label = "复制消息",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const job = useJob();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="message-copy">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={job.busy}
        aria-label={copied ? "已复制" : label}
        title={copied ? "已复制" : label}
        onClick={() =>
          void job.run(async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          })
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      {job.error && (
        <span className="form-error" role="alert">
          复制失败，请选中文本复制。
        </span>
      )}
    </span>
  );
}

export const TimelineNavigation = createContext<{
  cwd: string;
  open: (path: string, line?: number) => void;
  /** Opens an MCP App call's page in the inspector (Codex sessions on the desktop). */
  openApp?: (callId: string) => void;
  /** The session the agent's app knows by `appId` (the Claude app's `local_…`), when this computer has it. */
  findSession?: (appId: string) => { title: string; open: () => void } | undefined;
} | null>(null);

/** The end-of-turn box whose buttons still answer (see `openWrapUp`); the conversation sets it. */
export const OpenWrapUp = createContext<string | undefined>(undefined);

/** Whether code blocks below may be highlighted: off for the block of a reply still streaming. */
const HighlightCode = createContext(true);

/** The text of a node react-markdown made: strings, possibly nested in elements. */
function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

/** Highlighted lines, joined as the source was so copying and selecting give back the same text. */
export function TokenLines({ tokens }: { tokens: HighlightToken[][] }) {
  return tokens.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && "\n"}
      {line.map((token, at) => (token.color ? <span key={at} style={{ color: token.color }}>{token.content}</span> : token.content))}
    </Fragment>
  ));
}

function CodeBlock({ children }: { children: ReactNode }) {
  const element = Children.toArray(children).find(isValidElement);
  const className = element && (element.props as { className?: string }).className;
  const language = className?.match(/language-([\w+-]+)/)?.[1];
  const source = useMemo(() => nodeText(element).replace(/\n$/, ""), [element]);
  const tokens = useHighlight(source, language, useContext(HighlightCode));
  const code = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const job = useJob();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="code-surface">
      <div className="code-toolbar">
        <span>{language ?? "代码"}</span>
        <Button
          variant="ghost"
          size={isDesktop ? "icon-sm" : "sm"}
          className="code-copy"
          disabled={job.busy}
          aria-label={copied ? "代码已复制" : "复制代码"}
          title={copied ? "已复制" : "复制代码"}
          onClick={() =>
            void job.run(async () => {
              await navigator.clipboard.writeText(
                code.current?.textContent ?? "",
              );
              setCopied(true);
            })
          }
        >
          {copied ? (
            <Check data-icon="inline-start" />
          ) : (
            <Copy data-icon="inline-start" />
          )}
          {!isDesktop && (copied ? "已复制" : "复制")}
        </Button>
      </div>
      <pre
        ref={code}
        tabIndex={0}
        aria-label={language ? language + " 代码" : "代码"}
      >
        {tokens ? <code className={className} data-highlighted><TokenLines tokens={tokens} /></code> : children}
      </pre>
      <ErrorNotice
        error={job.error ? "无法访问剪贴板，请选中代码后复制。" : undefined}
      />
    </div>
  );
}
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const navigation = useContext(TimelineNavigation);
  const target = href && fileTarget(href, navigation?.cwd);
  return (
    <a
      href={href}
      target={target ? undefined : "_blank"}
      rel="noreferrer"
      onClick={(event) => {
        if (target && navigation) {
          event.preventDefault();
          navigation.open(target.path, target.line);
        }
      }}
    >
      {children}
    </a>
  );
}

// Stable, so a block whose text didn't change is not parsed again when its message re-renders.
const markdownPlugins = [remarkGfm];
const markdownURL = (url: string) => (url.startsWith("file://") ? url : defaultUrlTransform(url));
const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer">
      {alt || "查看图片"} ↗
    </a>
  ),
};

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={markdownPlugins} urlTransform={markdownURL} components={markdownComponents}>
      {text}
    </Markdown>
  );
});

export function RichText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <MarkdownBlock text={text} />
    </div>
  );
}

/**
 * A reply as it streams: released smoothly (useSmoothText), and parsed a block at a time so
 * only the block still growing is parsed again. A block fades in as it first appears.
 */
export function StreamingText({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothText(text, streaming);
  const blocks = useMemo(() => markdownBlocks(shown), [shown]);
  // What was already there when this mounted (history, a reopened session) doesn't fade in;
  // the fade is a CSS animation, so each new block plays it once, as it is created.
  const [present] = useState(() => (streaming ? markdownBlocks(text).length - 1 : Number.POSITIVE_INFINITY));
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        <div key={index} className="markdown-block" data-enter={index > present || undefined}>
          {/* The last block may still be growing: its code is coloured once the reply moves past it. */}
          <HighlightCode.Provider value={!streaming || index < blocks.length - 1}>
            <MarkdownBlock text={block} />
          </HighlightCode.Provider>
        </div>
      ))}
    </div>
  );
}
/** Click any `.message-image` to open it full-size in a centered lightbox.
    Keeps the download as a corner action rather than the default click. */
function ImageLightbox({
  uri,
  alt,
  download,
  onError,
}: {
  uri: string;
  alt: string;
  download?: string;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        className="message-image-trigger"
        aria-label="查看大图"
        onClick={() => setOpen(true)}
      >
        <img
          className="message-image"
          src={uri}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={onError}
        />
      </button>
      <DialogContent
        className="image-lightbox-content w-auto max-w-[92vw] gap-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-[92vw]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img
          className="image-lightbox-image"
          src={uri}
          alt={alt}
          referrerPolicy="no-referrer"
        />
        <div className="image-lightbox-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            title="下载原图"
            aria-label="下载原图"
          >
            <a
              href={uri}
              download={download ?? (uri.startsWith("data:") ? "image" : undefined)}
              target="_blank"
              rel="noreferrer"
            >
              <Download />
            </a>
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="关闭">
              <X />
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Picture({
  block,
  sessionId,
}: {
  block: Extract<ContentBlock, { type: "image" }>;
  sessionId: string;
}) {
  const actions = useActions();
  const [uri, setUri] = useState(
    block.data
      ? `data:${block.mimeType};base64,${block.data}`
      : block.uri && /^(data:image\/|https?:\/\/)/.test(block.uri)
        ? block.uri
        : undefined,
  );
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const loadImage = actions.loadImage;
  useEffect(() => {
    let alive = true;
    setError(undefined);
    setUri(
      block.data
        ? `data:${block.mimeType};base64,${block.data}`
        : block.uri && /^(data:image\/|https?:\/\/)/.test(block.uri)
          ? block.uri
          : undefined,
    );
    if (block.uri?.startsWith("linkshell-event:"))
      void loadImage(sessionId, block.uri).then(
        (value) => {
          if (alive) setUri(value);
        },
        () => {
          if (alive) setError("图片加载失败");
        },
      );
    return () => {
      alive = false;
    };
  }, [loadImage, block.uri, block.data, block.mimeType, sessionId, attempt]);
  return uri ? (
    <ImageLightbox
      uri={uri}
      alt="会话图片"
      onError={() => {
        setUri(undefined);
        setError("图片加载失败");
      }}
    />
  ) : (
    <span className="message-asset-state" role="status">
      {error ?? "图片加载中…"}
      {error && (
        <Button
          variant="link"
          size="sm"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重试图片
        </Button>
      )}
    </span>
  );
}

function Asset({
  block,
  sessionId,
  download,
}: {
  block: { data?: string; uri?: string; mimeType: string };
  sessionId: string;
  download?: string;
}) {
  const { loadImage } = useActions();
  const [uri, setUri] = useState(
    block.data
      ? `data:${block.mimeType};base64,${block.data}`
      : block.uri?.startsWith("linkshell-event:")
        ? undefined
        : block.uri,
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    setError(undefined);
    setUri(
      block.data
        ? `data:${block.mimeType};base64,${block.data}`
        : block.uri?.startsWith("linkshell-event:")
          ? undefined
          : block.uri,
    );
    if (block.uri?.startsWith("linkshell-event:"))
      void loadImage(sessionId, block.uri).then(
        (value) => {
          if (alive) setUri(value);
        },
        () => {
          if (alive) setError("附件加载失败");
        },
      );
    return () => {
      alive = false;
    };
  }, [block.data, block.uri, block.mimeType, loadImage, sessionId]);
  if (!uri) return <span className="muted">{error ?? "附件加载中…"}</span>;
  if (!/^(data:|https?:\/\/)/.test(uri))
    return <span className="muted">附件地址无效</span>;
  return (
    <div className="protocol-asset">
      {block.mimeType.startsWith("audio/") ? (
        <audio controls preload="metadata" src={uri} />
      ) : block.mimeType.startsWith("image/") ? (
        <ImageLightbox uri={uri} alt={download ?? "附件"} download={download} />
      ) : null}
      <a className="resource-chip" href={uri} download={download ?? "audio"}>
        下载{download ? ` ${download}` : "音频"}
      </a>
    </div>
  );
}
export function Blocks({
  blocks,
  sessionId,
  onFile,
}: {
  blocks: ContentBlock[];
  sessionId: string;
  onFile: (path: string, line?: number) => void;
}) {
  return (
    <>
      {blocks.map((block, index) =>
        block.type === "text" ? (
          <RichText key={index} text={block.text} />
        ) : block.type === "image" ? (
          <Picture key={index} block={block} sessionId={sessionId} />
        ) : block.type === "audio" ? (
          <Asset key={index} block={block} sessionId={sessionId} />
        ) : block.type === "resource" ? (
          <details
            key={index}
            className="notice-card"
            open={!!block.resource.text && block.resource.text.length < 2000}
          >
            <summary>
              {block.resource.uri} · {block.resource.mimeType ?? "附件"}
            </summary>
            {block.resource.text !== undefined ? (
              <>
                <CopyText text={block.resource.text} label="复制附件文本" />
                <pre tabIndex={0}>{block.resource.text}</pre>
              </>
            ) : (
              <Asset
                block={{
                  data: block.resource.blob,
                  uri: block.resource.assetUri,
                  mimeType:
                    block.resource.mimeType ?? "application/octet-stream",
                }}
                sessionId={sessionId}
                download={block.resource.uri.split("/").at(-1)}
              />
            )}
          </details>
        ) : /^https?:\/\//.test(block.uri) ? (
          <a
            key={index}
            href={block.uri}
            target="_blank"
            rel="noreferrer"
            className="resource-chip"
          >
            {block.name} ↗
          </a>
        ) : (
          <Button
            variant="ghost"
            size="plain"
            key={index}
            className="resource-chip"
            onClick={() => onFile(block.uri.replace(/^file:\/\//, ""))}
          >
            {block.kind === "skill" ? "技能 · " : "文件 · "}
            {block.name}
          </Button>
        ),
      )}
    </>
  );
}
/** A change's lines, whatever form the agent reported it in (before and after, or a patch). */
export function changeLines(change: Extract<ToolCallContent, { type: "diff" | "patch" }>): DiffLine[] {
  return change.type === "diff" ? diffLines(change.oldText ?? "", change.newText) : parsePatch(change.diff);
}

/** A file's change as a unified diff: numbered lines, what went and what came tinted, the
    unchanged stretches between folded to a line. */
export function DiffView({ lines, path }: { lines: DiffLine[]; path?: string }) {
  const parts = useMemo(() => hunks(lines), [lines]);
  // Each side is highlighted as one text, so a line inside a string or comment that began
  // earlier is coloured as it is in the file; each line then takes its tokens from its side.
  const language = path ? grammarForPath(path) : undefined;
  const sides = useMemo(() => {
    const before: string[] = [], after: string[] = [];
    // Where each line sits in its side's text: removed lines in the old, the rest in the new.
    const at = lines.map((line) => {
      if (line.kind === "del") return before.push(line.text) - 1;
      if (line.kind === "same") before.push(line.text);
      return after.push(line.text) - 1;
    });
    return { before: before.join("\n"), after: after.join("\n"), at };
  }, [lines]);
  const oldTokens = useHighlight(sides.before, language);
  const newTokens = useHighlight(sides.after, language);
  const index = useMemo(() => new Map(lines.map((line, at) => [line, at])), [lines]);
  const tokensOf = (line: DiffLine) => {
    const tokens = line.kind === "del" ? oldTokens : newTokens;
    return tokens?.[sides.at[index.get(line)!]!];
  };
  return (
    <div className="diff-view" role="table" aria-label="差异">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part.skipped > 0 && <div className="diff-skip" role="row">{part.skipped} 行未改动</div>}
          {part.lines.map((line, at) => (
            <div key={at} className="diff-line" data-kind={line.kind} role="row">
              <span className="diff-number" aria-hidden>{line.old ?? ""}</span>
              <span className="diff-number" aria-hidden>{line.new ?? ""}</span>
              <span className="diff-sign" aria-hidden>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
              <code>{line.text ? <DiffCode text={line.text} tokens={tokensOf(line)} /> : " "}</code>
            </div>
          ))}
        </Fragment>
      ))}
      {!parts.length && <div className="diff-skip">没有内容变化</div>}
    </div>
  );
}

function DiffCode({ text, tokens }: { text: string; tokens?: HighlightToken[] }) {
  // Tokens that don't spell the line (a grammar that skipped a pattern) would show the wrong text.
  if (!tokens || tokens.map((token) => token.content).join("") !== text) return text;
  return tokens.map((token, at) => (token.color ? <span key={at} style={{ color: token.color }}>{token.content}</span> : token.content));
}

export function Diff({
  change,
}: {
  change: Extract<ToolCallContent, { type: "diff" | "patch" }>;
}) {
  // Inside the session's own directory the path reads from the project root; the full one is on hover.
  const cwd = useContext(TimelineNavigation)?.cwd;
  const shown = (path: string) =>
    cwd && path.startsWith(`${cwd.replace(/\/$/, "")}/`) ? path.slice(cwd.replace(/\/$/, "").length + 1) : path;
  const lines = useMemo(() => changeLines(change), [change]);
  const stat = diffStat(lines);
  const title = change.type === "patch" && change.movePath ? `${change.path} → ${change.movePath}` : change.path;
  return (
    <details className="diff-block" open>
      <summary title={title}>
        <span className="diff-path">
          {shown(change.path)}
          {change.type === "patch" && change.movePath ? ` → ${shown(change.movePath)}` : ""}
        </span>
        <DiffStat added={stat.added} removed={stat.removed} />
      </summary>
      <DiffView lines={lines} path={change.type === "patch" && change.movePath ? change.movePath : change.path} />
    </details>
  );
}
/** A user message, with a reply to async questions shown as each question and its answer. */
function UserBlocks({
  blocks,
  sessionId,
  onFile,
}: {
  blocks: ContentBlock[];
  sessionId: string;
  onFile: (path: string, line?: number) => void;
}) {
  // The words, not the envelope around them (reminders, Codex Desktop's file and browser context):
  // what came with them shows as chips above the bubble, pictures and files below the words.
  const view = userMessageView(blocks);
  const replies = questionReplies(view.text);
  if (replies)
    return (
      <>
        {replies.map((reply, index) => (
          <div className="question-reply" key={index}>
            <small>{reply.question}</small>
            <p>{reply.answer}</p>
          </div>
        ))}
      </>
    );
  const attached = blocks.filter((block) => block.type !== "text");
  return (
    <>
      {view.text && <RichText text={view.text} />}
      {attached.length > 0 && <Blocks blocks={attached} sessionId={sessionId} onFile={onFile} />}
    </>
  );
}

/** Past 20 lines (or a wall of text without breaks) a message folds, as in Codex. */
function longMessage(text: string): boolean {
  return text.length > 2400 || text.split("\n").length > 20;
}

const CONTEXT_ICONS: Record<UserContext["kind"], LucideIcon> = {
  file: FileText,
  image: ImageIcon,
  pasted: ClipboardPaste,
  selection: TextSelect,
  comments: MessageSquareText,
  checks: CircleAlert,
  annotations: Highlighter,
  browser: Globe,
  review: SearchCheck,
  "pull-request": GitPullRequest,
  merge: GitMerge,
  history: History,
  other: Paperclip,
};

/** What a client attached to the message (files, a selection, the browser it had open), as Codex shows it. */
function UserContextChips({ context }: { context: UserContext[] }) {
  return (
    <div className="user-context">
      {context.map((entry, index) => {
        const Icon = CONTEXT_ICONS[entry.kind];
        return (
          <span key={index} className="user-context-chip" title={entry.detail ? `${entry.label}\n${entry.detail}` : entry.label}>
            <Icon aria-hidden />
            <span>{entry.label}</span>
          </span>
        );
      })}
    </div>
  );
}

interface EntryProps {
  sessionId: string;
  agent: string;
  onFile: (path: string, line?: number) => void;
  onFork?: (id: string) => void;
  onTerminal?: (id: string) => void;
  showAsyncQuestions: boolean;
  /** The whole conversation's answered async questions (Codex Desktop), for dedup. */
  answered: ReadonlyMap<string, string>;
  /** The conversation's last item while its turn runs: a retry on it is still being tried. */
  live?: boolean;
}

/**
 * One timeline item. Memoized: a conversation re-renders only the item that
 * changed while a reply streams, not every message above it.
 */
export const TimelineEntry = memo(function TimelineEntry({
  item,
  sessionId,
  agent,
  onFile,
  onFork,
  onTerminal,
  showAsyncQuestions,
  answered,
  live = false,
}: EntryProps & { item: TimelineItem }) {
  const actions = useActions();
  const navigation = useContext(TimelineNavigation);
  // A long message folds to its first lines, as Codex folds one past 20.
  const [unfolded, setUnfolded] = useState(false);
  const job = useJob();
  const online = useSessionOnline();
  const entry = (() => {
    if (item.kind === "turn-end" || item.kind === "driver")
          return (
            <p className="timeline-divider" key={item.id}>
              {item.kind === "driver"
                ? `会话控制：${item.driver === "desktop" ? "电脑端" : item.driver === "remote" ? "远程端" : "空闲"}`
                : item.stopReason === "cancelled"
                  ? "本轮已停止"
                  : item.stopReason === "error"
                    ? "本轮执行失败"
                    : item.stopReason === "max_tokens"
                      ? "达到输出上限，回复被截断"
                      : item.stopReason === "max_turn_requests"
                        ? "达到本轮请求次数上限"
                        : item.stopReason === "refusal"
                          ? "Agent 拒绝了这个请求"
                          : item.stopReason === "unknown"
                            ? "本轮已结束，Agent 未提供明确原因"
                            : "本轮结束"}
            </p>
          );
        if (item.kind === "user" && item.agentMessages?.length)
          return (
            <article key={item.id} className="agent-message">
              {item.agentMessages.map((message, index) => {
                // Another session's message names it by the app's id: its title now, and a way there.
                const sender = message.sessionId ? navigation?.findSession?.(message.sessionId) : undefined;
                return (
                  <details key={`${message.sender}:${index}`}>
                    <summary>
                      <span className="message-label">{inboxLabel(message, sender?.title)}</span>
                      {message.summary ? ` · ${message.summary}` : ""}
                      {sender && (
                        <button
                          type="button"
                          className="agent-message-open"
                          onClick={(event) => {
                            event.preventDefault();
                            sender.open();
                          }}
                        >
                          打开会话
                        </button>
                      )}
                    </summary>
                    <RichText text={message.body || "当前空闲，等待后续任务。"} />
                  </details>
                );
              })}
            </article>
          );
        const said = item.kind === "user" ? userMessageView(item.blocks) : undefined;
        if (said?.event)
          return (
            <p className="timeline-event" key={item.id}>
              {userEventLabel(said.event)}
            </p>
          );
        if (said?.shell || said?.output !== undefined) {
          // A command run from the prompt (`!`), or what a local slash command printed: the
          // person's, so on their side, in the terminal's type.
          const output = said.shell ? [said.shell.stdout, said.shell.stderr].filter(Boolean).join("\n") : said.output;
          return (
            <article className="user-shell" key={item.id}>
              {said.shell?.command && (
                <code className="user-shell-command">
                  <span aria-hidden>!</span> {said.shell.command}
                </code>
              )}
              {output && <pre tabIndex={0} className="user-shell-output">{output}</pre>}
            </article>
          );
        }
        if (item.kind === "user")
          return (
            <article className="user-message" key={item.id}>
              {said && said.context.length > 0 && <UserContextChips context={said.context} />}
              {/* The words in their own box, so the desktop can hang the time and actions under
                  the bubble instead of inside it. */}
              <div className="user-bubble" data-folded={(said && longMessage(said.text) && !unfolded) || undefined}>
                <UserBlocks
                  blocks={item.blocks}
                  sessionId={sessionId}
                  onFile={onFile}
                />
              </div>
              {said && longMessage(said.text) && (
                <button type="button" className="user-fold" aria-expanded={unfolded} onClick={() => setUnfolded(!unfolded)}>
                  {unfolded ? "收起" : "显示更多"}
                </button>
              )}
              {item.failed && (
                <div className="failed-message-actions">
                  <span className="form-error">发送失败，草稿仍在</span>
                  <Button
                    variant="link"
                    size="sm"
                    disabled={!online || job.busy}
                    onClick={() => void job.run(() => actions.retry(item.id))}
                  >
                    重试
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    disabled={job.busy}
                    onClick={() => actions.discard(item.id)}
                  >
                    移除
                  </Button>
                </div>
              )}
              <div className="message-actions">
                <time
                  className="message-time"
                  dateTime={new Date(item.ts).toISOString()}
                  title={new Date(item.ts).toLocaleString()}
                >
                  {messageTime(item.ts)}
                  {item.pending ? " · 发送中" : ""}
                </time>
                {item.blocks.some(
                  (block) => block.type === "text" && block.text,
                ) && (
                  <CopyText
                    text={item.blocks
                      .filter((block) => block.type === "text")
                      .map((block) => block.text)
                      .join("\n\n")}
                  />
                )}
                {onFork && !item.pending && !item.failed && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="message-fork"
                    disabled={!online}
                    aria-label="从这里分叉"
                    title="从这里分叉"
                    onClick={() => onFork(item.id)}
                  >
                    <GitFork />
                  </Button>
                )}
              </div>
            </article>
          );
        if (item.kind === "agent")
          return (
            <article className="assistant-message" key={item.id}>
              {item.senderSessionId || item.recipientSessionId ? (
                <small className="muted">
                  {item.senderSessionId ?? "Agent"} →{" "}
                  {item.recipientSessionId ?? "当前会话"}
                </small>
              ) : null}
              {item.streaming && (
                <div className="message-author" role="status">
                  <AgentMark agent={agent} />
                  <span>{online ? "正在回复…" : "等待会话恢复…"}</span>
                </div>
              )}
              <StreamingText text={item.text} streaming={item.streaming} />
              {showAsyncQuestions && item.questions && !item.streaming && (
                <AsyncQuestions
                  questions={item.questions}
                  answered={answered}
                  sessionId={sessionId}
                />
              )}
              {item.attachments && (
                <Blocks
                  blocks={item.attachments}
                  sessionId={sessionId}
                  onFile={onFile}
                />
              )}
              {!item.streaming && (
                <div className="message-actions">
                  {item.text && <CopyText text={item.text} />}
                  {onFork && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="message-fork"
                      disabled={!online}
                      aria-label="从这里分叉"
                      title="从这里分叉"
                      onClick={() => onFork(item.id)}
                    >
                      <GitFork />
                    </Button>
                  )}
                </div>
              )}
            </article>
          );
        if (item.kind === "thought")
          return (
            <details className="thought-block" key={item.id}>
              <summary>{item.streaming ? "思考中…" : item.endedTs && item.endedTs - item.ts >= 1000 ? `思考了 ${formatElapsed(item.endedTs - item.ts)}` : "思考过程"}</summary>
              <StreamingText text={item.text} streaming={item.streaming} />
            </details>
          );
        if (item.kind === "error") return <ErrorCard key={item.id} item={item} />;
        if (item.kind === "notice") {
          const reconnect = reconnectOf(item.title, item.detail);
          if (reconnect)
            return (
              <p className="timeline-divider timeline-reconnect" key={item.id} role={live ? "status" : undefined}>
                {live && <LoaderCircle className="tool-state-spinner" aria-hidden />}
                {reconnectLabel(reconnect, live)}
              </p>
            );
          return (
            <Alert variant="info" key={item.id}>
              <AlertTitle>{item.title}</AlertTitle>
              {item.detail ? (
                <AlertDescription>
                  <pre>{item.detail}</pre>
                </AlertDescription>
              ) : null}
            </Alert>
          );
        }
        if (item.kind === "plan")
          return (
            <section className="plan-card" key={item.id}>
              <strong>{item.title ?? "执行计划"}</strong>
              {item.markdown ? <RichText text={item.markdown} /> : null}
              {item.path ? (
                <Button
                  variant="ghost"
                  size="plain"
                  className="resource-chip"
                  onClick={() => onFile(item.path!.replace(/^file:\/\//, ""))}
                >
                  查看计划文件
                </Button>
              ) : null}
              <ul>
                {item.entries.map((entry, index) => (
                  <li key={index} data-status={entry.status}>
                    {/* Done is a filled check, under way a ring, still to do a dashed ring. */}
                    <span className="plan-mark" aria-label={entry.status === "completed" ? "已完成" : entry.status === "in_progress" ? "进行中" : "待办"}>
                      {entry.status === "completed" ? <Check strokeWidth={3} /> : null}
                    </span>
                    <span className="plan-text">{entry.content}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        if (item.kind === "permission-result")
          return (
            <details className="notice-card" key={item.id}>
              <summary>
                {item.asked ? "已回答" : item.allowed ? "已允许" : "已拒绝"} ·{" "}
                {item.title}
              </summary>
              <p>{item.optionName}</p>
              {item.answers?.map((answer, index) => (
                <p key={index}>
                  {answer.question}：{answer.answer}
                </p>
              ))}
            </details>
          );
        return (
          <ToolRecord
            key={item.id}
            item={item}
            sessionId={sessionId}
            agent={agent}
            onFile={onFile}
            onTerminal={onTerminal}
          />
        );
  })();
  return job.error ? (
    <>
      {entry}
      <ErrorNotice error={job.error} />
    </>
  ) : (
    entry
  );
});

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

/** An error as the Claude app shows it: what kind of failure, what to do, the agent's words one click away. */
function ErrorCard({ item }: { item: Extract<TimelineItem, { kind: "error" }> }) {
  const shown = presentError(item);
  return (
    <Alert variant="destructive" data-kind={shown.kind}>
      <AlertTitle>{shown.title}</AlertTitle>
      {shown.kind ? (
        <AlertDescription>
          {shown.hint && <p>{shown.hint}</p>}
          {shown.detail && (
            <details className="error-detail">
              <summary>查看详情</summary>
              <pre tabIndex={0}>{shown.detail}</pre>
            </details>
          )}
        </AlertDescription>
      ) : shown.hint ? (
        <AlertDescription>
          <pre>{shown.hint}</pre>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

function ToolState({ item }: { item: ToolItem }) {
  return (
    <span className="tool-state" aria-hidden>
      {item.detail?.type === "subagent" && item.detail.state === "unknown" ? (
        <CircleHelp />
      ) : item.status === "completed" ? (
        <Check />
      ) : item.status === "failed" ? (
        <CircleAlert />
      ) : item.status === "in_progress" ? (
        <LoaderCircle className="tool-state-spinner" />
      ) : (
        <CircleDashed />
      )}
    </span>
  );
}

const SUBAGENT_STATES: Record<string, string | null> = {
  pending: "待开始",
  running: "运行中",
  paused: "等待操作",
  completed: null,
  failed: "失败",
  stopped: "已停止",
  unknown: "状态未确认",
};

/**
 * The Claude app's end-of-turn box: its recap, the question it leaves, and its buttons. While it is
 * the open box (the last, nobody has written since), a reply button sends its words as the next
 * message, as the app's does; the app's own actions (commit, create a PR…) are done in the app.
 */
function WrapUpCard({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const box = wrapUpOf(item);
  const open = useContext(OpenWrapUp) === item.id;
  const actions = useActions();
  const online = useSessionOnline();
  const job = useJob();
  const [sent, setSent] = useState<number>();
  return (
    <section className="wrap-up-card" aria-label="已收尾">
      <small className="wrap-up-label">已收尾</small>
      {box.recap && <RichText text={box.recap} />}
      {box.ask && <p className="wrap-up-ask">{box.ask}</p>}
      {box.actions.length > 0 && (
        <div className="wrap-up-actions">
          {box.actions.map((action, index) =>
            open && action.message !== undefined ? (
              <Button
                key={index}
                type="button"
                variant={index === 0 ? "default" : "outline"}
                size="sm"
                className="wrap-up-button"
                disabled={!online || job.busy || sent !== undefined}
                title={action.message}
                onClick={() =>
                  void job.run(async () => {
                    const result = await actions.send(sessionId, [{ type: "text", text: action.message }]);
                    if (result === "failed") throw new Error("消息发送失败，请重试");
                    setSent(index);
                  })
                }
              >
                {action.label}
              </Button>
            ) : (
              <span key={index} className="wrap-up-chip" title={action.app ? "在 Claude App 里操作" : undefined}>
                {action.label}
              </span>
            ),
          )}
        </div>
      )}
      <ErrorNotice error={job.error} />
    </section>
  );
}

const SESSION_STATES = { starting: "正在启动", started: "已启动", proposed: "已提议，等你开始", failed: "启动失败" } as const;

/** A session the Claude app started from this one: opens it when this computer has it. */
function SessionCard({ item }: { item: ToolItem }) {
  const navigation = useContext(TimelineNavigation);
  const started = startedSession(item);
  const target = started.appId ? navigation?.findSession?.(started.appId) : undefined;
  const body = (
    <>
      {started.state === "starting" ? <LoaderCircle className="tool-state-spinner" aria-hidden /> : <MessageSquareText aria-hidden />}
      <span className="session-card-text">
        <strong>{started.title}</strong>
        <small>{SESSION_STATES[started.state]}</small>
      </span>
    </>
  );
  return target ? (
    <button type="button" className="session-card" data-state={started.state} onClick={target.open} title={`打开「${target.title}」`}>
      {body}
      <ChevronRight className="session-card-chevron" aria-hidden />
    </button>
  ) : (
    <div className="session-card" data-state={started.state}>{body}</div>
  );
}

/** A command as it ran: the command, what it printed, and how it ended. */
function CommandBody({ item, command }: { item: ToolItem; command: string }) {
  const output = toolOutput(item);
  const ended = exitNote(item);
  return (
    <div className="tool-terminal">
      <pre className="tool-terminal-command" tabIndex={0} aria-label="命令"><span className="tool-terminal-prompt" aria-hidden>$ </span>{command}</pre>
      {output && (
        <>
          <CopyText text={output} label="复制命令输出" />
          <pre className="tool-output-text" tabIndex={0} aria-label="命令输出">{output}</pre>
        </>
      )}
      {ended && <small className="tool-terminal-exit" data-ok={ended === "成功" || undefined}>{ended}</small>}
    </div>
  );
}

/**
 * One tool call, worded as the Claude app words it ("已读取 foo.ts", "正在运行 npm test"); its file
 * opens from the row. Opens to what it did: a command's run, a diff, a search's matches. Reading a
 * file and listing a directory have nothing more to show and stay one line.
 */
function ToolRecord({
  item,
  sessionId,
  agent,
  onFile,
  onTerminal,
}: {
  item: ToolItem;
  sessionId: string;
  agent: string;
  onFile: (path: string, line?: number) => void;
  onTerminal?: (id: string) => void;
}) {
  const { link } = useConnection();
  const navigation = useContext(TimelineNavigation);
  const job = useJob();
  const online = useSessionOnline();
  const label = toolLabel(item);
  const action = label.action;
  if (action === "compaction")
    return (
      <p className="timeline-divider" role={item.status === "in_progress" ? "status" : undefined}>
        {item.status === "in_progress" && <LoaderCircle className="tool-state-spinner" aria-hidden />}
        {compactionLabel(item)}
      </p>
    );
  if (action === "chapter") return <p className="timeline-divider timeline-chapter">{label.subject ?? "新章节"}</p>;
  if (action === "wrap_up") return <WrapUpCard item={item} sessionId={sessionId} />;
  if (action === "start_session") return <SessionCard item={item} />;

  const parts = toolLabelParts(label);
  const command = action === "command" ? toolCommand(item) : undefined;
  const plan = action === "plan" ? proposedPlan(item) : undefined;
  const questions = action === "question" ? askedQuestions(item) : [];
  const exploring = action === "read" || action === "list" || action === "search" || action === "find";
  const changed = item.content.filter((entry) => entry.type === "diff" || entry.type === "patch");
  const stat = changed.reduce(
    (sum, change) => {
      const lines = diffStat(changeLines(change));
      return { added: sum.added + lines.added, removed: sum.removed + lines.removed };
    },
    { added: 0, removed: 0 },
  );
  const cancel =
    item.detail?.type === "subagent" && item.detail.canCancel && item.detail.nativeSessionId && ["running", "paused", "pending"].includes(item.detail.state ?? "")
      ? item.detail.nativeSessionId
      : undefined;
  // A search's matches are worth opening; a file read or a directory listed are not.
  const hasBody = isQuietTool(item)
    ? false
    : exploring
      ? !!toolOutput(item)
      : !!command || !!plan || questions.length > 0 || !!cancel || !!item.output || item.content.length > 0 || !!item.locations?.length || item.rawInput !== undefined || item.rawOutput !== undefined || !!item.sub;
  const meta = item.detail?.type === "subagent" && item.detail.state ? SUBAGENT_STATES[item.detail.state] : null;
  const summary = (
    <>
      <ToolState item={item} />
      <strong className="tool-label" title={toolLabelText(label, { note: true })}>
        <span className="tool-verb">{parts.verb}</span>
        {parts.subject &&
          (label.style === "file" && label.path ? (
            <button
              type="button"
              className="tool-file"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onFile(label.path!);
              }}
            >
              {parts.subject}
            </button>
          ) : label.style === "code" ? (
            <code className="tool-subject-code">{parts.subject}</code>
          ) : (
            <span className="tool-subject">{parts.subject}</span>
          ))}
      </strong>
      {/* Outside the label, so a long command cut short still says it failed. */}
      {parts.suffix && <span className="tool-suffix">{parts.suffix}</span>}
      {label.note && <small className="tool-note">{label.note}</small>}
      <DiffStat added={stat.added} removed={stat.removed} />
      {meta && <small>{meta}</small>}
      {item.detail?.type === "mcp" && item.detail.app && navigation?.openApp && (
        // The call's page, as Codex's launcher card: open it here without unfolding the row.
        <button
          type="button"
          className="tool-app-open"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            navigation.openApp?.(item.id);
          }}
        >
          打开
        </button>
      )}
      {hasBody && <ChevronRight className="tool-record-chevron" aria-hidden />}
    </>
  );
  if (!hasBody)
    return (
      <div className={`tool-record tool-line ${item.status}`} data-action={action}>
        <div className="tool-summary">{summary}</div>
      </div>
    );
  return (
    <details className={`tool-record ${item.status}`} data-action={action}>
      <summary>{summary}</summary>
      {cancel ? (
        <Button
          variant="outline"
          disabled={!online || job.busy}
          onClick={() => void job.run(() => link.call("sessions.cancelSubagent", { sessionId, nativeSessionId: cancel }))}
        >
          停止这个子代理
        </Button>
      ) : null}
      {job.error && <ErrorNotice error={job.error} />}
      {command ? (
        <CommandBody item={item} command={command} />
      ) : plan ? (
        <RichText text={plan} />
      ) : questions.length > 0 ? (
        <>
          <ul className="tool-questions">
            {questions.map((question, index) => (
              <li key={index}>
                {question.header && <small>{question.header}{question.multiple ? "（可多选）" : ""}</small>}
                <p>{question.question}</p>
                {question.options.length > 0 && <p className="muted">{question.options.join(" · ")}</p>}
              </li>
            ))}
          </ul>
          {toolOutput(item) && <pre className="tool-output-text" tabIndex={0} aria-label="回答">{toolOutput(item)}</pre>}
        </>
      ) : exploring ? (
        <pre className="tool-output-text" tabIndex={0} aria-label="工具输出">{toolOutput(item)}</pre>
      ) : (
        <>
          {item.output && (
            <>
              <CopyText text={item.output} label="复制工具输出" />
              <pre className="tool-output-text" tabIndex={0} aria-label="工具输出">
                {item.output}
              </pre>
            </>
          )}
          {item.content.map((content, index) =>
            content.type === "content" ? (
              <Blocks key={index} blocks={[content.content]} sessionId={sessionId} onFile={onFile} />
            ) : content.type === "terminal" ? (
              <span key={index} className="muted">
                Agent 终端输出{item.output ? "见上方" : "正在等待输出"}
              </span>
            ) : (
              <Diff key={index} change={content} />
            ),
          )}
          {item.locations?.map((location, index) => (
            <Button variant="ghost" size="plain" key={index} className="resource-chip" onClick={() => onFile(location.path, location.line)}>
              {location.path}
              {location.line ? `:${location.line}` : ""}
            </Button>
          ))}
          {item.rawInput !== undefined && (
            <details>
              <summary>工具参数</summary>
              <pre tabIndex={0}>{typeof item.rawInput === "string" ? item.rawInput : JSON.stringify(item.rawInput, null, 2)}</pre>
            </details>
          )}
          {item.rawOutput !== undefined && (
            <details>
              <summary>原始结果</summary>
              <pre tabIndex={0}>{typeof item.rawOutput === "string" ? item.rawOutput : JSON.stringify(item.rawOutput, null, 2)}</pre>
            </details>
          )}
        </>
      )}
      {item.sub && <Timeline items={item.sub.items} sessionId={sessionId} agent={agent} onFile={onFile} onTerminal={onTerminal} />}
    </details>
  );
}

/** Whole-timeline map of async questions already answered by a later message. */
export function answeredMap(items: TimelineItem[]): Map<string, string> {
  return new Map(
    items.flatMap((item) =>
      item.kind === "user" && !item.failed && !item.pending
        ? item.blocks.flatMap((block) =>
            block.type === "text" ? answeredQuestions(block.text) : [],
          )
        : [],
    ),
  );
}

export function Timeline({
  items,
  sessionId,
  agent,
  onFile,
  onFork,
  onTerminal,
  showAsyncQuestions = true,
}: {
  items: TimelineItem[];
  sessionId: string;
  agent: string;
  onFile: (path: string, line?: number) => void;
  onFork?: (id: string) => void;
  onTerminal?: (id: string) => void;
  showAsyncQuestions?: boolean;
}) {
  // Which folded step runs the reader has opened in place.
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set());
  const toggleSteps = (key: string) =>
    setOpenSteps((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Finished runs of tool/thought steps fold into one summary line, Desktop-style.
  const rows = foldStepRuns(items, openSteps);
  // The agent's async questions (Codex Desktop) are answered by a message quoting them, here or on the computer.
  const answered = answeredMap(items);
  return (
    <div className="live-timeline">
      {rows.map((row) =>
        row.type === "steps" ? (
          <StepsSummary
            key={row.key}
            steps={row.steps}
            open={openSteps.has(row.key)}
            onToggle={() => toggleSteps(row.key)}
          />
        ) : (
          <TimelineEntry
            key={row.item.id}
            item={row.item}
            sessionId={sessionId}
            agent={agent}
            onFile={onFile}
            onFork={onFork}
            onTerminal={onTerminal}
            showAsyncQuestions={showAsyncQuestions}
            answered={answered}
          />
        ),
      )}
    </div>
  );
}
