import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Download, Ellipsis, FilePen, LoaderCircle, RefreshCw, WrapText, X } from "lucide-react";
import type { MethodResult } from "@linkshell/wire";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorNotice, LoadState, baseName } from "./common";
import { FileEditor } from "./Editor";
import { formatFileSize } from "./file-content";
import { useFileDownload } from "./FileDownload";
import { grammarForPath, useHighlight, type HighlightToken } from "./highlight";
import { RichText } from "./Timeline";

type FileResult = MethodResult<"fs.read">;

/** What a file can be shown as, other than its source. */
function renderable(path: string, file: FileResult | undefined): "markdown" | "image" | undefined {
  if (file?.kind === "image") return "image";
  if (file?.kind === "text" && /\.(md|markdown|mdx)$/i.test(path)) return "markdown";
  return undefined;
}

/**
 * A file in the desktop's panels, as Codex's file preview: one 40 px bar (back, the name, how to
 * show it, the actions, the rest in a menu), then the file itself edge to edge: rendered when it
 * can be (Markdown, an image), else its source, numbered and coloured.
 */
export function DesktopFileView({
  path,
  line,
  close,
  onDirtyChange,
  content,
}: {
  path: string;
  line?: number;
  close?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  content: {
    loaded: { loading: boolean; error?: string; reload: () => void; value?: FileResult };
    file?: FileResult;
    more: () => void;
    job: { busy: boolean; error?: string; run: (task: () => Promise<void>) => Promise<void> };
  };
}) {
  const { loaded, file, more, job } = content;
  const download = useFileDownload(path);
  const [editing, setEditing] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState<"path" | "content">();
  const kind = renderable(path, file);
  // Shown as it reads whenever it can be; the source is one click away.
  const [source, setSource] = useState(false);
  const showSource = kind === "markdown" ? source : kind !== "image";
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (value: string, what: "path" | "content") =>
    void job.run(async () => {
      await navigator.clipboard.writeText(value);
      setCopied(what);
    });
  if (editing)
    return (
      <FileEditor
        key={path}
        path={path}
        onDirtyChange={onDirtyChange}
        close={() => {
          setEditing(false);
          loaded.reload();
        }}
      />
    );
  const facts = file
    ? `${formatFileSize(file.size)} · ${file.kind === "text" ? "文本" : file.kind === "image" ? "图片" : "二进制"}${line ? ` · 第 ${line} 行` : ""}`
    : "正在读取";
  return (
    <section className="file-preview" aria-label={baseName(path)} aria-busy={loaded.loading}>
      <header className="file-preview-bar">
        {close && (
          <Button variant="ghost" size="icon" onClick={close} title="返回文件列表" aria-label="返回文件列表">
            <ArrowLeft />
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="file-preview-name" tabIndex={0}>{baseName(path)}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all">{path} · {facts}</TooltipContent>
        </Tooltip>
        <span className="file-preview-spacer" />
        {kind === "markdown" && (
          <Tabs value={showSource ? "source" : "reading"} onValueChange={(value) => setSource(value === "source")}>
            <TabsList variant="line" aria-label="文件显示方式">
              <TabsTrigger value="reading">预览</TabsTrigger>
              <TabsTrigger value="source">源码</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {file?.kind === "text" && showSource && (
          <Button variant="ghost" size="icon" aria-pressed={wrap} title={wrap ? "不换行" : "自动换行"} aria-label="自动换行" onClick={() => setWrap(!wrap)}>
            <WrapText />
          </Button>
        )}
        {file?.kind === "text" && (
          <Button variant="ghost" size="icon" title={copied === "content" ? "已复制" : file.truncated ? "复制已加载内容" : "复制内容"} aria-label="复制内容" disabled={job.busy} onClick={() => copy(file.text ?? "", "content")}>
            {copied === "content" ? <Check /> : <Copy />}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="更多文件操作" title="更多">
              {download.busy ? <LoaderCircle className="animate-spin" /> : <Ellipsis />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {file?.kind === "text" && !file.truncated && (
              <DropdownMenuItem onSelect={() => setEditing(true)}><FilePen />AI 编辑</DropdownMenuItem>
            )}
            {download.busy
              ? <DropdownMenuItem onSelect={download.cancel}><X />取消下载 · {download.status}</DropdownMenuItem>
              : <DropdownMenuItem onSelect={() => void download.save()}><Download />下载到这台电脑</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => copy(path, "path")}><Copy />{copied === "path" ? "路径已复制" : "复制路径"}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={loaded.loading || job.busy} onSelect={loaded.reload}><RefreshCw />重新读取</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {!download.busy && download.status && <p className="file-preview-note" role="status">{download.status}</p>}
      <ErrorNotice error={job.error || download.error || undefined} />
      <LoadState {...loaded} />
      {loaded.error && <Button variant="outline" size="sm" className="self-start" onClick={loaded.reload}>重新读取</Button>}
      {file && (
        <div className="file-preview-body">
          {file.kind === "image" ? (
            <div className="file-preview-image">
              <img src={`data:${file.mimeType};base64,${file.data}`} alt={baseName(path)} />
            </div>
          ) : file.kind === "text" ? (
            !file.text ? (
              <EmptyState title="这是一个空文件" description="文件中还没有文本内容。" />
            ) : kind === "markdown" && !showSource ? (
              <div className="file-preview-markdown"><RichText text={file.text} /></div>
            ) : (
              <SourceView text={file.text} path={path} line={line} wrap={wrap} />
            )
          ) : (
            <EmptyState title="此文件暂不支持预览" description="可以下载到这台电脑，再用支持此格式的应用打开。" />
          )}
          {file.nextOffset !== undefined && (
            <div className="file-preview-more">
              <span>已加载 {formatFileSize(file.nextOffset)} / {formatFileSize(file.size)}</span>
              <Button variant="ghost" size="sm" disabled={job.busy} onClick={more}>
                {job.busy && <LoaderCircle className="animate-spin" data-icon="inline-start" />}
                {job.busy ? "正在读取…" : "加载更多"}
              </Button>
            </div>
          )}
        </div>
      )}
      <span className="sr-only" role="status">{copied ? "已复制到剪贴板" : ""}</span>
    </section>
  );
}

/** Source as the editor shows it: a number gutter, the grammar's colours, the asked-for line marked. */
function SourceView({ text, path, line, wrap }: { text: string; path: string; line?: number; wrap: boolean }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const tokens = useHighlight(lines.join("\n"), grammarForPath(path));
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [line, path]);
  return (
    <div className={cn("file-preview-source", wrap && "file-preview-source-wrap")} tabIndex={0} role="region" aria-label="文件源码" style={{ "--gutter-digits": String(lines.length).length } as React.CSSProperties}>
      {lines.map((content, index) => (
        <div key={index} className="file-preview-line" data-target={index + 1 === line || undefined} ref={index + 1 === line ? target : undefined}>
          <span className="file-preview-number" aria-hidden>{index + 1}</span>
          <code><Line text={content} tokens={tokens?.[index]} /></code>
        </div>
      ))}
    </div>
  );
}

function Line({ text, tokens }: { text: string; tokens?: HighlightToken[] }) {
  if (!text) return " ";
  // Tokens that don't spell the line (a grammar that skipped a pattern) would show the wrong text.
  if (!tokens || tokens.map((token) => token.content).join("") !== text) return text;
  return tokens.map((token, at) => (token.color ? <span key={at} style={{ color: token.color }}>{token.content}</span> : token.content));
}
