import { useState } from "react";
import {
  Bot,
  Check,
  Clock,
  ExternalLink,
  FolderGit2,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import type { LsaFollowup, LsaMemory, LsaStatus, LsaTask } from "@linkshell/wire";
import { dateLocaleTag } from "@linkshell/client-core";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorNotice, LoadState, useClient, useConnection, useJob, useLoad } from "./common";
import { useLocale, useT } from "./i18n";

interface StewardBundle {
  status: LsaStatus;
  tasks: LsaTask[];
  followups: LsaFollowup[];
  memories: LsaMemory[];
}

export function lsaStatusBadgeVariant(status: LsaTask["status"]): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "running":
    case "verifying":
      return "default";
    case "waiting_decision":
      return "outline";
    case "failed":
      return "destructive";
    default:
      return "secondary";
  }
}

export function Steward({ navigate }: { navigate: (view: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const connection = useConnection();
  const online = useClient((state) => state.status === "online");
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState("");
  const [worktree, setWorktree] = useState(true);
  const [checksInput, setChecksInput] = useState("");
  const [steerDrafts, setSteerDrafts] = useState<Record<string, string>>({});
  const [followupNote, setFollowupNote] = useState("");
  const [memoryQuery, setMemoryQuery] = useState("");
  const job = useJob();

  const data = useLoad<StewardBundle | undefined>(
    async () => {
      if (!connection || !online) return undefined;
      const [status, tasksRes, followupsRes, memoriesRes] = await Promise.all([
        connection.link.call("lsa.status", {}),
        connection.link.call("lsa.tasks", { limit: 50 }),
        connection.link.call("lsa.followups", { op: "list", includeDone: false }),
        connection.link.call("lsa.memories", {
          op: memoryQuery.trim() ? "search" : "list",
          query: memoryQuery.trim() || undefined,
          limit: 50,
        }),
      ]);
      return {
        status,
        tasks: tasksRes.tasks,
        followups: followupsRes.followups,
        memories: memoriesRes.memories,
      };
    },
    [connection, online, memoryQuery],
  );

  const bundle = data.value;
  const status = bundle?.status;
  const tasks = bundle?.tasks ?? [];
  const followups = bundle?.followups ?? [];
  const memories = bundle?.memories ?? [];

  const formatStamp = (at: number) =>
    new Date(at).toLocaleString(dateLocaleTag(locale), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const dispatchGoal = () => {
    if (!connection || !goal.trim() || job.busy) return;
    const acceptanceChecks = checksInput
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    void job.run(async () => {
      await connection.link.call("lsa.dispatch", {
        goal: goal.trim(),
        cwd: cwd.trim() || undefined,
        worktree,
        acceptanceChecks: acceptanceChecks.length ? acceptanceChecks : undefined,
      });
      setGoal("");
      setChecksInput("");
      data.reload();
    });
  };

  const steerTask = (task: LsaTask) => {
    const instruction = (steerDrafts[task.id] ?? "").trim();
    if (!connection || !instruction || job.busy) return;
    void job.run(async () => {
      await connection.link.call("lsa.steer", {
        taskId: task.id,
        instruction,
        controllerEpoch: status?.controllerEpoch,
      });
      setSteerDrafts((prev) => ({ ...prev, [task.id]: "" }));
      data.reload();
    });
  };

  const decideTask = (task: LsaTask, decision: "accept" | "retry" | "cancel") => {
    if (!connection || job.busy) return;
    const feedback = (steerDrafts[task.id] ?? "").trim() || undefined;
    void job.run(async () => {
      await connection.link.call("lsa.decide", {
        taskId: task.id,
        decision,
        feedback,
        controllerEpoch: status?.controllerEpoch,
      });
      setSteerDrafts((prev) => ({ ...prev, [task.id]: "" }));
      data.reload();
    });
  };

  const addFollowup = () => {
    if (!connection || !followupNote.trim() || job.busy) return;
    void job.run(async () => {
      await connection.link.call("lsa.followups", {
        op: "schedule",
        note: followupNote.trim(),
        dueAt: Date.now() + 3_600_000,
      });
      setFollowupNote("");
      data.reload();
    });
  };

  const completeFollowup = (id: string) => {
    if (!connection || job.busy) return;
    void job.run(async () => {
      await connection.link.call("lsa.followups", { op: "complete", id });
      data.reload();
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t("lsa.title")}
        detail={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{t("lsa.subtitle")}</span>
            <Badge variant="secondary">{t("lsa.yearlyBadge")}</Badge>
          </span>
        }
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!online || data.loading}
            onClick={data.reload}
          >
            {data.loading ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
            {t("common.refresh")}
          </Button>
        }
      />

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 md:p-6">
        <ErrorNotice error={job.error ?? data.error} />

        {!online ? (
          <EmptyState title={t("connection.offline")} description={t("lsa.subtitle")} />
        ) : (
          <>
            <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
              <Textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={t("lsa.dispatchPlaceholder")}
                rows={3}
                disabled={job.busy}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[200px] flex-1"
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder="cwd (optional)"
                  disabled={job.busy}
                />
                <Input
                  className="min-w-[200px] flex-1"
                  value={checksInput}
                  onChange={(event) => setChecksInput(event.target.value)}
                  placeholder="pnpm typecheck, pnpm test (optional)"
                  disabled={job.busy}
                />
              </div>
              {status?.candidates && status.candidates.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {status.candidates.slice(0, 6).map((candidate) => (
                    <Button
                      key={candidate.cwd}
                      type="button"
                      variant={cwd === candidate.cwd ? "secondary" : "outline"}
                      size="xs"
                      onClick={() => setCwd(candidate.cwd)}
                    >
                      <FolderGit2 data-icon="inline-start" />
                      {candidate.name}
                    </Button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={worktree}
                    onCheckedChange={(checked) => setWorktree(checked === true)}
                    disabled={job.busy}
                  />
                  <span>Git Worktree</span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={!goal.trim() || job.busy}
                  onClick={dispatchGoal}
                >
                  {job.busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Bot data-icon="inline-start" />}
                  {t("lsa.dispatchAction")}
                </Button>
              </div>
            </section>

            {status && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">
                  {t("lsa.activeTasks")}: {status.activeTasks}
                </Badge>
                <Badge variant="outline">
                  {t("lsa.waitingDecision")}: {status.waitingDecisionTasks}
                </Badge>
                <Badge variant="outline">
                  {t("lsa.followups")}: {status.dueFollowups}
                </Badge>
                {status.handoffSummary && <span className="truncate">{status.handoffSummary}</span>}
              </div>
            )}

            {data.loading && !bundle ? (
              <LoadState {...data} />
            ) : (
              <Tabs defaultValue="tasks" className="w-full">
                <TabsList variant="line">
                  <TabsTrigger value="tasks">
                    {t("lsa.activeTasks")} ({tasks.length})
                  </TabsTrigger>
                  <TabsTrigger value="followups">
                    {t("lsa.followups")} ({followups.length})
                  </TabsTrigger>
                  <TabsTrigger value="memories">
                    {t("lsa.memories")} ({memories.length})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="tasks" className="flex flex-col gap-3 pt-3">
                  {tasks.length === 0 ? (
                    <EmptyState title={t("lsa.emptyTasks")} />
                  ) : (
                    tasks.map((task) => {
                      const canSteer = !["completed", "cancelled"].includes(task.status);
                      const needsDecision = task.status === "waiting_decision" || task.status === "failed";
                      return (
                        <article
                          key={task.id}
                          className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <strong className="text-sm font-medium">
                                  {task.title || task.goal}
                                </strong>
                                <Badge variant={lsaStatusBadgeVariant(task.status)}>
                                  {task.status === "waiting_decision" ? t("lsa.waitingDecision") : task.status}
                                </Badge>
                                {task.worktree && <Badge variant="secondary">Worktree</Badge>}
                              </div>
                              <span className="font-mono text-xs text-muted-foreground">
                                {task.cwd} · {formatStamp(task.updatedAt)}
                              </span>
                            </div>
                            {task.sessionId && (
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                onClick={() => navigate(task.sessionId!)}
                              >
                                <ExternalLink data-icon="inline-start" />
                                {t("nav.sessions")}
                              </Button>
                            )}
                          </div>

                          {task.title && task.goal !== task.title && (
                            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{task.goal}</p>
                          )}
                          {task.summary && (
                            <p className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-foreground whitespace-pre-wrap">
                              {task.summary}
                            </p>
                          )}
                          {task.acceptanceChecks.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {task.acceptanceChecks.map((check) => (
                                <code key={check} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                                  {check}
                                </code>
                              ))}
                            </div>
                          )}

                          {canSteer && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <Input
                                className="min-w-[200px] flex-1"
                                value={steerDrafts[task.id] ?? ""}
                                onChange={(event) =>
                                  setSteerDrafts((prev) => ({ ...prev, [task.id]: event.target.value }))
                                }
                                placeholder={t("lsa.steerPlaceholder")}
                                disabled={job.busy}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    steerTask(task);
                                  }
                                }}
                              />
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={!(steerDrafts[task.id] ?? "").trim() || job.busy}
                                onClick={() => steerTask(task)}
                              >
                                <Send data-icon="inline-start" />
                                {t("composer.send")}
                              </Button>
                              {needsDecision && (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={job.busy}
                                    onClick={() => decideTask(task, "accept")}
                                  >
                                    <Check data-icon="inline-start" />
                                    {t("lsa.accept")}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    disabled={job.busy}
                                    onClick={() => decideTask(task, "retry")}
                                  >
                                    <RotateCcw data-icon="inline-start" />
                                    {t("lsa.retry")}
                                  </Button>
                                </>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={job.busy}
                                onClick={() => decideTask(task, "cancel")}
                              >
                                <X data-icon="inline-start" />
                                {t("lsa.cancel")}
                              </Button>
                            </div>
                          )}
                        </article>
                      );
                    })
                  )}
                </TabsContent>

                <TabsContent value="followups" className="flex flex-col gap-3 pt-3">
                  <div className="flex items-center gap-2">
                    <Input
                      className="flex-1"
                      value={followupNote}
                      onChange={(event) => setFollowupNote(event.target.value)}
                      placeholder={`${t("lsa.followups")}…`}
                      disabled={job.busy}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!followupNote.trim() || job.busy}
                      onClick={addFollowup}
                    >
                      <Clock data-icon="inline-start" />
                      {t("common.save")}
                    </Button>
                  </div>
                  {followups.length === 0 ? (
                    <EmptyState title={t("lsa.followups")} />
                  ) : (
                    followups.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-xs"
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium text-foreground">{item.note}</span>
                          <span className="text-muted-foreground">{formatStamp(item.dueAt)}</span>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={job.busy}
                          onClick={() => completeFollowup(item.id)}
                        >
                          <Check data-icon="inline-start" />
                          {t("common.confirm")}
                        </Button>
                      </div>
                    ))
                  )}
                </TabsContent>

                <TabsContent value="memories" className="flex flex-col gap-3 pt-3">
                  <Input
                    value={memoryQuery}
                    onChange={(event) => setMemoryQuery(event.target.value)}
                    placeholder={`${t("common.search")}…`}
                  />
                  {memories.length === 0 ? (
                    <EmptyState title={t("lsa.memories")} />
                  ) : (
                    memories.map((memory) => (
                      <div
                        key={memory.id ?? `${memory.scope ?? "global"}:${memory.key}`}
                        className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="font-mono text-foreground">{memory.key}</strong>
                          <span className="text-muted-foreground">{formatStamp(memory.updatedAt)}</span>
                        </div>
                        <p className="text-muted-foreground whitespace-pre-wrap">{memory.content}</p>
                        {memory.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-1">
                            {memory.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-[10px]">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </TabsContent>
              </Tabs>
            )}
          </>
        )}
      </div>
    </div>
  );
}
