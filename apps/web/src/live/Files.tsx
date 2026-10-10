import { useDialogs } from "@/components/Dialogs";
import { useEffect, useRef, useState } from "react";
import type { MethodResult } from "@linkshell/wire";
import {
  ErrorNotice,
  LoadState,
  baseName,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { Icon } from "../icons";
import { FileEditor } from "./Editor";

export async function fileBase64(file: File): Promise<string> {
  if (file.size > 30 * 1024 * 1024) throw new Error(`${file.name} 超过 30 MB`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}
export function FileView({ path, line }: { path: string; line?: number }) {
  const lineRef = useRef<HTMLSpanElement>(null);
  const { link } = useConnection();
  const job = useJob();
  const [editing, setEditing] = useState(false);
  const loaded = useLoad(() => link.call("fs.read", { path }), [link, path]);
  const [extra, setExtra] = useState<{
    path: string;
    text: string;
    next?: number;
  }>();
  const file = loaded.value;
  const current = extra?.path === path ? extra : undefined;
  useEffect(() => {
    lineRef.current?.scrollIntoView({ block: "center" });
  }, [path, line, file, current]);
  if (editing) return <FileEditor key={path} path={path} close={() => { setEditing(false); loaded.reload(); }} />;
  return (
    <div className="file-reader">
      <LoadState {...loaded} />
      <ErrorNotice error={job.error} />
      {file && (
        <>
          <div className="reader-meta">
            <strong>{baseName(path)}</strong>
            <span>{Math.ceil(file.size / 1024)} KB</span>
            {file.kind === "text" && !file.truncated && <button className="text-button" onClick={() => setEditing(true)}>AI 编辑建议</button>}
          </div>
          {file.kind === "image" ? (
            <img
              className="file-image"
              src={`data:${file.mimeType};base64,${file.data}`}
              alt={baseName(path)}
            />
          ) : file.kind === "text" ? (
            <>
              <pre className="source-code">
                {line ? (
                  ((file.text ?? "") + (current?.text ?? ""))
                    .split("\n")
                    .map((text, index) => (
                      <span
                        key={index}
                        ref={index + 1 === line ? lineRef : undefined}
                        className={
                          index + 1 === line ? "file-highlight-line" : undefined
                        }
                      >
                        {text}
                        {"\n"}
                      </span>
                    ))
                ) : (
                  <>
                    {file.text}
                    {current?.text}
                  </>
                )}
              </pre>
              {(current ? current.next : file.nextOffset) !== undefined && (
                <button
                  className="button secondary"
                  disabled={job.busy}
                  onClick={() =>
                    void job.run(async () => {
                      const chunk = await link.call("fs.read", {
                        path,
                        offset: current ? current.next : file.nextOffset,
                      });
                      setExtra({
                        path,
                        text: (current?.text ?? "") + (chunk.text ?? ""),
                        next: chunk.nextOffset,
                      });
                    })
                  }
                >
                  加载下一部分
                </button>
              )}
            </>
          ) : (
            <p className="muted">二进制文件 · App 和网页都不直接显示内容。</p>
          )}
        </>
      )}
    </div>
  );
}
export function Files({
  start,
  onPick,
  directoriesOnly = false,
}: {
  start?: string;
  onPick?: (path: string) => void;
  directoriesOnly?: boolean;
}) {
  const dialogs = useDialogs();
  const { link } = useConnection();
  const [path, setPath] = useState(start);
  const [hidden, setHidden] = useState(false);
  const [file, setFile] = useState<string>();
  const [query, setQuery] = useState("");
  const job = useJob();
  const loaded = useLoad(
    () => link.call("fs.list", { path, hidden, files: !directoriesOnly }),
    [link, path, hidden],
  );
  const [results, setResults] = useState<MethodResult<"fs.search">>();
  const entries =
    query && results ? results.entries : (loaded.value?.entries ?? []);
  return (
    <div className="file-browser">
      <div className="browser-toolbar">
        <button
          className="button secondary"
          disabled={!loaded.value?.parent}
          onClick={() => {
            setFile(undefined);
            setPath(loaded.value?.parent);
            setQuery("");
          }}
        >
          上一级
        </button>
        <span className="path-label">
          {loaded.value?.path ?? path ?? "主目录"}
        </span>
        <label>
          <input
            type="checkbox"
            checked={hidden}
            onChange={(event) => setHidden(event.target.checked)}
          />
          隐藏文件
        </label>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim())
            void job.run(async () =>
              setResults(await link.call("fs.search", { query: query.trim() })),
            );
        }}
      >
        <input
          aria-label="搜索远程目录"
          placeholder="搜索目录"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setResults(undefined);
          }}
        />
        <button className="button secondary" disabled={job.busy}>
          搜索
        </button>
      </form>
      <LoadState {...loaded} />
      <ErrorNotice error={job.error} />
      <div className="file-browser-layout">
        <div className="remote-file-list">
          {entries.map((entry) => (
            <button
              key={entry.path}
              className={file === entry.path ? "selected" : ""}
              onClick={() => {
                if (entry.file) setFile(entry.path);
                else {
                  setPath(entry.path);
                  setQuery("");
                  setFile(undefined);
                }
              }}
            >
              <Icon name={entry.file ? "file" : "folder"} size={17} />
              <span>{entry.name}</span>
              {entry.size !== undefined && (
                <small>{Math.ceil(entry.size / 1024)} KB</small>
              )}
            </button>
          ))}
          {!loaded.loading && entries.length === 0 && (
            <p className="muted">此目录为空</p>
          )}
          {(loaded.value?.truncated || results?.truncated) && (
            <p className="muted">结果较多，请缩小搜索范围。</p>
          )}
        </div>
        {file && <FileView key={file} path={file} />}
      </div>
      {directoriesOnly ? (
        <button
          className="button primary"
          disabled={!loaded.value}
          onClick={() => {
            if (loaded.value) onPick?.(loaded.value.path);
          }}
        >
          选择此目录
        </button>
      ) : (
        <div className="file-actions">
          <label className="button secondary">
            上传文件
            <input
              type="file"
              multiple
              hidden
              disabled={job.busy || !loaded.value}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void job.run(async () => {
                  for (const file of files)
                    await link.call(
                      "fs.upload",
                      {
                        dir: loaded.value!.path,
                        name: file.name,
                        data: await fileBase64(file),
                      },
                      180000,
                    );
                  loaded.reload();
                });
              }}
            />
          </label>
          <button
            className="button secondary"
            disabled={job.busy || !loaded.value}
            onClick={async () => {
              const name = await dialogs.prompt("新目录名称");
              if (name?.trim())
                void job.run(async () => {
                  await link.call("fs.mkdir", {
                    parent: loaded.value!.path,
                    name: name.trim(),
                  });
                  loaded.reload();
                });
            }}
          >
            新建目录
          </button>
          <button className="text-button" onClick={loaded.reload}>
            刷新
          </button>
        </div>
      )}
    </div>
  );
}
