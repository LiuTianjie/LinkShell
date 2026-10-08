import { createContext, useContext, useEffect, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { fileTarget } from "./file-target";
import remarkGfm from "remark-gfm";
import type { ContentBlock, ToolCallContent } from "@linkshell/wire";
import type { TimelineItem } from "@linkshell/client-core";
import { AgentMark, ErrorNotice, useActions, useJob } from "./common";

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
  const job = useJob();
  const tail = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(-180);
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
                    : "本轮结束"}
            </p>
          );
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
              <Blocks
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
              <div className="message-author">
                <AgentMark agent={agent} />
                <strong>{agent}</strong>
                {item.streaming && <span>正在回复…</span>}
              </div>
              <RichText text={item.text} />
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
              <strong>执行计划</strong>
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
                {item.status === "completed"
                  ? "✓"
                  : item.status === "failed"
                    ? "!"
                    : "◌"}
              </span>
              <strong>{item.title}</strong>
              <small>
                {item.detail?.type === "mcp"
                  ? `MCP · ${item.detail.server}`
                  : item.status === "in_progress"
                    ? "执行中"
                    : ""}
              </small>
            </summary>
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
                <button
                  key={index}
                  className="text-button"
                  onClick={() => onTerminal?.(content.terminalId)}
                >
                  打开关联终端
                </button>
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
