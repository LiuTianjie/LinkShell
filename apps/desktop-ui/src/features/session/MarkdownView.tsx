import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { HostImageCache, normalizeMarkdownForDisplay } from "@linkshell/client-core";
import { openExternalUrl } from "@/bridge/desktop-bridge";
import {
  engine,
  markdownBlocks,
  renderHighlightedTokens,
  useHighlight,
  useSmoothText,
  type Connection,
} from "@/core";
import { CopyButton } from "@/primitives";
import { basenameOfPath, openFileInInspector, resolveFileHrefTarget } from "./session-helpers";

export const desktopHostImageCache = new HostImageCache();
const DIRECT_IMAGE_URL = /^(?:data:image\/|https?:\/\/|blob:)/i;

const REMARK_PLUGINS = [remarkGfm];

export function safeMarkdownUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^(?:javascript|vbscript|file-upload):/i.test(trimmed)) return "";
  if (/^data:/i.test(trimmed) && !/^data:image\//i.test(trimmed)) return "";
  return trimmed;
}

function extractPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractPlainText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractPlainText(node.props.children);
  }
  return "";
}

function highlightTextNodes(node: ReactNode, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return node;

  if (typeof node === "string") {
    const lower = node.toLowerCase();
    const target = needle.toLowerCase();
    let idx = lower.indexOf(target);
    if (idx === -1) return node;
    const parts: ReactNode[] = [];
    let cursor = 0;
    let key = 0;
    while (idx !== -1) {
      if (idx > cursor) {
        parts.push(node.slice(cursor, idx));
      }
      parts.push(
        <mark key={key++} className="ls-search-mark">
          {node.slice(idx, idx + target.length)}
        </mark>,
      );
      cursor = idx + target.length;
      idx = lower.indexOf(target, cursor);
    }
    if (cursor < node.length) {
      parts.push(node.slice(cursor));
    }
    return parts;
  }

  if (Array.isArray(node)) {
    return Children.map(node, (child) => highlightTextNodes(child, needle));
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    if (node.props.children === undefined) return node;
    return cloneElement(
      node as ReactElement<{ children?: ReactNode }>,
      undefined,
      highlightTextNodes(node.props.children, needle),
    );
  }

  return node;
}

export interface CodeFenceProps {
  code: string;
  language?: string;
  streaming?: boolean;
  searchQuery?: string;
}

export function CodeFence({
  code,
  language,
  streaming = false,
  searchQuery,
}: CodeFenceProps) {
  const trimmedCode = code.replace(/\n$/, "");
  const tokens = useHighlight(trimmedCode, language, !streaming && !searchQuery);

  const rendered = useMemo(() => {
    if (searchQuery?.trim()) {
      return highlightTextNodes(trimmedCode, searchQuery);
    }
    return tokens ? renderHighlightedTokens(tokens) : trimmedCode;
  }, [searchQuery, tokens, trimmedCode]);

  return (
    <div className="ls-code-fence">
      <div className="ls-code-header">
        <span className="ls-code-lang">{language || "text"}</span>
        <CopyButton value={trimmedCode} revealOnHover />
      </div>
      <pre className="ls-code-pre" tabIndex={0}>
        <code>{rendered}</code>
      </pre>
    </div>
  );
}

export interface MarkdownImageProps {
  src?: string;
  alt?: string;
  computerKey?: string;
  connection?: Connection;
  sessionId?: string;
  cwd?: string;
  onOpenImage?: (src: string, alt: string) => void;
}

/**
 * Renders an image embedded in Markdown (`![alt](src)`). Host paths (`file:///D:/...`,
 * `/path/to/a.gif`, `./_artifacts/a.gif`) are fetched over `fs.read` so Chromium never blocks
 * `file://` resources and remote computers work identically to local ones; GIFs animate natively.
 */
