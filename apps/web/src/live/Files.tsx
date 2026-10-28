import { FilePicker } from "@/components/FilePicker";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RichText, TimelineNavigation } from "./Timeline";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "@/components/ui/input-group";
import { useDialogs } from "@/components/Dialogs";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderPlus,
  FolderOpen,
  Home,
  LoaderCircle,
  RefreshCw,
  Search,
  Upload,
  WrapText,
  X,
  Ellipsis,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/PageHeader";
import { isDesktop } from "./desktop";
import type { MethodResult } from "@linkshell/wire";
import { cn } from "@/lib/utils";
import {
  ErrorNotice,
  EmptyState,
  LoadState,
  baseName,
  messageOf,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { FileEditor } from "./Editor";
import { FileDownload } from "./FileDownload";
import { DesktopFileView } from "./FilePreview";
import {
  appendFileChunk,
  formatFileSize,
  readFileAtLine,
  splitFileAtLine,
} from "./file-content";

export async function fileBase64(file: File): Promise<string> {
  if (file.size > 30_000_000) throw new Error(`${file.name} 超过 30 MB`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

/** A file's content as read so far, more on request, and the requested line split out. */
function useFileContent(path: string, line: number | undefined) {
  const { link } = useConnection();
  const job = useJob();
  const loaded = useLoad(
    () =>
      readFileAtLine((offset) => link.call("fs.read", { path, offset }), line),
    [link, path, line],
  );
  const [extra, setExtra] = useState<{
    source: MethodResult<"fs.read">;
    file: MethodResult<"fs.read">;
  }>();
  const file =
    extra && extra.source === loaded.value ? extra.file : loaded.value;
  const highlighted = useMemo(
    () => (line && file?.text ? splitFileAtLine(file.text, line) : undefined),
    [file?.text, line],
  );
  const more = () =>
    void job.run(async () => {
      if (!file || file.nextOffset === undefined) return;
      const chunk = await link.call("fs.read", { path, offset: file.nextOffset });
      setExtra({ source: loaded.value!, file: appendFileChunk(file, chunk) });
    });
  return { loaded, file, highlighted, more, job };
}

export function FileView(props: {
  path: string;
  line?: number;
  close?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return isDesktop ? <DesktopFile {...props} /> : <WebFileView {...props} />;
}

function DesktopFile(props: {
  path: string;
  line?: number;
  close?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const content = useFileContent(props.path, props.line);
  return <DesktopFileView {...props} content={content} />;
}

function WebFileView({
  path,
  line,
  close,
  onDirtyChange,
}: {
  path: string;
  line?: number;
  close?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const lineRef = useRef<HTMLSpanElement>(null);
  const { loaded, file, highlighted, more, job } = useFileContent(path, line);
  const [editing, setEditing] = useState(false);
  const [wrap, setWrap] = useState(false);
  const markdown = /\.(md|markdown)$/i.test(path);
  const [reading, setReading] = useState(markdown && !line);
  const [copied, setCopied] = useState<"path" | "content">();
  useEffect(() => {
    lineRef.current?.scrollIntoView({ block: "center" });
  }, [path, line, loaded.value]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  function copy(value: string, kind: "path" | "content") {
    void job.run(async () => {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    });
  }
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
  return (
    <section
      className="file-reader resource-reader"
      aria-label={baseName(path)}
      aria-busy={loaded.loading}
    >
      <header className="resource-reader-heading">
        <div className="resource-file-title">
          {close && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={close}
              title="返回文件列表"
              aria-label="返回文件列表"
            >
              <ArrowLeft />
            </Button>
          )}
          <File aria-hidden="true" />
          <div>
            <strong title={path}>{baseName(path)}</strong>
            <span>
              {file
                ? `${formatFileSize(file.size)} · ${file.kind === "text" ? "文本文件" : file.kind === "image" ? "图片" : "二进制文件"}`
                : "读取文件"}
              {line ? ` · 第 ${line} 行` : ""}
            </span>
          </div>
        </div>
        <div className="resource-inline-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            title={copied === "path" ? "路径已复制" : "复制文件路径"}
            aria-label={copied === "path" ? "路径已复制" : "复制文件路径"}
            onClick={() => copy(path, "path")}
          >
            {copied === "path" ? <Check /> : <Copy />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={loaded.loading || job.busy}
            title="重新读取文件"
            aria-label="重新读取文件"
            onClick={loaded.reload}
          >
            <RefreshCw />
          </Button>
        </div>
      </header>
      <p className="resource-path" title={path}>
        {path}
      </p>
      <LoadState {...loaded} />
      <FileDownload key={path} path={path} />
      {loaded.error && (
        <Button variant="outline" size="sm" onClick={loaded.reload}>
          重新读取
        </Button>
      )}
      <ErrorNotice error={job.error} />
      {file && (
        <>
          {file.kind === "text" && (
            <div className="resource-reader-tools">
              {markdown && (
                <Tabs
                  value={reading ? "reading" : "source"}
                  onValueChange={(value) => setReading(value === "reading")}
                >
                  <TabsList variant="line" aria-label="文件显示方式">
                    <TabsTrigger value="reading">阅读</TabsTrigger>
                    <TabsTrigger value="source">源码</TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              <Button
                variant={wrap ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={wrap}
                disabled={reading}
                onClick={() => setWrap(!wrap)}
              >
                <WrapText data-icon="inline-start" />
                自动换行
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={job.busy}
                onClick={() => copy(file.text ?? "", "content")}
              >
                {copied === "content" ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <Copy data-icon="inline-start" />
                )}
                {copied === "content"
                  ? "已复制"
                  : file.truncated
                    ? "复制已加载内容"
                    : "复制内容"}
              </Button>
              {!file.truncated && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  AI 编辑
                </Button>
              )}
            </div>
          )}
          {file.kind === "image" ? (
            <div className="resource-image-stage">
              <img
                className="file-image"
                src={`data:${file.mimeType};base64,${file.data}`}
                alt={baseName(path)}
              />
            </div>
          ) : file.kind === "text" ? (
            <>
              {file.text && reading ? (
                <div className="resource-markdown">
                  <RichText text={file.text} />
                </div>
              ) : file.text ? (
                <pre
                  className={cn(
                    "source-code resource-source",
                    wrap && "resource-source-wrap",
                  )}
                  tabIndex={0}
                  aria-label="文件内容"
                >
                  <code>
                    {highlighted ? (
                      <>
                        {highlighted.before}
                        <span ref={lineRef} className="file-highlight-line">
                          {highlighted.target || "\u200b"}
                        </span>
                        {highlighted.after}
                      </>
                    ) : (
                      file.text
                    )}
                  </code>
                </pre>
              ) : (
                <EmptyState
                  title="这是一个空文件"
                  description="文件中还没有文本内容。"
                />
              )}
              {line && !highlighted && !file.truncated && (
                <p className="resource-caption" role="status">
                  文件不足 {line} 行，已显示全部内容。
                </p>
              )}
              {file.nextOffset !== undefined && (
                <div className="resource-pagination">
                  <span className="resource-caption">
                    已加载 {formatFileSize(file.nextOffset)} /{" "}
                    {formatFileSize(file.size)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={job.busy}
                    onClick={more}
                  >
                    {job.busy && (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    )}
                    {job.busy ? "正在读取…" : "加载更多内容"}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              title="此文件暂不支持预览"
              description="可以下载到本地，再用支持此格式的应用打开。"
            />
          )}
          <p className="resource-caption resource-reader-footer">
            {file.modifiedAt
              ? `修改于 ${new Date(file.modifiedAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}`
              : "内容来自已连接的电脑"}
          </p>
        </>
      )}
      <span className="sr-only" role="status">
        {copied ? "已复制到剪贴板" : ""}
      </span>
    </section>
  );
}

export function Files({
  start,
  onPick,
  onDirtyChange,
  directoriesOnly = false,
  page = false,
}: {
  start?: string;
  onPick?: (path: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  directoriesOnly?: boolean;
  /** The 文件 page itself (it has a toolbar), rather than a panel or a picker. */
  page?: boolean;
}) {
  const dialogs = useDialogs();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const { link } = useConnection();
  const [path, setPath] = useState(start);
  const [hidden, setHidden] = useState(false);
  const [file, setFile] = useState<string>();
  const [fileLine, setFileLine] = useState<number>();
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const lastFileButton = useRef<HTMLButtonElement>(null);
  const directoryRef = useRef<HTMLDivElement>(null);
  const focusDirectory = useRef(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [notice, setNotice] = useState("");
  const [upload, setUpload] = useState<{
    done: number;
    total: number;
    name: string;
  }>();
  const job = useJob();
  const loaded = useLoad(
    () => link.call("fs.list", { path, hidden, files: !directoriesOnly }),
    [link, path, hidden, directoriesOnly],
  );
  const search = useLoad(
    () =>
      submitted
        ? link.call("fs.search", { query: submitted })
        : Promise.resolve(undefined),
    [link, submitted],
  );
  const active = submitted ? search : loaded;
  const entries = active.value?.entries ?? [];
  const currentPath = loaded.value?.path ?? path ?? "主目录";
  useEffect(() => {
    if (loaded.loading || !loaded.value || !focusDirectory.current) return;
    focusDirectory.current = false;
    const first = directoryRef.current?.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    (first ?? directoryRef.current)?.focus();
  }, [loaded.loading, loaded.value]);
  async function allowNavigation() {
    return (
      !dirty ||
      (await dialogs.confirm("文件还有未保存的修改。放弃修改并离开编辑器？"))
    );
  }
  async function navigate(next?: string) {
    if (!(await allowNavigation())) return;
    focusDirectory.current = true;
    setDirty(false);
    setFile(undefined);
    setPath(next);
    setQuery("");
    setSubmitted("");
    setNotice("");
    job.clear();
  }
  async function selectFile(next?: string, line?: number) {
    if (!(await allowNavigation())) return;
    setDirty(false);
    setFile(next);
    setFileLine(line);
    if (!next) requestAnimationFrame(() => lastFileButton.current?.focus());
  }
  const changeable = !job.busy && !!loaded.value && !loaded.loading && !submitted;
  function uploadFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    const dir = loaded.value?.path;
    if (!dir || !files.length) return;
    setNotice("");
    void job.run(async () => {
      for (const candidate of files)
        if (candidate.size > 30_000_000)
          throw new Error(`${candidate.name} 超过 30 MB，尚未上传任何文件。`);
      let done = 0;
      try {
        for (const candidate of files) {
          setUpload({ done, total: files.length, name: candidate.name });
          await link.call(
            "fs.upload",
            { dir, name: candidate.name, data: await fileBase64(candidate) },
            180000,
          );
          done++;
        }
        setNotice(`已上传 ${done} 个文件。同名文件已自动编号，原文件不会被覆盖。`);
      } catch (error) {
        throw new Error(
          `${done ? `已上传 ${done} / ${files.length} 个文件。` : ""}${messageOf(error)}`,
          { cause: error },
        );
      } finally {
        setUpload(undefined);
        if (done) loaded.reload();
      }
    });
  }
  async function makeDirectory() {
    const parent = loaded.value?.path;
    const name = await dialogs.prompt("新目录名称");
    if (!parent || !name?.trim()) return;
    void job.run(async () => {
      const value = name.trim();
      if (value === "." || value === ".." || /[/\\\0]/.test(value) || value.length > 255)
        throw new Error("请输入有效的目录名称，不要包含斜杠，最多 255 个字符。");
      await link.call("fs.mkdir", { parent, name: value });
      setNotice(`已创建目录“${value}”`);
      loaded.reload();
    });
  }
  async function goTo() {
    const next = await dialogs.prompt("输入要打开的目录路径", loaded.value?.path ?? path ?? "", "打开目录");
    if (next?.trim()) void navigate(next.trim());
  }
  function submitSearch() {
    if (!query.trim()) return;
    setSubmitted(query.trim());
    if (submitted === query.trim()) search.reload();
  }
  const clearSearch = () => {
    setQuery("");
    setSubmitted("");
  };
  const summary = submitted
    ? `“${submitted}”的目录结果`
    : `${entries.length}${loaded.value?.truncated ? "+" : ""} 个${directoriesOnly ? "目录" : "项目"}`;
  // The desktop puts where you are and what you can do in one toolbar row, as Codex's file pages:
  // the page's own toolbar, or in the inspector a compact bar with the rest in a menu.
  const desktopLayout = isDesktop && !directoriesOnly;
  const upward = (
    <>
      <Button
        variant="ghost"
        size="icon"
        disabled={job.busy || loaded.loading}
        title="主目录"
        aria-label="前往主目录"
        onClick={() => void navigate()}
      >
        <Home />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={job.busy || !loaded.value?.parent}
        title="上一级目录"
        aria-label="前往上一级目录"
        onClick={() => void navigate(loaded.value?.parent)}
      >
        <ArrowUp />
      </Button>
    </>
  );
  const refresh = (
    <Button
      variant="ghost"
      size="icon"
      disabled={active.loading || job.busy}
      title="刷新目录"
      aria-label="刷新目录"
      onClick={active.reload}
    >
      <RefreshCw />
    </Button>
  );
  const searchField = (
    <form
      className="resource-search"
      onSubmit={(event) => {
        event.preventDefault();
        submitSearch();
      }}
    >
      <InputGroup className="page-search">
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="搜索电脑上的目录"
          placeholder="搜索目录"
          maxLength={200}
          autoFocus={!page}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setSubmitted("");
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            clearSearch();
            if (!page) setSearching(false);
          }}
        />
        {query && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" title="清空搜索" aria-label="清空搜索" onClick={clearSearch}>
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </form>
  );
  const uploadInput = (
    <input
      ref={uploadRef}
      type="file"
      multiple
      hidden
      tabIndex={-1}
      onChange={(event) => {
        const list = event.target.files;
        uploadFiles(list);
        event.target.value = "";
      }}
    />
  );
  const chooseUpload = () => {
    if (!uploadRef.current) return;
    // Selecting the same file again must still trigger a failed upload's retry.
    uploadRef.current.value = "";
    uploadRef.current.click();
  };
  const hiddenToggle = (
    <Label className="resource-hidden-toggle">
      <Checkbox checked={hidden} onCheckedChange={(checked) => setHidden(checked === true)} />
      显示隐藏项目
    </Label>
  );
  return (
    <section
      className={cn(
        "file-browser resource-files",
        file && "resource-has-preview",
      )}
      data-layout={desktopLayout ? (page ? "page" : "panel") : undefined}
      aria-label={directoriesOnly ? "选择目录" : "文件浏览器"}
    >
      {desktopLayout && uploadInput}
      {desktopLayout && page && (
        <PageHeader
          leading={<span className="resource-toolbar-nav">{upward}</span>}
          title={<span title={currentPath}>{baseName(currentPath) || "根目录"}</span>}
          detail={<span className="resource-toolbar-path" title={currentPath}>{currentPath}</span>}
          actions={<>
            {searchField}
            <Button variant="ghost" size="icon" title="前往目录" aria-label="前往目录" disabled={job.busy} onClick={() => void goTo()}>
              <FolderOpen />
            </Button>
            {refresh}
            <Button variant="ghost" size="sm" disabled={!changeable} onClick={() => void makeDirectory()}>
              <FolderPlus data-icon="inline-start" />新建目录
            </Button>
            <Button size="sm" disabled={!changeable} title="单个文件最大 30 MB" onClick={chooseUpload}>
              <Upload data-icon="inline-start" />上传文件
            </Button>
          </>}
        />
      )}
      {desktopLayout && !page && (
        <>
          <div className="resource-toolbar">
            {upward}
            <span className="resource-toolbar-name" title={currentPath}>{baseName(currentPath) || "根目录"}</span>
            <Button
              variant="ghost"
              size="icon"
              title="搜索目录"
              aria-label="搜索目录"
              aria-pressed={searching}
              onClick={() => {
                if (searching) clearSearch();
                setSearching(!searching);
              }}
            >
              <Search />
            </Button>
            {refresh}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" title="更多" aria-label="更多文件操作">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!changeable} onSelect={chooseUpload}><Upload />上传文件</DropdownMenuItem>
                <DropdownMenuItem disabled={!changeable} onSelect={() => void makeDirectory()}><FolderPlus />新建目录</DropdownMenuItem>
                <DropdownMenuItem disabled={job.busy} onSelect={() => void goTo()}><FolderOpen />前往目录…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={hidden} onCheckedChange={(checked) => setHidden(checked === true)}>
                  显示隐藏项目
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {searching && searchField}
        </>
      )}
      {!desktopLayout && (
      <div className="resource-browser-controls">
        <div className="resource-location-bar">
          <Button
            variant="outline"
            size="icon"
            disabled={job.busy || loaded.loading}
            title="主目录"
            aria-label="前往主目录"
            onClick={() => void navigate()}
          >
            <Home />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={job.busy || !loaded.value?.parent}
            title="上一级目录"
            aria-label="前往上一级目录"
            onClick={() => void navigate(loaded.value?.parent)}
          >
            <ArrowUp />
          </Button>
          <div className="resource-location">
            <strong>{baseName(currentPath) || "根目录"}</strong>
            <span title={currentPath}>{currentPath}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            title="前往目录"
            aria-label="前往目录"
            disabled={job.busy}
            onClick={() => void goTo()}
          >
            <FolderOpen />
          </Button>
          {refresh}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel className="sr-only">搜索电脑上的目录</FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label="搜索电脑上的目录"
                  placeholder="搜索电脑上的目录…"
                  maxLength={200}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    if (!event.target.value) setSubmitted("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") clearSearch();
                  }}
                />
                <InputGroupAddon align="inline-end">
                  {query && (
                    <InputGroupButton
                      size="icon-xs"
                      title="清空搜索"
                      aria-label="清空搜索"
                      onClick={clearSearch}
                    >
                      <X />
                    </InputGroupButton>
                  )}
                  <InputGroupButton
                    type="submit"
                    variant="secondary"
                    disabled={!query.trim() || (search.loading && !!submitted)}
                  >
                    搜索
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
        </form>
        <div className="resource-directory-summary">
          <span>{summary}</span>
          {submitted ? (
            <Button variant="link" size="sm" onClick={clearSearch}>
              返回当前目录
            </Button>
          ) : (
            hiddenToggle
          )}
        </div>
      </div>
      )}
      {directoriesOnly ? (
        <div className="resource-picker-footer">
          <p className="resource-path" title={currentPath}>
            将使用：{currentPath}
          </p>
          <Button
            disabled={!loaded.value || loaded.loading || !!submitted}
            onClick={() => {
              if (loaded.value) onPick?.(loaded.value.path);
            }}
          >
            选择此目录
          </Button>
        </div>
      ) : desktopLayout ? null : (
        <div className="resource-files-footer">
          <div className="resource-inline-actions">
            <FilePicker
              multiple
              disabled={!changeable}
              onChange={(event) => {
                const list = event.target.files;
                uploadFiles(list);
                event.target.value = "";
              }}
            >
              上传文件
            </FilePicker>
            <Button variant="outline" disabled={!changeable} onClick={() => void makeDirectory()}>
              <FolderPlus data-icon="inline-start" />
              新建目录
            </Button>
          </div>
          <span className="resource-caption">单个文件最大 30 MB</span>
        </div>
      )}
      <ErrorNotice error={job.error} />
      {notice && (
        <Alert role="status">
          <Check />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {upload && (
        <Alert role="status">
          <LoaderCircle className="animate-spin" />
          <AlertDescription>
            正在上传 {upload.done + 1} / {upload.total}：{upload.name}
          </AlertDescription>
        </Alert>
      )}
      <div className="resource-file-layout">
        <div
          className="resource-directory"
          ref={directoryRef}
          tabIndex={-1}
          aria-busy={active.loading}
        >
          <LoadState {...active} />
          {active.error && (
            <Button variant="outline" size="sm" onClick={active.reload}>
              重新{submitted ? "搜索" : "加载"}
            </Button>
          )}
          {!active.loading && !active.error && (
            <>
              <div
                className="resource-entry-list"
                aria-label={submitted ? "目录搜索结果" : "目录内容"}
                onKeyDown={(event) => {
                  if (
                    !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                      event.key,
                    ) ||
                    event.altKey ||
                    event.metaKey ||
                    event.ctrlKey
                  )
                    return;
                  const buttons = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ),
                  ];
                  const current = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  if (current < 0) return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : Math.max(
                            0,
                            Math.min(
                              buttons.length - 1,
                              current + (event.key === "ArrowDown" ? 1 : -1),
                            ),
                          );
                  buttons[next]?.focus();
                }}
              >
                {entries.map((entry) => (
                  <Button
                    variant={file === entry.path ? "secondary" : "ghost"}
                    key={entry.path}
                    className="resource-entry h-10 gap-2.5 rounded-none px-2"
                    aria-current={file === entry.path ? "true" : undefined}
                    title={entry.path}
                    disabled={job.busy}
                    onClick={(event) => {
                      if (entry.file)
                        lastFileButton.current = event.currentTarget;
                      void (entry.file
                        ? selectFile(entry.path)
                        : navigate(entry.path));
                    }}
                  >
                    {entry.file ? (
                      <File data-icon="inline-start" />
                    ) : (
                      <Folder data-icon="inline-start" />
                    )}
                    <span className="resource-entry-main">
                      <span className="resource-entry-name">{entry.name}</span>
                      {submitted && (
                        <span className="resource-entry-path">
                          {entry.path}
                        </span>
                      )}
                    </span>
                    {entry.project ? (
                      <Badge variant="secondary">项目</Badge>
                    ) : entry.size !== undefined ? (
                      <span className="resource-entry-size">
                        {formatFileSize(entry.size)}
                      </span>
                    ) : null}
                    {!entry.file && <ChevronRight data-icon="inline-end" />}
                  </Button>
                ))}
              </div>
              {entries.length === 0 && (
                <EmptyState
                  title={
                    submitted
                      ? "没有找到匹配的目录"
                      : directoriesOnly
                        ? "没有可选的子目录"
                        : "这个目录是空的"
                  }
                  description={
                    submitted
                      ? "试试更短的目录名，搜索范围为电脑的主目录。"
                      : directoriesOnly
                        ? "可以选择当前目录，或返回上一级继续浏览。"
                        : "上传文件或新建目录，开始整理这个位置。"
                  }
                />
              )}
              {desktopLayout && entries.length > 0 && (
                <p className="resource-list-foot">
                  <span>{summary}</span>
                  {submitted ? (
                    <Button variant="link" size="sm" onClick={clearSearch}>返回当前目录</Button>
                  ) : page ? hiddenToggle : null}
                </p>
              )}
              {active.value?.truncated && (
                <p className="resource-caption resource-results-note">
                  结果较多，仅显示前 {entries.length}{" "}
                  项。请使用更具体的目录名搜索。
                </p>
              )}
            </>
          )}
        </div>
        {file && (
          <TimelineNavigation.Provider
            value={{
              cwd: file.slice(0, file.lastIndexOf("/")) || "/",
              open: (next, line) => void selectFile(next, line),
            }}
          >
            <FileView
              key={`${file}:${fileLine ?? ""}`}
              path={file}
              line={fileLine}
              close={() => void selectFile()}
              onDirtyChange={setDirty}
            />
          </TimelineNavigation.Provider>
        )}
      </div>
    </section>
  );
}
