import { Choice } from "@/components/Choice";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  ArrowLeft,
  Check,
  FileCode,
  LoaderCircle,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EditorResult, EditSuggestion } from "@linkshell/wire";
import { useDialogs } from "@/components/Dialogs";
import {
  ErrorNotice,
  EmptyState,
  baseName,
  useClient,
  useConnection,
  useJob,
} from "./common";
import { AgentInteractions } from "./Acp";
import { Diff } from "./Timeline";
import { formatFileSize } from "./file-content";
import { registerUnsavedWork } from "./unsaved-work";

export function FileEditor({
  path,
  close,
  onDirtyChange,
}: {
  path: string;
  close(): void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { link } = useConnection();
  const dialogs = useDialogs();
  const job = useJob();
  const agents = useClient((state) => state.machine?.agents);
  const available =
    agents?.filter((entry) => entry.installed && entry.capabilities.acp) ?? [];
  const [choice, setChoice] = useState("");
  const agent = choice || available[0]?.id || "";
  const [editor, setEditor] = useState<EditorResult>();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [suggestions, setSuggestions] = useState<EditSuggestion[]>();
  const [preview, setPreview] = useState<EditorResult["preview"]>();
  const [operation, setOperation] = useState("");
  const [notice, setNotice] = useState("");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const field = useRef<HTMLTextAreaElement>(null);
  const active = useRef<{ agent: string; id: string } | undefined>(undefined);
  const mounted = useRef(true);
  const dirty = text !== saved;
  const bytes = new TextEncoder().encode(text).byteLength;
  const oversized = bytes > 262_144;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const unregister = registerUnsavedWork();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = active.current;
      if (current)
        void link
          .call("agents.editor", {
            agent: current.agent,
            operation: "close",
            editorId: current.id,
          })
          .catch(() => {});
    };
  }, [link]);
  async function run(label: string, action: () => Promise<void>) {
    await job.run(async () => {
      setOperation(label);
      setNotice("");
      try {
        await action();
      } finally {
        setOperation("");
      }
    });
  }
  async function save() {
    if (!editor || oversized) return;
    const result = await link.call("agents.editor", {
      agent,
      editorId: editor.editorId,
      operation: "save",
      text,
    });
    setEditor((current) => ({ ...current, ...result }));
    setSaved(text);
    setNotice("修改已保存到电脑");
  }
  async function requestClose() {
    if (!dirty) {
      close();
      return;
    }
    const answer = await dialogs.choose(
      "文件还有未保存的修改，返回前如何处理？",
      [
        { value: "save", label: "保存并返回" },
        { value: "discard", label: "放弃修改", destructive: true },
      ],
    );
    if (answer === "discard") close();
    if (answer === "save") {
      if (oversized) {
        await dialogs.alert("内容超过 256 KB，请减少内容后再保存。");
        return;
      }
      await run("正在保存…", async () => {
        await save();
        close();
      });
    }
  }
  const open = async () => {
    setChoice(agent);
    const result = await link.call(
      "agents.editor",
      {
        agent,
        operation: "open",
        path,
        cwd: path.slice(0, path.lastIndexOf("/")) || "/",
      },
      60_000,
    );
    if (!mounted.current) {
      if (result.editorId)
        await link.call("agents.editor", {
          agent,
          operation: "close",
          editorId: result.editorId,
        });
      return;
    }
    if (!result.editorId) throw new Error("Agent 未返回编辑会话，请重试。");
    active.current = { agent, id: result.editorId };
    setEditor(result);
    setText(result.text ?? "");
    setSaved(result.text ?? "");
    requestAnimationFrame(() => field.current?.focus());
  };
  return (
    <section
      className="acp-editor resource-editor"
      aria-label="AI 文件编辑器"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          if (editor && dirty && !job.busy && !oversized)
            void run("正在保存…", save);
        }
      }}
    >
      <header className="resource-reader-heading">
        <div className="resource-file-title">
          <FileCode aria-hidden="true" />
          <div>
            <strong title={editor?.path ?? path}>
              {baseName(editor?.path ?? path)}
            </strong>
            <span>AI 编辑</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={job.busy}
          onClick={() => void requestClose()}
        >
          <ArrowLeft data-icon="inline-start" />
          返回阅读
        </Button>
      </header>
      <p className="resource-path" title={editor?.path ?? path}>
        {editor?.path ?? path}
      </p>
      <ErrorNotice error={job.error} />
      {notice && (
        <Alert role="status">
          <Check />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {agent && <AgentInteractions agent={agent} />}
      {!editor ? (
        available.length ? (
          <FieldGroup>
            <Field>
              <FieldLabel>选择编辑 Agent</FieldLabel>
              <Choice
                label="选择支持编辑建议的 ACP Agent"
                value={agent}
                onValueChange={setChoice}
                placeholder="选择 Agent"
                options={available.map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                }))}
              />
              <FieldDescription>
                Agent 需要开启并支持 ACP
                编辑建议。打开后可以修改文本，或在光标位置获取建议；应用前会展示差异。
              </FieldDescription>
            </Field>
            <Button
              disabled={!agent || job.busy}
              onClick={() => void run("正在打开编辑器…", open)}
            >
              {job.busy ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <Sparkles data-icon="inline-start" />
              )}
              {job.busy ? "正在打开…" : "打开编辑器"}
            </Button>
          </FieldGroup>
        ) : (
          <EmptyState
            title="还没有可用的编辑 Agent"
            description="请先在电脑上安装 ACP Agent，并在 Agent 设置中启用编辑建议，再返回这里编辑文件。"
          />
        )
      ) : (
        <>
          <div className="resource-editor-status">
            <Badge variant={dirty ? "warning" : "secondary"}>
              {dirty ? "有未保存的修改" : "已保存"}
            </Badge>
            <span className="resource-caption">
              {available.find((entry) => entry.id === agent)?.label ?? agent}
            </span>
          </div>
          <Textarea
            ref={field}
            className="code-input resource-editor-input"
            aria-label="文件内容"
            aria-describedby="editor-save-help"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            readOnly={job.busy}
            aria-invalid={oversized}
            onSelect={(event) => {
              const lines = event.currentTarget.value
                .slice(0, event.currentTarget.selectionStart)
                .split("\n");
              setCursor({
                line: lines.length,
                column: (lines.at(-1)?.length ?? 0) + 1,
              });
            }}
            onChange={(event) => {
              setText(event.target.value);
              setPreview(undefined);
              setSuggestions(undefined);
              setNotice("");
            }}
          />
          <div className="resource-editor-status">
            <span className="resource-caption">
              第 {cursor.line} 行，第 {cursor.column} 列 ·{" "}
              {formatFileSize(bytes)}
            </span>
            <span className="resource-caption" id="editor-save-help">
              ⌘ / Ctrl + S 保存
            </span>
          </div>
          {oversized && (
            <ErrorNotice error="编辑内容超过 256 KB，请减少内容后再保存或获取建议。" />
          )}
          <div className="resource-editor-actions">
            <Button
              disabled={job.busy || !dirty || oversized}
              onClick={() => void run("正在保存…", save)}
            >
              <Save data-icon="inline-start" />
              保存文件
            </Button>
            <Button
              variant="outline"
              disabled={job.busy || oversized}
              onClick={() =>
                void run("正在获取建议…", async () => {
                  const lines = text
                    .slice(0, field.current?.selectionStart ?? 0)
                    .split("\n");
                  const result = await link.call(
                    "agents.editor",
                    {
                      agent,
                      editorId: editor.editorId,
                      operation: "suggest",
                      text,
                      position: {
                        line: lines.length - 1,
                        character: lines.at(-1)!.length,
                      },
                    },
                    60_000,
                  );
                  setEditor((current) => ({ ...current, ...result }));
                  setSuggestions(result.suggestions ?? []);
                  setPreview(undefined);
                })
              }
            >
              <Sparkles data-icon="inline-start" />
              获取光标处建议
            </Button>
          </div>
          <span className="resource-caption" role="status">
            {operation && (
              <>
                <LoaderCircle
                  className="resource-inline-spinner animate-spin"
                  aria-hidden="true"
                />
                {operation}
              </>
            )}
          </span>
          {suggestions?.length === 0 && (
            <EmptyState
              title="这个位置暂时没有编辑建议"
              description="移动光标到需要调整的代码，或修改内容后再试。"
            />
          )}
          {!!suggestions?.length && (
            <section className="resource-suggestions" aria-label="编辑建议">
              <h3>
                编辑建议 <Badge variant="secondary">{suggestions.length}</Badge>
              </h3>
              {suggestions.map((suggestion) => (
                <article className="resource-suggestion" key={suggestion.id}>
                  <div>
                    <strong>
                      {suggestion.kind === "jump"
                        ? "跳转到相关代码"
                        : suggestion.kind === "rename"
                          ? `重命名为 ${suggestion.newName}`
                          : suggestion.kind === "searchAndReplace"
                            ? "搜索并替换"
                            : `${suggestion.edits.length} 处代码修改`}
                    </strong>
                    <p className="resource-path" title={suggestion.uri}>
                      {suggestion.uri}
                    </p>
                    {suggestion.kind === "rename" && (
                      <p className="resource-caption">
                        语义重命名需要在电脑编辑器中执行。
                      </p>
                    )}
                  </div>
                  <div className="resource-inline-actions">
                    {suggestion.kind !== "rename" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={job.busy}
                        onClick={() =>
                          void run("正在生成预览…", async () => {
                            setPreview(
                              (
                                await link.call("agents.editor", {
                                  agent,
                                  editorId: editor.editorId,
                                  operation: "preview",
                                  suggestionId: suggestion.id,
                                })
                              ).preview,
                            );
                          })
                        }
                      >
                        预览差异
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={job.busy}
                      onClick={() =>
                        void run("正在忽略建议…", async () => {
                          await link.call("agents.editor", {
                            agent,
                            editorId: editor.editorId,
                            operation: "reject",
                            suggestionId: suggestion.id,
                          });
                          setSuggestions((current) =>
                            current?.filter(
                              (entry) => entry.id !== suggestion.id,
                            ),
                          );
                          setPreview(undefined);
                        })
                      }
                    >
                      忽略
                    </Button>
                  </div>
                </article>
              ))}
            </section>
          )}
          {preview && (
            <article className="resource-edit-preview">
              <header className="resource-reader-heading">
                <strong>
                  {preview.kind === "jump" ? "跳转预览" : "确认修改"}
                </strong>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="关闭修改预览"
                  disabled={job.busy}
                  onClick={() => setPreview(undefined)}
                >
                  <X />
                </Button>
              </header>
              <p className="resource-path">
                {preview.path}
                {preview.position ? `:${preview.position.line + 1}` : ""}
              </p>
              {preview.kind !== "jump" && (
                <>
                  <Diff
                    change={{
                      type: "diff",
                      path: preview.path,
                      oldText: preview.before,
                      newText: preview.after,
                    }}
                  />
                  <p className="resource-caption">
                    应用后会立即保存到电脑。请确认上方的修改内容。
                  </p>
                </>
              )}
              <Button
                disabled={job.busy}
                onClick={() =>
                  void run(
                    preview.kind === "jump" ? "正在跳转…" : "正在应用修改…",
                    async () => {
                      const result = await link.call("agents.editor", {
                        agent,
                        editorId: editor.editorId,
                        operation: "apply",
                        previewId: preview.id,
                      });
                      setEditor((current) => ({ ...current, ...result }));
                      setText(result.text ?? "");
                      setSaved(result.text ?? "");
                      setPreview(undefined);
                      setSuggestions(undefined);
                      setNotice(
                        preview.kind === "jump"
                          ? "已跳转到目标位置"
                          : "修改已应用并保存到电脑",
                      );
                      if (result.position)
                        requestAnimationFrame(() => {
                          const lines = (result.text ?? "").split("\n");
                          const offset =
                            lines
                              .slice(0, result.position!.line)
                              .reduce(
                                (length, line) => length + line.length + 1,
                                0,
                              ) + result.position!.character;
                          field.current?.focus();
                          field.current?.setSelectionRange(offset, offset);
                        });
                    },
                  )
                }
              >
                {preview.kind === "jump" ? "跳转到这里" : "应用并保存"}
              </Button>
            </article>
          )}
        </>
      )}
    </section>
  );
}