export function MarkdownImage({
  src,
  alt,
  computerKey,
  connection,
  sessionId,
  cwd,
  onOpenImage,
}: MarkdownImageProps) {
  const cleanSrc = typeof src === "string" ? src.trim() : "";
  const isDirect = Boolean(cleanSrc && DIRECT_IMAGE_URL.test(cleanSrc));
  const hostTarget = useMemo(
    () => (!isDirect && cleanSrc ? resolveFileHrefTarget(cleanSrc, cwd) : null),
    [cleanSrc, cwd, isDirect],
  );
  const resolvedConnection =
    connection ?? (computerKey ? engine.connectionForKey(computerKey) : undefined);
  const cacheKey =
    hostTarget && resolvedConnection
      ? `${resolvedConnection.computer.key}\0${hostTarget.path}`
      : undefined;

  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(() =>
    isDirect ? cleanSrc : cacheKey ? desktopHostImageCache.peek(cacheKey) : undefined,
  );
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailedMessage(null);
    if (isDirect) {
      setResolvedSrc(cleanSrc);
      return;
    }
    if (!hostTarget || !resolvedConnection || !cacheKey) {
      setResolvedSrc(undefined);
      setFailedMessage(cleanSrc ? "图片加载失败" : null);
      return;
    }
    const hit = desktopHostImageCache.peek(cacheKey);
    if (hit) {
      setResolvedSrc(hit);
      return;
    }
    setResolvedSrc(undefined);
    let alive = true;
    void desktopHostImageCache
      .load(cacheKey, resolvedConnection.link, hostTarget.path)
      .then(
        (dataUri) => {
          if (alive) setResolvedSrc(dataUri);
        },
        (reason: unknown) => {
          if (alive) {
            const msg = reason instanceof Error && reason.message ? reason.message : "图片加载失败";
            setFailedMessage(msg);
          }
        },
      );
    return () => {
      alive = false;
    };
  }, [attempt, cacheKey, cleanSrc, hostTarget, isDirect, resolvedConnection]);

  if (!cleanSrc) return null;

  const label = alt?.trim() || (hostTarget ? basenameOfPath(hostTarget.path) : "图片");

  if (resolvedSrc && !failedMessage) {
    return (
      <img
        className="ls-md-image"
        src={resolvedSrc}
        alt={label}
        loading="lazy"
        referrerPolicy="no-referrer"
        data-zoomable={onOpenImage ? "true" : undefined}
        onClick={
          onOpenImage
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenImage(resolvedSrc, label);
              }
            : undefined
        }
        onError={() => {
          setResolvedSrc(undefined);
          setFailedMessage("图片加载失败");
        }}
      />
    );
  }

  if (failedMessage) {
    return (
      <span className="ls-md-image-state" role="status">
        {hostTarget && computerKey ? (
          <a
            href={`file://${hostTarget.path}`}
            className="ls-md-file-link"
            onClick={(event) => {
              event.preventDefault();
              openFileInInspector(computerKey, sessionId, hostTarget.path, hostTarget.line, hostTarget.endLine);
            }}
          >
            {label}
          </a>
        ) : isDirect && /^https?:\/\//i.test(cleanSrc) ? (
          <a
            href={cleanSrc}
            onClick={(event) => {
              event.preventDefault();
              openExternalUrl(cleanSrc);
            }}
          >
            {label}
          </a>
        ) : (
          <span>{label}</span>
        )}
        <span className="ls-md-image-status">（{failedMessage}）</span>
        <button
          type="button"
          className="ls-md-image-retry"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setAttempt((value) => value + 1);
          }}
        >
          重试
        </button>
      </span>
    );
  }

  return (
    <span className="ls-md-image-state" role="status">
      图片加载中…
    </span>
  );
}

interface MarkdownBlockProps {
  block: string;
  streaming: boolean;
  computerKey?: string;
  connection?: Connection;
  sessionId?: string;
  cwd?: string;
  searchQuery?: string;
  onOpenImage?: (src: string, alt: string) => void;
}

