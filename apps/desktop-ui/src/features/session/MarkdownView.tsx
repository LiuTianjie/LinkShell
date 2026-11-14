import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternalUrl } from "@/bridge/desktop-bridge";
import {
  markdownBlocks,
  renderHighlightedTokens,
  useHighlight,
  useSmoothText,
} from "@/core";
import { CopyButton } from "@/primitives";
import { openFileInInspector, resolveFileHrefTarget } from "./session-helpers";

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

interface MarkdownBlockProps {
  block: string;
  streaming: boolean;
  computerKey?: string;
  sessionId?: string;
  cwd?: string;
  searchQuery?: string;
}

const SingleMarkdownBlock = memo(function SingleMarkdownBlock({
  block,
  streaming,
  computerKey,
  sessionId,
  cwd,
  searchQuery,
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
        if (fileTarget && computerKey && (rawText.includes("/") || /\.[a-z]{1,6}(:\d+)?$/i.test(rawText))) {
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
    [computerKey, cwd, searchQuery, sessionId, streaming],
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
  sessionId?: string;
  cwd?: string;
  searchQuery?: string;
}

export function MarkdownView({
  text,
  streaming = false,
  computerKey,
  sessionId,
  cwd,
  searchQuery,
}: MarkdownViewProps) {
  const smoothed = useSmoothText(text, streaming);
  const blocks = useMemo(() => markdownBlocks(smoothed), [smoothed]);

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
            sessionId={sessionId}
            cwd={cwd}
            searchQuery={searchQuery}
          />
        );
      })}
    </div>
  );
}
