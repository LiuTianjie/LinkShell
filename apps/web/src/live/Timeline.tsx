import { createContext, useContext, useEffect, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { fileTarget } from "./file-target";
import remarkGfm from "remark-gfm";
import type { ContentBlock, ToolCallContent } from "@linkshell/wire";
import {
  answeredQuestions,
  asyncQuestionReply,
  questionReplies,
  type AsyncQuestion,
  type TimelineItem,
} from "@linkshell/client-core";
import { AgentMark, ErrorNotice, useActions, useConnection, useJob } from "./common";

export const TimelineNavigation = createContext<{
  cwd: string;
  open: (path: string, line?: number) => void;
} | null>(null);
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
  }, [loadImage, block.uri, block.data, block.mimeType, sessionId]);
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
    <span className="muted">{error ?? "图片加载中…"}</span>
  );
}

function Asset({ block, sessionId, download }: { block: { data?: string; uri?: string; mimeType: string }; sessionId: string; download?: string }) {
  const { loadImage } = useActions();
  const [uri, setUri] = useState(block.data ? `data:${block.mimeType};base64,${block.data}` : block.uri?.startsWith("linkshell-event:") ? undefined : block.uri);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    setError(undefined);
    setUri(block.data ? `data:${block.mimeType};base64,${block.data}` : block.uri?.startsWith("linkshell-event:") ? undefined : block.uri);
    if (block.uri?.startsWith("linkshell-event:")) void loadImage(sessionId, block.uri).then((value) => { if (alive) setUri(value); }, () => { if (alive) setError("附件加载失败"); });
    return () => { alive = false; };
  }, [block.data, block.uri, block.mimeType, loadImage, sessionId]);
  if (!uri) return <span className="muted">{error ?? "附件加载中…"}</span>;
  if (!/^(data:|https?:\/\/)/.test(uri)) return <span className="muted">附件地址无效</span>;
  return <div className="protocol-asset">{block.mimeType.startsWith("audio/") ? <audio controls preload="metadata" src={uri} /> : block.mimeType.startsWith("image/") ? <img src={uri} className="message-image" alt={download ?? "附件"} /> : null}<a className="resource-chip" href={uri} download={download ?? "audio"}>下载{download ? ` ${download}` : "音频"}</a></div>;
}
export function Blocks({
  blocks,
  sessionId,
  onFile,
}: {
  blocks: ContentBlock[];
  sessionId: string;
  onFile: (path: string) => void;
}) {
  return (
    <>
      {blocks.map((block, index) =>
        block.type === "text" ? (
          <RichText key={index} text={block.text} />
        ) : block.type === "image" ? (
          <Picture key={index} block={block} sessionId={sessionId} />
        ) : block.type === "audio" ? <Asset key={index} block={block} sessionId={sessionId} />
        : block.type === "resource" ? <details key={index} className="notice-card" open={!!block.resource.text}><summary>{block.resource.uri} · {block.resource.mimeType ?? "附件"}</summary>{block.resource.text !== undefined ? <pre>{block.resource.text}</pre> : <Asset block={{ data: block.resource.blob, uri: block.resource.assetUri, mimeType: block.resource.mimeType ?? "application/octet-stream" }} sessionId={sessionId} download={block.resource.uri.split("/").at(-1)} />}</details>
        : /^https?:\/\//.test(block.uri) ? (
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
          <button
            key={index}
            className="resource-chip"
            onClick={() => onFile(block.uri.replace(/^file:\/\//, ""))}
          >
            {block.kind === "skill" ? "技能 · " : "文件 · "}
            {block.name}
          </button>
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
            <pre>{change.oldText ?? "（新文件）"}</pre>
          </div>
          <div>
            <small>修改后</small>
            <pre>{change.newText}</pre>
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
      <pre>
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
  onFile: (path: string) => void;
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

/** Questions a message asks without stopping its turn: each option sends the answer as a message, as Codex Desktop does. */
function AsyncQuestions({
  questions,
  answered,
  onAnswer,
}: {
  questions: AsyncQuestion[];
  answered: ReadonlyMap<string, string>;
  onAnswer: (question: AsyncQuestion, answer: string) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  return (
    <div className="async-questions">
      {questions.map((question) => {
        if (question.options.length === 0) return null;
        const given = picked[question.id] ?? answered.get(question.id);
        const done = given !== undefined;
        return (
          <div key={question.id}>
            {questions.length > 1 && <small>{question.title}</small>}
            <div className="async-options">
              {question.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={done}
                  aria-pressed={given === option}
                  className={given === option ? "chosen" : undefined}
                  onClick={() => {
                    setPicked((current) => ({
                      ...current,
                      [question.id]: option,
                    }));
                    onAnswer(question, option);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Timeline({
  items,
  sessionId,
  agent,
  onFile,
  onFork,
  onTerminal,
}: {
  items: TimelineItem[];
  sessionId: string;
  agent: string;
  onFile: (path: string) => void;
  onFork?: (id: string) => void;
  onTerminal?: (id: string) => void;
}) {
  const actions = useActions();
  const { link } = useConnection();
  const job = useJob();
  const tail = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(-180);
  // The agent's async questions (Codex Desktop) are answered by a message quoting them, here or on the computer.
  const answered = new Map(
    items.flatMap((item) =>
      item.kind === "user"
        ? item.blocks.flatMap((block) =>
            block.type === "text" ? answeredQuestions(block.text) : [],
          )
        : [],
    ),
  );
  const answer = (question: AsyncQuestion, value: string) =>
    void job.run(() =>
      actions.send(sessionId, [
        {
          type: "text",
          text: asyncQuestionReply([{ question, answer: value }]),
        },
      ]),
    );
  return (
    <div className="live-timeline">
      {items.length > shown.length && (
        <button className="text-button" onClick={() => setExpanded(true)}>
          显示本次已加载的更早消息（{items.length - shown.length}）
        </button>
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
                    : item.stopReason === "max_tokens" ? "达到输出上限，回复被截断" : item.stopReason === "max_turn_requests" ? "达到本轮请求次数上限" : item.stopReason === "refusal" ? "Agent 拒绝了这个请求" : item.stopReason === "unknown" ? "本轮已结束，Agent 未提供明确原因" : "本轮结束"}
            </p>
          );
        if (item.kind === "user" && item.agentMessages?.length)
          return <article key={item.id} className="agent-message">
            {item.agentMessages.map((message, index) => <details key={`${message.sender}:${index}`}>
              <summary><span className="message-label">{message.notice === "idle" ? `@${message.sender} · 本轮已结束` : `来自 @${message.sender}`}</span>{message.summary ? ` · ${message.summary}` : ""}</summary>
              <RichText text={message.body || "当前空闲，等待后续任务。"} />
            </details>)}
          </article>;
        if (item.kind === "user")
          return (
            <article className="user-message" key={item.id}>
              <span className="message-label">
                你{" "}
                <small>
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
                <div>
                  <span className="form-error">发送失败，草稿仍在</span>
                  <button
                    className="text-button"
                    onClick={() => void job.run(() => actions.retry(item.id))}
                  >
                    重试
                  </button>
                  <button
                    className="text-button"
                    onClick={() => actions.discard(item.id)}
                  >
                    移除
                  </button>
                </div>
              )}
              {onFork && !item.pending && (
                <button
                  className="message-fork"
                  onClick={() => onFork(item.id)}
                >
                  从这里分叉
                </button>
              )}
            </article>
          );
        if (item.kind === "agent")
          return (
            <article className="assistant-message" key={item.id}>
              {item.senderSessionId || item.recipientSessionId ? <small className="muted">{item.senderSessionId ?? "Agent"} → {item.recipientSessionId ?? "当前会话"}</small> : null}
              <div className="message-author">
                <AgentMark agent={agent} />
                <strong>{agent}</strong>
                {item.streaming && <span>正在回复…</span>}
              </div>
              <RichText text={item.text} />
              {item.questions && !item.streaming && (
                <AsyncQuestions
                  questions={item.questions}
                  answered={answered}
                  onAnswer={answer}
                />
              )}
              {item.attachments && (
                <Blocks
                  blocks={item.attachments}
                  sessionId={sessionId}
                  onFile={onFile}
                />
              )}
              {onFork && !item.streaming && (
                <button
                  className="message-fork"
                  onClick={() => onFork(item.id)}
                >
                  从这里分叉
                </button>
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
            <section className={`notice-card ${item.kind}`} key={item.id}>
              <strong>
                {item.kind === "notice" ? item.title : item.message}
              </strong>
              <pre>{item.kind === "notice" ? item.detail : item.hint}</pre>
            </section>
          );
        if (item.kind === "plan")
          return (
            <section className="plan-card" key={item.id}>
              <strong>{item.title ?? "执行计划"}</strong>
              {item.markdown ? <RichText text={item.markdown} /> : null}
              {item.path ? <button className="resource-chip" onClick={() => onFile(item.path!.replace(/^file:\/\//, ""))}>查看计划文件</button> : null}
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
                {item.detail?.type === "subagent" && item.detail.state === "unknown" ? "?" : item.status === "completed"
                  ? "✓"
                  : item.status === "failed"
                    ? "!"
                    : "◌"}
              </span>
              <strong>{item.title}</strong>
              <small>
                {item.detail?.type === "mcp"
                  ? `MCP · ${item.detail.server}`
                  : item.detail?.type === "subagent" && item.detail.state ? ({ pending: "待开始", running: "运行中", paused: "等待操作", completed: "已完成", failed: "失败", stopped: "已停止", unknown: "状态未确认" }[item.detail.state])
                  : item.status === "in_progress"
                    ? "执行中"
                    : ""}
              </small>
            </summary>
            {item.detail?.type === "subagent" && item.detail.canCancel && item.detail.nativeSessionId && ["running", "paused", "pending"].includes(item.detail.state ?? "") ? <button className="button secondary" disabled={job.busy} onClick={() => void job.run(() => link.call("sessions.cancelSubagent", { sessionId, nativeSessionId: item.detail!.type === "subagent" ? item.detail!.nativeSessionId! : "" }))}>停止这个子代理</button> : null}
            {item.detail?.type === "mcp" && (
              <p className="muted">
                服务：{item.detail.server} · 工具：{item.detail.tool}
              </p>
            )}
            {item.output && (
              <pre className="tool-output-text">{item.output}</pre>
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
                <span key={index} className="muted">Agent 终端输出{item.output ? "见上方" : "正在等待输出"}</span>
              ) : (
                <Diff key={index} change={content} />
              ),
            )}
            {item.locations?.map((location, index) => (
              <button
                key={index}
                className="resource-chip"
                onClick={() => onFile(location.path)}
              >
                {location.path}
                {location.line ? `:${location.line}` : ""}
              </button>
            ))}
            {item.rawInput !== undefined && (
              <details>
                <summary>工具参数</summary>
                <pre>{JSON.stringify(item.rawInput, null, 2)}</pre>
              </details>
            )}
            {item.rawOutput !== undefined && (
              <details>
                <summary>原始结果</summary>
                <pre>{JSON.stringify(item.rawOutput, null, 2)}</pre>
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