const SingleMarkdownBlock = memo(function SingleMarkdownBlock({
  block,
  streaming,
  computerKey,
  connection,
  sessionId,
  cwd,
  searchQuery,
  onOpenImage,
}: MarkdownBlockProps) {
  const components = useMemo<Components>(
    () => ({
      pre({ children }) {
        return <>{children}</>;
      },
      code({ className, children }) {
        const rawText = String(children ?? "");
        const langMatch = /language-([^\s]+)/.exec(className ?? "");
        const isBlock = Boolean(langMatch) || rawText.includes("\n");
        if (isBlock) {
          return (
            <CodeFence
              code={rawText}
              language={langMatch?.[1]}
              streaming={streaming}
              searchQuery={searchQuery}
            />
          );
        }
        const fileTarget = computerKey ? resolveFileHrefTarget(rawText, cwd) : null;
        if (
          fileTarget &&
          computerKey &&
          (rawText.includes("/") || rawText.includes("\\") || /\.[a-z]{1,6}(:\d+)?$/i.test(rawText))
        ) {
          return (
            <code
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() =>
                openFileInInspector(computerKey, sessionId, fileTarget.path, fileTarget.line)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openFileInInspector(computerKey, sessionId, fileTarget.path, fileTarget.line);
                }
              }}
            >
              {searchQuery ? highlightTextNodes(children, searchQuery) : children}
            </code>
          );
        }
        return <code>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</code>;
      },
      img({ src, alt }) {
        return (
          <MarkdownImage
            src={src}
            alt={alt}
            computerKey={computerKey}
            connection={connection}
            sessionId={sessionId}
            cwd={cwd}
            onOpenImage={onOpenImage}
          />
        );
      },
      a({ href, children }) {
        const safeHref = href ?? "";
        const plainText = extractPlainText(children).trim();
        const resolvedTarget =
          resolveFileHrefTarget(safeHref, cwd) ??
          (!safeHref ? resolveFileHrefTarget(plainText, cwd) : null);
        const fileTarget = computerKey ? resolvedTarget : null;
        const isExternal = /^(?:https?:|mailto:|tel:)/i.test(safeHref);
        const content = searchQuery
          ? highlightTextNodes(children, searchQuery)
          : children;
        if (!fileTarget && !isExternal) {
          return <span>{content}</span>;
        }
        return (
          <a
            href={safeHref || (fileTarget ? `file://${fileTarget.path}` : "#")}
            className={fileTarget ? "ls-md-file-link" : undefined}
            onClick={(event) => {
              event.preventDefault();
              if (fileTarget && computerKey) {
                openFileInInspector(
                  computerKey,
                  sessionId,
                  fileTarget.path,
                  fileTarget.line,
                  fileTarget.endLine,
                );
                return;
              }
              if (isExternal) {
                openExternalUrl(safeHref);
              }
            }}
          >
            {content}
          </a>
        );
      },
      table({ children }) {
        return (
          <div className="ls-md-table-wrap" tabIndex={0}>
            <table>{children}</table>
          </div>
        );
      },
      p({ children }) {
        return <p>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</p>;
      },
      li({ children }) {
        return <li>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</li>;
      },
      h1({ children }) {
        return <h1>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</h1>;
      },
      h2({ children }) {
        return <h2>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</h2>;
      },
      h3({ children }) {
        return <h3>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</h3>;
      },
      h4({ children }) {
        return <h4>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</h4>;
      },
      td({ children }) {
        return <td>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</td>;
      },
      th({ children }) {
        return <th>{searchQuery ? highlightTextNodes(children, searchQuery) : children}</th>;
      },
    }),
    [computerKey, connection, cwd, onOpenImage, searchQuery, sessionId, streaming],
  );

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={safeMarkdownUrlTransform}
      components={components}
    >
      {block}
    </ReactMarkdown>
  );
});

export interface MarkdownViewProps {
  text: string;
  streaming?: boolean;
  computerKey?: string;
  connection?: Connection;
  sessionId?: string;
  cwd?: string;
  searchQuery?: string;
  onOpenImage?: (src: string, alt: string) => void;
}

export function MarkdownView({
  text,
  streaming = false,
  computerKey,
  connection,
  sessionId,
  cwd,
  searchQuery,
  onOpenImage,
}: MarkdownViewProps) {
  const smoothed = useSmoothText(text, streaming);
  const normalized = useMemo(() => normalizeMarkdownForDisplay(smoothed), [smoothed]);
  const blocks = useMemo(() => markdownBlocks(normalized), [normalized]);

  if (!smoothed) return null;

  return (
    <div className="ls-markdown">
      {blocks.map((block, index) => {
        const isTail = index === blocks.length - 1;
        return (
          <SingleMarkdownBlock
            key={index}
            block={block}
            streaming={streaming && isTail}
            computerKey={computerKey}
            connection={connection}
            sessionId={sessionId}
            cwd={cwd}
            searchQuery={searchQuery}
            onOpenImage={onOpenImage}
          />
        );
      })}
    </div>
  );
}
