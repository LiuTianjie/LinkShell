import { PageHeader } from "../components/PageHeader";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useDialogs } from "@/components/Dialogs";
import { Choice } from "../components/Choice";
import { useAgentModels } from "./agent-models";
import {
  Command as CommandUI,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge as PillBadge } from "@/components/ui/badge";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { subagentKey, type Locale, type SessionView } from "@linkshell/client-core";
import type {
  GitDiffFileStatus,
  GoalChange,
  SessionSummary,
  ToolCallContent,
  Workflow as WorkflowData,
} from "@linkshell/wire";
import {
  matchCommands,
  commandDetail,
  type Command,
} from "../../../client/src/lib/commands";
import {
  Badge,
  ErrorNotice,
  EmptyState,
  LoadState,
  Modal,
  useActions,
  useClient,
  useSessionOnline,
  useConnection,
  useJob,
  useLoad,
} from "./common";
import { DiffStat, DiffView, Timeline, TimelineNavigation, changeLines } from "./Timeline";
import { diffLines, diffStat, type DiffLine } from "./line-diff";
import { AcpSettings } from "./Acp";
import { isImeComposing } from "./ComposerBox";
import { optionDescription, sessionConfigLabel, valueDescription, valueName } from "./ComposerControls";
import { useLocale, useT } from "./i18n";

const KNOWN_CATEGORIES = new Set(["mode", "model", "effort"]);
import { isDesktop } from "./desktop";
import {
  ChevronRight,
  Columns2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  RefreshCw,
  RotateCcw,
  Rows2,
  SquareTerminal,
  Trash2,
} from "lucide-react";

