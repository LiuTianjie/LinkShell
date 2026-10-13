import { AsyncQuestions } from "./AsyncQuestions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Children,
  isValidElement,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy } from "lucide-react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { fileTarget } from "./file-target";
import remarkGfm from "remark-gfm";
import type { ContentBlock, ToolCallContent } from "@linkshell/wire";
import {
  answeredQuestions,
  questionReplies,
  type TimelineItem,
} from "@linkshell/client-core";
import {
  AgentMark,
  ErrorNotice,
  useActions,
  useConnection,
  useClient,
  useJob,
} from "./common";

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
        size="sm"
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
        <span>{copied ? "已复制" : "复制"}</span>
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
} | null>(null);

function CodeBlock({ children }: { children: ReactNode }) {
  const element = Children.toArray(children).find(isValidElement);
  const language =
    element &&
    (element.props as { className?: string }).className?.match(
      /language-([\w+-]+)/,
    )?.[1];
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
          size="sm"
          disabled={job.busy}
          aria-label={copied ? "代码已复制" : "复制代码"}
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
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
      <pre
        ref={code}
        tabIndex={0}
        aria-label={language ? language + " 代码" : "代码"}
      >
        {children}
      </pre>
      <ErrorNotice
        error={job.error ? "无法访问剪贴板，请选中代码后复制。" : undefined}
      />
    </div>
  );
}
export function RichText({ text }: { text: string }) {
  const navigation = useContext(TimelineNavigation);
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          url.startsWith("file://") ? url : defaultUrlTransform(url)
        }
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => {
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
          },
          img: ({ src, alt }) => (
            <a
              href={typeof src === "string" ? src : undefined}
              target="_blank"
              rel="noreferrer"
            >
              {alt || "查看图片"} ↗
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
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
    <a
      href={uri}
      download={uri.startsWith("data:") ? "image" : undefined}
      target="_blank"
      rel="noreferrer"
    >
      <img
        className="message-image"
        src={uri}
        alt="会话图片"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          setUri(undefined);
          setError("图片加载失败");
        }}
      />
    </a>
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
        <img src={uri} className="message-image" alt={download ?? "附件"} />
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
export function Diff({
  change,
}: {
  change: Extract<ToolCallContent, { type: "diff" | "patch" }>;
}) {
  if (change.type === "diff")
    return (
      <details className="diff-block" open>
        <summary>{change.path}</summary>
        <div className="before-after">
          <div>
            <small>修改前</small>
            <pre tabIndex={0} aria-label="修改前">
              {change.oldText ?? "（新文件）"}
            </pre>
          </div>
          <div>
            <small>修改后</small>
            <pre tabIndex={0} aria-label="修改后">
              {change.newText}
            </pre>
          </div>
        </div>
      </details>
    );
  return (
    <details className="diff-block" open>
      <summary>
        {change.path}
        {change.movePath ? ` → ${change.movePath}` : ""}
      </summary>
      <pre tabIndex={0} aria-label={`${change.path} 的差异`}>
        {change.diff.split("\n").map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith("+")
                ? "diff-add-line"
                : line.startsWith("-")
                  ? "diff-remove-line"
                  : ""
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
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
  const text =
    blocks.length === 1 && blocks[0]!.type === "text"
      ? blocks[0]!.text
      : undefined;
  const replies = text === undefined ? undefined : questionReplies(text);
  if (!replies)
    return <Blocks blocks={blocks} sessionId={sessionId} onFile={onFile} />;
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
  const actions = useActions();
  const { link } = useConnection();
  const job = useJob();
  const online = useClient((state) => state.status === "online");
  const tail = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(-180);
  // The agent's async questions (Codex Desktop) are answered by a message quoting them, here or on the computer.
  const answered = new Map(
    items.flatMap((item) =>
      item.kind === "user" && !item.failed && !item.pending
        ? item.blocks.flatMap((block) =>
            block.type === "text" ? answeredQuestions(block.text) : [],
          )
        : [],
    ),
  );
  return (
    <div className="live-timeline">
      {items.length > shown.length && (
        <Button variant="link" size="sm" onClick={() => setExpanded(true)}>
          显示本次已加载的更早消息（{items.length - shown.length}）
        </Button>
      )}
      {shown.map((item) => {
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
              {item.agentMessages.map((message, index) => (
                <details key={`${message.sender}:${index}`}>
                  <summary>
                    <span className="message-label">
                      {message.notice === "idle"
                        ? `@${message.sender} · 本轮已结束`
                        : `来自 @${message.sender}`}
                    </span>
                    {message.summary ? ` · ${message.summary}` : ""}
                  </summary>
                  <RichText text={message.body || "当前空闲，等待后续任务。"} />
                </details>
              ))}
            </article>
          );
        if (item.kind === "user")
          return (
            <article className="user-message" key={item.id}>
              <span className="message-label">
                你{" "}
                <small title={new Date(item.ts).toLocaleString()}>
                  {new Date(item.ts).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {item.pending ? " · 发送中" : ""}
                </small>
              </span>
              <UserBlocks
                blocks={item.blocks}
                sessionId={sessionId}
                onFile={onFile}
              />
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
                    size="plain"
                    className="message-fork"
                    disabled={!online}
                    onClick={() => onFork(item.id)}
                  >
                    从这里分叉
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
              <div className="message-author">
                <AgentMark agent={agent} />
                <strong>{agent}</strong>
                {item.streaming && <span>正在回复…</span>}
              </div>
              <RichText text={item.text} />
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
                      size="plain"
                      className="message-fork"
                      disabled={!online}
                      onClick={() => onFork(item.id)}
                    >
                      从这里分叉
                    </Button>
                  )}
                </div>
              )}
            </article>
          );
        if (item.kind === "thought")
          return (
            <details className="thought-block" key={item.id}>
              <summary>{item.streaming ? "正在思考…" : "思考过程"}</summary>
              <RichText text={item.text} />
            </details>
          );
        if (item.kind === "notice" || item.kind === "error")
          return (
            <Alert
              variant={item.kind === "error" ? "destructive" : "default"}
              key={item.id}
            >
              <AlertTitle>
                {item.kind === "notice" ? item.title : item.message}
              </AlertTitle>
              <AlertDescription>
                <pre>{item.kind === "notice" ? item.detail : item.hint}</pre>
              </AlertDescription>
            </Alert>
          );
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
                  <li key={index}>
                    <span>
                      {entry.status === "completed"
                        ? "✓"
                        : entry.status === "in_progress"
                          ? "◉"
                          : "○"}
                    </span>
                    {entry.content}
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
          <details className={`tool-record ${item.status}`} key={item.id}>
            <summary>
              <span className="tool-state">
                {item.detail?.type === "subagent" &&
                item.detail.state === "unknown"
                  ? "?"
                  : item.status === "completed"
                    ? "✓"
                    : item.status === "failed"
                      ? "!"
                      : "◌"}
              </span>
              <strong title={item.title}>{item.title}</strong>
              <small>
                {item.detail?.type === "mcp"
                  ? `MCP · ${item.detail.server}`
                  : item.detail?.type === "subagent" && item.detail.state
                    ? {
                        pending: "待开始",
                        running: "运行中",
                        paused: "等待操作",
                        completed: "已完成",
                        failed: "失败",
                        stopped: "已停止",
                        unknown: "状态未确认",
                      }[item.detail.state]
                    : item.status === "in_progress"
                      ? "执行中"
                      : item.status === "failed"
                        ? "执行失败"
                        : "已完成"}
              </small>
            </summary>
            {item.detail?.type === "subagent" &&
            item.detail.canCancel &&
            item.detail.nativeSessionId &&
            ["running", "paused", "pending"].includes(
              item.detail.state ?? "",
            ) ? (
              <Button
                variant="outline"
                disabled={!online || job.busy}
                onClick={() =>
                  void job.run(() =>
                    link.call("sessions.cancelSubagent", {
                      sessionId,
                      nativeSessionId:
                        item.detail!.type === "subagent"
                          ? item.detail!.nativeSessionId!
                          : "",
                    }),
                  )
                }
              >
                停止这个子代理
              </Button>
            ) : null}
            {item.detail?.type === "mcp" && (
              <p className="muted">
                服务：{item.detail.server} · 工具：{item.detail.tool}
              </p>
            )}
            {item.output && (
              <>
                <CopyText text={item.output} label="复制工具输出" />
                <pre
                  className="tool-output-text"
                  tabIndex={0}
                  aria-label="工具输出"
                >
                  {item.output}
                </pre>
              </>
            )}
            {item.content.map((content, index) =>
              content.type === "content" ? (
                <Blocks
                  key={index}
                  blocks={[content.content]}
                  sessionId={sessionId}
                  onFile={onFile}
                />
              ) : content.type === "terminal" ? (
                <span key={index} className="muted">
                  Agent 终端输出{item.output ? "见上方" : "正在等待输出"}
                </span>
              ) : (
                <Diff key={index} change={content} />
              ),
            )}
            {item.locations?.map((location, index) => (
              <Button
                variant="ghost"
                size="plain"
                key={index}
                className="resource-chip"
                onClick={() => onFile(location.path, location.line)}
              >
                {location.path}
                {location.line ? `:${location.line}` : ""}
              </Button>
            ))}
            {item.rawInput !== undefined && (
              <details>
                <summary>工具参数</summary>
                <pre tabIndex={0}>
                  {typeof item.rawInput === "string"
                    ? item.rawInput
                    : JSON.stringify(item.rawInput, null, 2)}
                </pre>
              </details>
            )}
            {item.rawOutput !== undefined && (
              <details>
                <summary>原始结果</summary>
                <pre tabIndex={0}>
                  {typeof item.rawOutput === "string"
                    ? item.rawOutput
                    : JSON.stringify(item.rawOutput, null, 2)}
                </pre>
              </details>
            )}
            {item.sub && (
              <Timeline
                items={item.sub.items}
                sessionId={sessionId}
                agent={agent}
                onFile={onFile}
                onTerminal={onTerminal}
              />
            )}
          </details>
        );
      })}
      <ErrorNotice error={job.error} />
      <div ref={tail} />
    </div>
  );
}