export function Commands({
  commands,
  choose,
  close,
  returnFocus,
}: {
  commands: Command[];
  returnFocus: () => void;
  choose: (command: Command) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = matchCommands(commands, query);
  return (
    <Modal title="命令与技能" close={close} returnFocus={returnFocus}>
      <CommandUI shouldFilter={false}>
        <CommandInput
          aria-label="搜索命令"
          placeholder="搜索命令或 Skills"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {commands.length
              ? "没有匹配的命令"
              : "Agent 尚未报告命令，连接或接管后会自动更新。"}
          </CommandEmpty>
          <CommandGroup>
            {shown.map((command) => (
              <CommandItem
                key={command.name}
                value={command.name}
                onSelect={() => choose(command)}
              >
                <div className="command-option flex min-w-0 flex-col gap-0.5">
                  <span className="command-option-name">
                    <strong>/{command.name}</strong>
                    {command.hint && <small>{command.hint}</small>}
                  </span>
                  <span className="text-muted-foreground">
                    {commandDetail(command)}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandUI>
    </Modal>
  );
}
export function Settings({
  session,
  view,
}: {
  session: SessionSummary;
  view?: SessionView;
}) {
  const actions = useActions();
  const online = useSessionOnline();
  const job = useJob();
  const acp = useClient(
    (state) =>
      state.machine?.agents.find((agent) => agent.id === session.agent)
        ?.capabilities.acp,
  );
  const agent = useClient((state) =>
    state.machine?.agents.find((entry) => entry.id === session.agent),
  );
  const home = useClient((state) => state.machine?.home);
  const cwd =
    home && (session.cwd === home || session.cwd.startsWith(`${home}/`))
      ? `~${session.cwd.slice(home.length)}`
      : session.cwd;
  const [advanced, setAdvanced] = useState(false);
  const models = useAgentModels(session.agent, session.cwd, online);
  return (
    <div className="settings-panel">
      <p className="muted settings-panel-place" title={session.cwd}>
        {agent?.label ?? session.agent} · {cwd}
      </p>
      <FieldGroup>
        {view?.config.map((option) => (
          <Field key={option.id} data-disabled={!online || job.busy}>
            <FieldLabel htmlFor={`config-${option.id}`}>
              {sessionConfigLabel(option)}
            </FieldLabel>
            {/* The common settings get a Chinese name of their own; the agent's English line
                under them ("AI model to use") only repeats it. Others keep the agent's words. */}
            {option.description && !KNOWN_CATEGORIES.has(option.category ?? "") && (
              <p className="muted">{optionDescription(option.description)}</p>
            )}
            {option.type === "boolean" ? (
              <Checkbox
                id={`config-${option.id}`}
                checked={option.current === "on"}
                disabled={!online || job.busy}
                onCheckedChange={(checked) =>
                  void job.run(() =>
                    actions.setConfig(
                      session.id,
                      option.id,
                      checked === true ? "on" : "off",
                    ),
                  )
                }
              />
            ) : (
              <Choice
                id={`config-${option.id}`}
                label={sessionConfigLabel(option)}
                value={option.current}
                disabled={!online || job.busy}
                onValueChange={(value) =>
                  void job.run(() =>
                    actions.setConfig(session.id, option.id, value),
                  )
                }
                // The name alone in the field, as on the composer; what an option means shows
                // under it in the open list.
                options={option.values.map((value) => ({
                  value: value.value,
                  label:
                    (value.group ? `${value.group} · ` : "") +
                    valueName(value.name) +
                    // "Default" alone hides which model that is; Claude says it in the description.
                    (option.category === "model" && /^default\b/i.test(value.name) && value.description
                      ? ` · ${valueName(value.description)}`
                      : ""),
                  description: value.description ? valueDescription(value.description) : undefined,
                }))}
              />
            )}
          </Field>
        ))}
      </FieldGroup>
      {!view?.config.length && (
        <p className="muted">当前 Agent 尚未提供可调整的配置。</p>
      )}
      <ErrorNotice error={job.error ?? models?.error} />
      {view?.usage?.tokens && (
        <p className="muted">
          输入 {view.usage.tokens.inputTokens.toLocaleString()} · 输出{" "}
          {view.usage.tokens.outputTokens.toLocaleString()} · 总计{" "}
          {view.usage.tokens.totalTokens.toLocaleString()} tokens
        </p>
      )}
      {view?.usage?.cost && (
        <p className="muted">
          累计费用 {view.usage.cost.currency}{" "}
          {view.usage.cost.amount.toLocaleString(undefined, {
            maximumFractionDigits: 6,
          })}
        </p>
      )}
      {acp && (
        <section className="settings-panel-more">
          <Button
            variant="ghost"
            className="settings-panel-disclosure"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            <span>工具与附加目录</span>
            <ChevronRight data-icon="inline-end" />
          </Button>
          {advanced && <AcpSettings agent={session.agent} sessionId={session.id} />}
        </section>
      )}
    </div>
  );
}
type FileChange = Extract<ToolCallContent, { type: "diff" | "patch" }>;

export interface DiffReviewAnnotation {
  path: string;
  lineNumber: number;
  sign: "+" | "−" | " ";
  code: string;
  comment: string;
}

export function formatDiffReviewPrompt(
  annotations: readonly DiffReviewAnnotation[],
  locale: Locale = "zh",
): string {
  const header =
    locale === "en"
      ? "Please address the following inline diff review comments:"
      : locale === "ja"
        ? "以下の行単位コードレビュー指摘に基づいて修正してください："
        : "请根据以下逐行代码审阅意见修改代码：";
  const body = annotations
    .map((item) => {
      const snippet = item.code.trim().slice(0, 160);
      if (locale === "en") {
        return `- \`${item.path}\` line ${item.lineNumber} (${item.sign} \`${snippet}\`):\n  ${item.comment.trim()}`;
      }
      if (locale === "ja") {
        return `- \`${item.path}\` ${item.lineNumber}行目 (${item.sign} \`${snippet}\`)：\n  ${item.comment.trim()}`;
      }
      return `- \`${item.path}\` 第 ${item.lineNumber} 行 (${item.sign} \`${snippet}\`)：\n  ${item.comment.trim()}`;
    })
    .join("\n\n");
  return `${header}\n\n${body}`;
}

interface ShownChangeFile {
  path: string;
  oldPath?: string;
  status?: GitDiffFileStatus;
  binary?: boolean;
  lines: DiffLine[];
  stat: { added: number; removed: number };
}

function gitStatusLabelKey(status: GitDiffFileStatus) {
  switch (status) {
    case "added":
      return "changes.statusAdded" as const;
    case "deleted":
      return "changes.statusDeleted" as const;
    case "renamed":
      return "changes.statusRenamed" as const;
    case "untracked":
      return "changes.statusUntracked" as const;
    default:
      return "changes.statusModified" as const;
  }
}

/**
 * What the session changed, or the live Git working-tree diff (`git.diff`), with inline
 * click-on-line review annotations, per-file revert (`git.revertFile`), side-by-side split view,
 * inline git commit (`git.commit`), and 1-click wrap-up actions.
 */
export function Changes({
  view,
  session,
  inspectorWidth,
  onCommitted,
}: {
  view?: SessionView;
  session?: SessionSummary;
  inspectorWidth?: number;
  onCommitted?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const dialogs = useDialogs();
  const { link } = useConnection();
  const actions = useActions();
  const online = useSessionOnline();
  const job = useJob();
  const commitJob = useJob();
  const navCwd = useContext(TimelineNavigation)?.cwd;
  const cwd = session?.cwd ?? navCwd;
  const worktreeBase = (session?.worktree as { branch: string; source: string; base?: string } | undefined)?.base;
  const sectionRef = useRef<HTMLElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [mode, setMode] = useState<"session" | "git">("session");
  const [userPickedMode, setUserPickedMode] = useState(false);
  const [diffViewMode, setDiffViewMode] = useState<"unified" | "split">("unified");
  const [commitMessage, setCommitMessage] = useState("");
  const [notice, setNotice] = useState<string>();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [comments, setComments] = useState<Record<string, Record<number, string>>>({});
  const [editing, setEditing] = useState<{ key: string; lineIndex: number; draft: string } | null>(null);

  useEffect(() => {
    setUserPickedMode(false);
    setMode("session");
    setNotice(undefined);
  }, [session?.id, cwd]);

  useEffect(() => {
    if (inspectorWidth !== undefined || typeof ResizeObserver === "undefined") return;
    const node = sectionRef.current;
    if (!node) return;
    setMeasuredWidth(node.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === "number") setMeasuredWidth(Math.round(next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [inspectorWidth]);

  const effectiveWidth = inspectorWidth ?? measuredWidth;
  const canSplit = effectiveWidth >= 640;

  const sessionFiles = useMemo<ShownChangeFile[]>(() => {
    const byPath = new Map<string, { path: string; lines: DiffLine[]; first?: string; last?: string; patches: DiffLine[][] }>();
    for (const item of view?.items ?? []) {
      if (item.kind !== "tool" || item.status === "failed") continue;
      for (const content of item.content) {
        if (content.type !== "diff" && content.type !== "patch") continue;
        const change = content as FileChange;
        const path = change.type === "patch" && change.movePath ? change.movePath : change.path;
        const entry = byPath.get(path) ?? { path, lines: [], patches: [] };
        if (change.type === "diff") {
          if (entry.first === undefined) entry.first = change.oldText ?? "";
          entry.last = change.newText;
        } else entry.patches.push(changeLines(change));
        byPath.set(path, entry);
      }
    }
    return [...byPath.values()].map((entry) => {
      const lines = entry.last !== undefined ? diffLines(entry.first ?? "", entry.last) : entry.patches.flat();
      return { path: entry.path, lines, stat: diffStat(lines) };
    });
  }, [view?.items]);

  const shouldLoadGit = Boolean(online && cwd && (mode === "git" || sessionFiles.length === 0));
  const gitDiff = useLoad(
    () =>
      shouldLoadGit && cwd
        ? link.call("git.diff", {
            cwd,
            ...(worktreeBase ? { base: worktreeBase } : {}),
            includeUntracked: true,
          })
        : Promise.resolve(undefined),
    [link, shouldLoadGit, cwd, worktreeBase],
  );

  useEffect(() => {
    if (
      !userPickedMode &&
      mode === "session" &&
      sessionFiles.length === 0 &&
      (gitDiff.value?.files.length ?? 0) > 0
    ) {
      setMode("git");
    }
  }, [userPickedMode, mode, sessionFiles.length, gitDiff.value?.files.length]);

  const gitFiles = useMemo<ShownChangeFile[]>(
    () =>
      (gitDiff.value?.files ?? []).map((entry) => ({
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        binary: entry.binary,
        lines: entry.binary ? [] : diffLines(entry.oldText, entry.newText),
        stat: { added: entry.additions, removed: entry.deletions },
      })),
    [gitDiff.value?.files],
  );

  const files = mode === "git" ? gitFiles : sessionFiles;
  const total = files.reduce(
    (sum, file) => ({ added: sum.added + file.stat.added, removed: sum.removed + file.stat.removed }),
    { added: 0, removed: 0 },
  );
  const shown = useCallback(
    (path: string) =>
      cwd && path.startsWith(`${cwd.replace(/\/$/, "")}/`)
        ? path.slice(cwd.replace(/\/$/, "").length + 1)
        : path,
    [cwd],
  );

  const annotations = useMemo<DiffReviewAnnotation[]>(() => {
    const list: DiffReviewAnnotation[] = [];
    for (const file of files) {
      const fileComments = comments[`${mode}:${file.path}`];
      if (!fileComments) continue;
      const indices = Object.keys(fileComments)
        .map(Number)
        .filter((idx) => Number.isFinite(idx) && Boolean(fileComments[idx]?.trim()))
        .sort((a, b) => a - b);
      for (const lineIndex of indices) {
        const line = file.lines[lineIndex];
        const comment = fileComments[lineIndex]?.trim();
        if (!comment) continue;
        list.push({
          path: shown(file.path),
          lineNumber: line?.new ?? line?.old ?? lineIndex + 1,
          sign: line?.kind === "add" ? "+" : line?.kind === "del" ? "−" : " ",
          code: line?.text ?? "",
          comment,
        });
      }
    }
    return list;
  }, [comments, files, mode, shown]);

  const saveLineComment = (fileKey: string, lineIndex: number, text: string) => {
    const trimmed = text.trim();
    setComments((prev) => {
      const nextFile = { ...(prev[fileKey] ?? {}) };
      if (trimmed) nextFile[lineIndex] = trimmed;
      else delete nextFile[lineIndex];
      const next = { ...prev };
      if (Object.keys(nextFile).length > 0) next[fileKey] = nextFile;
      else delete next[fileKey];
      return next;
    });
    setEditing(null);
  };

  const sendToSession = (promptText: string, clearModeComments = false) => {
    if (!session) return;
    setNotice(undefined);
    void job.run(async () => {
      const result = await actions.send(session.id, [{ type: "text", text: promptText }]);
      if (result === "failed") throw new Error("Failed to send message");
      if (clearModeComments) {
        setComments((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            if (key.startsWith(`${mode}:`)) delete next[key];
          }
          return next;
        });
        setEditing(null);
      }
    });
  };

  const revertFile = async (filePath: string) => {
    if (!cwd) return;
    const displayPath = shown(filePath);
    if (
      !(await dialogs.confirm(
        `${t("changes.revertConfirmTitle")}\n\n${t("changes.revertConfirmBody", { path: displayPath })}`,
      ))
    )
      return;
    setNotice(undefined);
    await job.run(async () => {
      await link.call("git.revertFile", { cwd, path: filePath });
      setComments((prev) => {
        const next = { ...prev };
        delete next[`git:${filePath}`];
        return next;
      });
      setNotice(t("changes.reverted", { path: displayPath }));
      gitDiff.reload();
      onCommitted?.();
    });
  };

  const commitAll = () => {
    const trimmed = commitMessage.trim();
    if (!cwd || !trimmed || !online || commitJob.busy || job.busy) return;
    setNotice(undefined);
    void commitJob.run(async () => {
      const res = await link.call("git.commit", {
        cwd,
        message: trimmed,
        stageAll: true,
      });
      setCommitMessage("");
      setComments((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith("git:")) delete next[key];
        }
        return next;
      });
      setEditing(null);
      setNotice(`已提交 ${res.sha.slice(0, 7)}：${res.summary}`);
      gitDiff.reload();
      onCommitted?.();
    });
  };

  return (
    <section ref={sectionRef} className="changes flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={mode}
          onValueChange={(next) => {
            setUserPickedMode(true);
            setMode(next as "session" | "git");
            setEditing(null);
            setNotice(undefined);
          }}
        >
          <TabsList aria-label={t("changes.title")}>
            <TabsTrigger value="session">{t("changes.sessionEdits")}</TabsTrigger>
            <TabsTrigger value="git" disabled={!cwd}>{t("changes.gitWorkingTree")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1.5">
          {canSplit && files.length > 0 && (
            <Tabs
              value={diffViewMode}
              onValueChange={(next) => setDiffViewMode(next as "unified" | "split")}
            >
              <TabsList aria-label="差异布局">
                <TabsTrigger value="unified" title="统一视图">
                  <Rows2 className="size-3.5" aria-hidden />
                  统一
                </TabsTrigger>
                <TabsTrigger value="split" title="并排对比视图">
                  <Columns2 className="size-3.5" aria-hidden />
                  并排
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {mode === "git" && (
            <>
              {gitDiff.value?.branch && (
                <PillBadge variant="outline" className="gap-1">
                  <GitBranch className="size-3" aria-hidden />
                  {gitDiff.value.branch}
                </PillBadge>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("common.refresh")}
                title={t("common.refresh")}
                disabled={!online || gitDiff.loading}
                onClick={gitDiff.reload}
              >
                <RefreshCw className={gitDiff.loading ? "animate-spin" : undefined} />
              </Button>
            </>
          )}
        </div>
      </div>

      {mode === "git" && cwd && files.length > 0 && (
        <form
          className="git-commit-bar"
          onSubmit={(event) => {
            event.preventDefault();
            commitAll();
          }}
        >
          <Input
            value={commitMessage}
            disabled={!online || commitJob.busy || job.busy}
            maxLength={4000}
            aria-label="提交说明"
            placeholder="输入提交说明（自动暂存全部改动）…"
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commitAll();
              }
            }}
          />
          <Button
            type="submit"
            size="sm"
            disabled={!online || commitJob.busy || job.busy || !commitMessage.trim()}
          >
            {commitJob.busy ? (
              <LoaderCircle className="animate-spin" data-icon="inline-start" />
            ) : (
              <GitCommitHorizontal data-icon="inline-start" />
            )}
            {commitJob.busy ? "正在提交…" : "提交改动"}
          </Button>
        </form>
      )}

      {session && files.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={!online || job.busy}
            onClick={() => sendToSession(t("changes.askCommitPrPrompt"))}
          >
            <GitPullRequest data-icon="inline-start" />
            {t("changes.askCommitPr")}
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={!online || job.busy}
            onClick={() => sendToSession(t("changes.askRunTestsPrompt"))}
          >
            <Play data-icon="inline-start" />
            {t("changes.askRunTests")}
          </Button>
        </div>
      )}

      {annotations.length > 0 && session && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
          <span className="font-medium">{t("changes.reviewCount", { count: annotations.length })}</span>
          <Button
            size="xs"
            disabled={!online || job.busy}
            onClick={() => sendToSession(formatDiffReviewPrompt(annotations, locale), true)}
          >
            <MessageSquarePlus data-icon="inline-start" />
            {t("changes.submitReview", { count: annotations.length })}
          </Button>
        </div>
      )}

      <ErrorNotice error={job.error ?? commitJob.error} />
      {mode === "git" && <LoadState {...gitDiff} />}
      {notice && <p className="text-xs text-muted-foreground" role="status">{notice}</p>}
      {mode === "git" && gitDiff.value?.truncated && (
        <p className="text-xs text-muted-foreground">{t("changes.truncated")}</p>
      )}

      {!files.length && !(mode === "git" && gitDiff.loading) ? (
        <p className="changes-empty">{t("changes.empty")}</p>
      ) : files.length > 0 ? (
        <>
          <header className="changes-head">
            <strong>
              {locale === "en"
                ? `${files.length} file${files.length === 1 ? "" : "s"}`
                : locale === "ja"
                  ? `${files.length} 件のファイル`
                  : `${files.length} 个文件已更改`}
            </strong>
            <DiffStat added={total.added} removed={total.removed} />
          </header>
          <div className="changes-files">
            {files.map((file) => {
              const fileKey = `${mode}:${file.path}`;
              const expanded = open[fileKey] ?? files.length === 1;
              const displayPath = shown(file.path);
              const slash = displayPath.lastIndexOf("/");
              const fileComments = comments[fileKey];
              const fileCommentCount = fileComments ? Object.keys(fileComments).length : 0;
              return (
                <div className="changes-file" key={fileKey} data-open={expanded || undefined}>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="changes-file-row flex-1 min-w-0"
                      aria-expanded={expanded}
                      title={file.path}
                      onClick={() => setOpen((state) => ({ ...state, [fileKey]: !expanded }))}
                    >
                      <ChevronRight className="changes-chevron" aria-hidden />
                      <span className="changes-file-name">
                        {slash >= 0 && <small><bdi>{displayPath.slice(0, slash + 1)}</bdi></small>}
                        <span>{displayPath.slice(slash + 1)}</span>
                      </span>
                      {file.status && (
                        <PillBadge variant="outline" className="text-[11px] px-1.5 py-0">
                          {t(gitStatusLabelKey(file.status))}
                        </PillBadge>
                      )}
                      {fileCommentCount > 0 && (
                        <PillBadge variant="secondary" className="text-[11px] px-1.5 py-0">
                          {fileCommentCount}
                        </PillBadge>
                      )}
                      <DiffStat added={file.stat.added} removed={file.stat.removed} />
                    </button>
                    {mode === "git" && cwd && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="shrink-0"
                        disabled={!online || job.busy || commitJob.busy}
                        title={t("changes.revertFile")}
                        aria-label={`${t("changes.revertFile")} ${displayPath}`}
                        onClick={() => void revertFile(file.path)}
                      >
                        <RotateCcw data-icon="inline-start" />
                        {t("changes.revertFile")}
                      </Button>
                    )}
                  </div>
                  {expanded && (
                    file.binary ? (
                      <div className="diff-skip">{t("changes.binaryFile")}</div>
                    ) : (
                      <DiffView
                        lines={file.lines}
                        path={file.path}
                        viewMode={canSplit ? diffViewMode : "unified"}
                        comments={fileComments}
                        activeLine={editing?.key === fileKey ? editing.lineIndex : null}
                        onSelectLine={(lineIndex) =>
                          setEditing((current) =>
                            current?.key === fileKey && current.lineIndex === lineIndex
                              ? null
                              : { key: fileKey, lineIndex, draft: fileComments?.[lineIndex] ?? "" },
                          )
                        }
                        renderLineEditor={(lineIndex) => (
                          <div
                            className="flex flex-col gap-2"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Textarea
                              rows={2}
                              autoFocus
                              value={editing?.key === fileKey && editing.lineIndex === lineIndex ? editing.draft : ""}
                              placeholder={t("changes.commentPlaceholder")}
                              onChange={(event) =>
                                setEditing((current) =>
                                  current ? { ...current, draft: event.target.value } : null,
                                )
                              }
                              onKeyDown={(event) => {
                                if (isImeComposing(event)) return;
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  setEditing(null);
                                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                  event.preventDefault();
                                  saveLineComment(fileKey, lineIndex, editing?.draft ?? "");
                                }
                              }}
                            />
                            <div className="flex items-center justify-end gap-1.5">
                              {fileComments?.[lineIndex] && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => saveLineComment(fileKey, lineIndex, "")}
                                >
                                  <Trash2 data-icon="inline-start" />
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => setEditing(null)}
                              >
                                {t("changes.cancelComment")}
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                onClick={() => saveLineComment(fileKey, lineIndex, editing?.draft ?? "")}
                              >
                                {t("changes.saveComment")}
                              </Button>
                            </div>
                          </div>
                        )}
                      />
                    )
                  )}
                </div>
              );
            })}
          </div>
          {mode === "session" && <p className="changes-note">{t("changes.sessionEdits")}</p>}
        </>
      ) : null}
    </section>
  );
}
export function Goal({
  session,
  view,
}: {
  session: SessionSummary;
  view?: SessionView;
}) {
  const dialogs = useDialogs();
  const { link } = useConnection();
  const actions = useActions();
  const online = useSessionOnline();
  const job = useJob();
  const codex = session.agent === "codex";
  const readOnly = codex && session.driver === "desktop";
  const disabled = job.busy || !online || readOnly;
  const load = useLoad(
    async () =>
      codex && online
        ? link.call("sessions.goal", {
            sessionId: session.id,
            change: { action: "get" },
          })
        : { goal: null },
    [link, session.id, codex, online],
  );
  const goal = view?.goal === undefined ? load.value?.goal : view.goal;
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!editing) {
      setObjective(goal?.objective ?? "");
      setBudget(goal?.tokenBudget?.toString() ?? "");
    }
  }, [goal?.objective, goal?.tokenBudget, editing]);
  async function change(change: GoalChange) {
    if (disabled) return;
    if (codex) {
      await link.call("sessions.goal", { sessionId: session.id, change });
      load.reload();
    } else {
      const text =
        change.action === "set"
          ? `/goal ${change.objective}`
          : change.action === "clear"
            ? "/goal clear"
            : "/goal";
      const result = await actions.send(session.id, [{ type: "text", text }], {
        now: true,
      });
      if (result === "failed") throw new Error("目标命令未发送成功，请重试");
      setNotice("已发送目标命令，执行结果会显示在会话中。");
    }
    setEditing(false);
  }
  return (
    <section className="settings-panel">
      <h3>持续目标</h3>
      <LoadState {...load} />
      {load.error && (
        <Button
          variant="outline"
          size="sm"
          disabled={!online || load.loading}
          onClick={load.reload}
        >
          重新加载目标
        </Button>
      )}
      {goal && (
        <div className="notice-card">
          <Badge state={goal.status} />
          <p>{goal.objective}</p>
          <small>
            已用 {goal.tokensUsed ?? "—"} tokens
            {goal.tokenBudget ? ` / ${goal.tokenBudget}` : ""} ·{" "}
            {goal.iterations ?? 0} 轮
          </small>
          {goal.lastReason && <p>{goal.lastReason}</p>}
          <div className="permission-buttons">
            {codex && (
              <Button
                variant="outline"
                disabled={
                  disabled ||
                  ["complete", "budgetLimited"].includes(goal.status)
                }
                onClick={() =>
                  void job.run(() =>
                    change({
                      action: goal.status === "active" ? "pause" : "resume",
                    }),
                  )
                }
              >
                {goal.status === "active" ? "暂停" : "继续"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={disabled}
              onClick={async () => {
                if (await dialogs.confirm("清除当前持续目标？"))
                  void job.run(() => change({ action: "clear" }));
              }}
            >
              清除目标
            </Button>
          </div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void job.run(() =>
            change({
              action: "set",
              objective: objective.trim(),
              ...(budget ? { tokenBudget: Number(budget) } : {}),
            }),
          );
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="goal-objective">目标</FieldLabel>
            <Textarea
              id="goal-objective"
              value={objective}
              onChange={(event) => {
                setEditing(true);
                setObjective(event.target.value);
              }}
              rows={4}
              required
              maxLength={codex ? 4000 : undefined}
              disabled={disabled}
              placeholder="你希望 Agent 持续完成什么？"
            />
          </Field>
          {codex && (
            <Field>
              <FieldLabel htmlFor="goal-budget">Token 预算（可选）</FieldLabel>
              <Input
                id="goal-budget"
                type="number"
                min="1"
                step="1"
                disabled={disabled}
                value={budget}
                onChange={(event) => {
                  setEditing(true);
                  setBudget(event.target.value);
                }}
              />
            </Field>
          )}
          <Button variant="default" disabled={disabled || !objective.trim()}>
            {goal ? "更新目标" : "设置目标"}
          </Button>
        </FieldGroup>
      </form>
      {!codex && (
        <Button
          variant="link"
          size="sm"
          disabled={disabled}
          onClick={() => void job.run(() => change({ action: "get" }))}
        >
          查询当前目标
        </Button>
      )}
      {readOnly && (
        <p className="muted">会话由电脑端控制，请在电脑端修改目标。</p>
      )}
      {notice && <p role="status">{notice}</p>}
      <ErrorNotice error={job.error} />
    </section>
  );
}
export function Tasks({
  session,
  onFile,
  onTerminal,
}: {
  session: SessionSummary;
  onFile: (path: string) => void;
  onTerminal: (id: string) => void;
}) {
  const actions = useActions();
  const { store } = useConnection();
  const online = useSessionOnline();
  const records = useClient((state) => state.tasks[session.id]);
  const workflows = useClient((state) => state.workflows[session.id]);
  const job = useJob();
  const loaded = useLoad(
    async () => ({
      tasks: await actions.loadTasks(session.id),
      subagents: await actions.loadSubagents(session.id),
    }),
    [store, session.id],
    5000,
  );
  const [selected, setSelected] = useState<{
    kind: "task" | "agent";
    id: string;
  }>();
  return (
    <section className="tasks-panel">
      {/* The desktop's inspector tab already names it. */}
      {!isDesktop && <h3>后台任务、子 Agent 与工作流</h3>}
      <LoadState {...loaded} />
      {loaded.error && (
        <Button
          variant="outline"
          size="sm"
          disabled={!online || loaded.loading}
          onClick={loaded.reload}
        >
          重新加载任务
        </Button>
      )}
      <ErrorNotice error={job.error} />
      <div className="activity-list">
        {(records
          ? Object.values(records).sort((a, b) => b.startedAt - a.startedAt)
          : (loaded.value?.tasks ?? [])
        ).map((task) => (
          <article
            key={task.id}
            data-selected={
              (selected?.kind === "task" && selected.id === task.id) ||
              undefined
            }
          >
            <Button
              variant="ghost"
              size="plain"
              aria-expanded={
                selected?.kind === "task" && selected.id === task.id
              }
              onClick={() =>
                setSelected((current) =>
                  current?.kind === "task" && current.id === task.id
                    ? undefined
                    : { kind: "task", id: task.id },
                )
              }
            >
              <Badge state={task.state} />
              <strong>{task.title}</strong>
              <small className="task-command" title={task.command}>{task.command}</small>
            </Button>
            {task.state === "running" && (
              <Button
                variant={isDesktop ? "secondary" : "link"}
                size={isDesktop ? "xs" : "sm"}
                className="task-stop"
                aria-label="停止任务"
                disabled={!online || job.busy}
                onClick={() =>
                  void job.run(async () => {
                    await actions.stopTask(session.id, task.id);
                    loaded.reload();
                  })
                }
              >
                {isDesktop ? "停止" : "停止任务"}
              </Button>
            )}
            {selected?.kind === "task" && selected.id === task.id && (
              <TaskOutput
                key={task.id}
                sessionId={session.id}
                taskId={task.id}
              />
            )}
          </article>
        ))}
        {loaded.value?.subagents.map((agent) => (
          <article
            key={agent.toolCallId}
            data-selected={
              (selected?.kind === "agent" &&
                selected.id === agent.toolCallId) ||
              undefined
            }
          >
            <Button
              variant="ghost"
              size="plain"
              aria-expanded={
                selected?.kind === "agent" && selected.id === agent.toolCallId
              }
              onClick={() =>
                setSelected((current) =>
                  current?.kind === "agent" &&
                  current.id === agent.toolCallId
                    ? undefined
                    : { kind: "agent", id: agent.toolCallId },
                )
              }
            >
              <Badge
                state={
                  agent.state ??
                  (agent.running
                    ? "running"
                    : agent.failed
                      ? "failed"
                      : "completed")
                }
              />
              <strong>{agent.task}</strong>
              <small>
                {agent.agentType ?? (agent.workflow ? "工作流" : "子 Agent")}
              </small>
            </Button>
            {(workflows?.[agent.toolCallId]?.workflow ?? agent.workflow) && (
              <Workflow
                workflow={
                  workflows?.[agent.toolCallId]?.workflow ?? agent.workflow!
                }
                open={(id) => {
                  setSelected({ kind: "agent", id });
                }}
              />
            )}
          </article>
        ))}
        {Object.values(workflows ?? {})
          .filter(
            (record) =>
              !loaded.value?.subagents.some(
                (agent) => agent.toolCallId === record.toolCallId,
              ),
          )
          .map((record) => (
            <article key={record.toolCallId}>
              <strong>{record.task}</strong>
              <Workflow
                workflow={record.workflow}
                open={(id) => setSelected({ kind: "agent", id })}
              />
            </article>
          ))}
      </div>
      {loaded.value &&
        !loaded.value.tasks.length &&
        !loaded.value.subagents.length &&
        !Object.keys(workflows ?? {}).length && (
          <EmptyState
            title="没有后台任务"
            description="Agent 启动后台命令或子 Agent 后，会在这里显示状态与输出。"
          />
        )}
      {selected?.kind === "agent" && (
        <SubagentConversation
          key={selected.id}
          session={session}
          id={selected.id}
          onFile={onFile}
          onTerminal={onTerminal}
        />
      )}
    </section>
  );
}
function TaskOutput({
  sessionId,
  taskId,
}: {
  sessionId: string;
  taskId: string;
}) {
  const actions = useActions();
  const { store } = useConnection();
  const online = useSessionOnline();
  const running = useClient(
    (state) => state.tasks[sessionId]?.[taskId]?.state === "running",
  );
  const [snapshot, setSnapshot] =
    useState<Awaited<ReturnType<typeof actions.loadTaskOutput>>>();
  const output = useLoad(
    () => actions.loadTaskOutput(sessionId, taskId),
    [store, sessionId, taskId],
    running && !snapshot ? 2000 : 0,
  );
  const current = snapshot ?? output.value;
  const job = useJob();
  return (
    <div className="task-output">
      <div className="browser-toolbar">
        <strong>{isDesktop ? "输出" : "任务输出"}</strong>
        <Button
          variant={isDesktop ? "ghost" : "link"}
          size={isDesktop ? "icon-sm" : "sm"}
          title="刷新输出"
          aria-label="刷新输出"
          disabled={!online || output.loading}
          onClick={() => {
            setSnapshot(undefined);
            output.reload();
          }}
        >
          {isDesktop ? <RefreshCw className={output.loading ? "animate-spin" : undefined} /> : "刷新"}
        </Button>
      </div>
      <LoadState
        loading={!current && output.loading}
        error={output.error ?? job.error}
      />
      {!!current?.start && (
        <Button
          variant={isDesktop ? "ghost" : "link"}
          size={isDesktop ? "xs" : "sm"}
          className="task-output-earlier"
          disabled={!online || job.busy}
          onClick={() => {
            setSnapshot(current);
            void job.run(async () => {
              const page = await actions.loadTaskOutput(
                sessionId,
                taskId,
                current.start,
              );
              setSnapshot({
                ...current,
                text: page.text + current.text,
                start: page.start,
              });
            });
          }}
        >
          加载更早输出
        </Button>
      )}
      {current && (
        <pre tabIndex={0} aria-label="任务输出">
          {current.text || "没有可读的输出"}
        </pre>
      )}
    </div>
  );
}
function SubagentConversation({
  session,
  id,
  onFile,
  onTerminal,
}: {
  session: SessionSummary;
  id: string;
  onFile: (path: string) => void;
  onTerminal: (id: string) => void;
}) {
  const { store } = useConnection();
  const online = useSessionOnline();
  const ready = useClient((state) => state.ready[session.id]);
  const sub = useClient(
    (state) => state.subagentViews[subagentKey(session.id, id)],
  );
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!online || !ready) return;
    let alive = true;
    setMissing(false);
    void store
      .getState()
      .openSubagent(session.id, id)
      .then((opened) => {
        if (alive) setMissing(!opened);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
      store.getState().closeSubagent(session.id, id);
    };
  }, [store, session.id, id, online, ready, attempt]);
  return (
    <div>
      <h3>子 Agent 会话</h3>
      {sub ? (
        <Timeline
          items={sub.items}
          sessionId={session.id}
          agent={session.agent}
          onFile={onFile}
          onTerminal={onTerminal}
        />
      ) : missing ? (
        <div role="alert">
          <p>未能读取子 Agent 会话，它可能已关闭或暂时不可用。</p>
          <Button
            variant="link"
            size="sm"
            disabled={!online}
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      ) : (
        <p className="muted">{online ? "正在加载…" : "等待电脑重新连接…"}</p>
      )}
    </div>
  );
}
function Workflow({
  workflow,
  open,
}: {
  workflow: WorkflowData;
  open: (id: string) => void;
}) {
  return (
    <details className="workflow-panel">
      <summary>
        {workflow.name ?? "工作流"} · {workflow.completed ?? 0} /{" "}
        {workflow.started ?? workflow.agents?.length ?? 0} 已完成
      </summary>
      <div className="browser-toolbar">
        {workflow.state && <Badge state={workflow.state} />}
        <small>
          {workflow.tokens ?? 0} tokens
          {workflow.durationMs !== undefined
            ? ` · ${Math.round(workflow.durationMs / 1000)} 秒`
            : ""}
        </small>
      </div>
      {workflow.phases?.map((phase) => (
        <div className="workflow-phase" key={phase.id}>
          {phase.order + 1}. {phase.title}
        </div>
      ))}
      {workflow.agents?.map((agent) => (
        <div className="workflow-agent" key={agent.id}>
          <Badge state={agent.state} />
          <strong>{agent.title}</strong>
          <small>
            {agent.model ?? ""}
            {agent.tokens !== undefined ? ` · ${agent.tokens} tokens` : ""}
            {agent.toolCalls !== undefined
              ? ` · ${agent.toolCalls} 次工具调用`
              : ""}
          </small>
          {agent.result && <p>{agent.result}</p>}
          {agent.toolCallId && (
            <Button
              variant="link"
              size="sm"
              onClick={() => open(agent.toolCallId!)}
            >
              查看会话
            </Button>
          )}
        </div>
      ))}
    </details>
  );
}
export function Worktrees({
  onNewSession,
  onOpenTerminal,
  onBrowseFiles,
  initialEntries,
}: {
  onNewSession?: (cwd: string) => void;
  onOpenTerminal?: (cwd: string) => void;
  onBrowseFiles?: (cwd: string) => void;
  initialEntries?: Awaited<ReturnType<ReturnType<typeof useActions>["listWorktrees"]>>;
} = {}) {
  const t = useT();
  const dialogs = useDialogs();
  const actions = useActions();
  const { store } = useConnection();
  const job = useJob();
  const online = useSessionOnline();
  const [removing, setRemoving] = useState<string>();
  const loaded = useLoad(() => actions.listWorktrees(), [store]);
  const items = loaded.value ?? initialEntries;
  return (
    <section className="worktrees-page">
      <PageHeader
        title={t("nav.worktrees")}
        actions={<>
      <Button
        variant="ghost"
        size="sm"
        disabled={!online || loaded.loading || job.busy}
        onClick={loaded.reload}
      >
        <RefreshCw data-icon="inline-start" />
        {t("common.refresh")}
      </Button>
        </>}
      />
      {!initialEntries && <LoadState {...loaded} />}
      <ErrorNotice error={job.error} />
      {!online && (
        <p className="muted" role="status">
          电脑离线，暂时无法更新或移除工作目录。
        </p>
      )}
      <div className="worktree-list">
        {items?.map((entry) => (
          <article className="worktree-entry" key={entry.path}>
            <div className="worktree-info">
              <h2>
                <GitBranch aria-hidden="true" />
                {entry.branch || "未命名分支"}
              </h2>
              <p className="worktree-path" title={entry.path}>
                {entry.path}
              </p>
              <p className="worktree-meta">
                <span className={entry.dirty ? "is-dirty" : undefined}>
                  {entry.dirty ? "有未提交改动" : "工作区干净"}
                </span>
                <span>{entry.sessions.length} 个会话</span>
                <span>{entry.ahead} 个新提交</span>
              </p>
            </div>
            <div className="worktree-actions">
              {onNewSession && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!online || job.busy}
                  onClick={() => onNewSession(entry.path)}
                >
                  <MessageSquarePlus data-icon="inline-start" />
                  新建会话
                </Button>
              )}
              {onOpenTerminal && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!online || job.busy}
                  onClick={() => onOpenTerminal(entry.path)}
                >
                  <SquareTerminal data-icon="inline-start" />
                  打开终端
                </Button>
              )}
              {onBrowseFiles && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!online || job.busy}
                  onClick={() => onBrowseFiles(entry.path)}
                >
                  <FolderOpen data-icon="inline-start" />
                  浏览文件
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={!online || entry.sessions.length > 0 || job.busy}
                title={
                  entry.sessions.length
                    ? "工作目录仍被会话使用，请先删除关联会话"
                    : "移除工作目录与分支"
                }
                onClick={async () => {
                  const force = entry.dirty || entry.ahead > 0;
                  if (
                    await dialogs.confirm(
                      force
                        ? `「${entry.branch}」有未提交改动或新提交。确定永久删除此工作目录及分支？\n${entry.path}`
                        : `移除「${entry.branch}」的工作目录及分支？\n${entry.path}`,
                    )
                  )
                    void job.run(async () => {
                      setRemoving(entry.path);
                      try {
                        await actions.removeWorktree(entry.path, force);
                        loaded.reload();
                      } finally {
                        setRemoving(undefined);
                      }
                    });
                }}
              >
                <Trash2 data-icon="inline-start" />
                {removing === entry.path ? "正在移除…" : "移除"}
              </Button>
              {entry.sessions.length > 0 && <small>会话使用中</small>}
            </div>
          </article>
        ))}
      </div>
      {items?.length === 0 && (
        <EmptyState
          icon={<GitBranch />}
          title="暂无独立工作目录"
          description="新建或分叉会话时选择 worktree，即可在独立分支中工作。"
        />
      )}
    </section>
  );
}
